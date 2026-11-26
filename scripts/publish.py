#!/usr/bin/env python3
"""Publish the current files of this repo to GitHub as ONE new commit, without uploading the local history.

    python scripts/publish.py "what changed"          # check, then publish
    python scripts/publish.py --dry-run               # only check and show what would change

Why: your local repo can keep every commit (including ones with private material you removed later). GitHub gets a
separate, clean history: each publish adds one commit whose files are exactly your current `main` (committed files
only - uncommitted changes are not published).

Before anything is pushed the script refuses if a committed file
  - is a local-only file (local.json, CLAUDE.local.md, .env, media files, ...), or
  - contains a word from publish-blocklist.txt (gitignored, one regular expression per line, # comments; put your
    show's names, your email, your machine paths in it), or
  - looks like a secret (API keys, tokens, private keys).

One-time setup (the script tells you if something is missing):
    git remote add github https://github.com/<you>/<repo>.git
    git config publish.email <id>+<user>@users.noreply.github.com    # GitHub > Settings > Emails (keeps your email private)
Options: --remote (default github), --branch (local branch for the published history, default public),
         --source (what to publish, default main).
"""
import argparse, os, re, subprocess, sys

LOCAL_ONLY = re.compile(r"(^|/)(local\.json|CLAUDE\.local\.md|\.env(\..*)?|.*\.(wav|mov|mp4|mxf|prproj|aep))$", re.I)
SECRET = re.compile(r"(gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"
                    r"xox[abp]-[A-Za-z0-9-]{10,}|(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][A-Za-z0-9_\-/+]{16,}['\"])", re.I)


def git(*a, check=True, text=True):
    p = subprocess.run(["git", *a], capture_output=True, text=text, encoding="utf-8" if text else None, errors="replace" if text else None)
    if check and p.returncode:
        sys.exit(f"git {' '.join(a)} failed:\n{p.stderr.strip()}")
    return p.stdout.strip() if text else p.stdout


def blocklist(root):
    p = os.path.join(root, "publish-blocklist.txt")
    if not os.path.exists(p):
        return []
    out = []
    for n, line in enumerate(open(p, encoding="utf-8"), 1):
        line = line.strip()
        if line and not line.startswith("#"):
            try:
                out.append(re.compile(line))
            except re.error as e:
                sys.exit(f"publish-blocklist.txt line {n}: not a valid regular expression ({e}): {line}")
    return out


def check(source, root):
    problems = []
    bl = blocklist(root)
    if not bl:
        print("note: no publish-blocklist.txt - only local-only files and secrets are checked")
    files = git("ls-tree", "-r", "--name-only", source).splitlines()
    if "publish-blocklist.txt" in files:
        problems.append("publish-blocklist.txt is committed: remove it from git (it lists what must stay private)")
    for f in files:
        if LOCAL_ONLY.search(f):
            problems.append(f"{f}: local-only file")
            continue
        data = git("show", f"{source}:{f}", text=False)
        if b"\0" in data[:8000]:
            texts = [data.decode("latin-1")]          # binary: still scan for plain strings
        else:
            texts = [data.decode("utf-8", "replace")]
        for t in texts:
            m = SECRET.search(t)
            if m:
                problems.append(f"{f}: looks like a secret: {m.group(0)[:12]}...")
            for rx in bl:
                m = rx.search(t)
                if m:
                    ln = t.count("\n", 0, m.start()) + 1
                    problems.append(f"{f}:{ln}: matches blocklist /{rx.pattern}/: ...{t[max(0, m.start() - 30):m.end() + 30]!r}...")
    return files, problems


def main():
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("message", nargs="?", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--remote", default="github")
    ap.add_argument("--branch", default="public")
    ap.add_argument("--source", default="main")
    a = ap.parse_args()
    root = git("rev-parse", "--show-toplevel")
    os.chdir(root)
    if git("status", "--porcelain", "--untracked-files=no"):
        print("note: you have uncommitted changes; only what is committed on", a.source, "is published")
    files, problems = check(a.source, root)
    if problems:
        print("NOT published - fix these first:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print(f"check ok: {len(files)} files, nothing private found")

    if a.remote not in git("remote").split():
        sys.exit(f"no remote '{a.remote}': git remote add {a.remote} https://github.com/<you>/<repo>.git")
    email = git("config", "publish.email", check=False)
    if not email:
        sys.exit("set the email for published commits once: git config publish.email <id>+<user>@users.noreply.github.com")
    name = git("config", "publish.name", check=False) or git("config", "user.name", check=False) or "publisher"

    git("fetch", "-q", a.remote, check=False)
    remote_head = git("rev-parse", "-q", "--verify", f"{a.remote}/main", check=False)
    local = git("rev-parse", "-q", "--verify", f"refs/heads/{a.branch}", check=False)
    if not local and remote_head:
        git("branch", a.branch, f"{a.remote}/main"); local = remote_head
    if local and remote_head and local != remote_head \
            and subprocess.run(["git", "merge-base", "--is-ancestor", remote_head, local]).returncode != 0:
        sys.exit(f"GitHub has commits that your '{a.branch}' branch doesn't (someone else pushed?). Look at them first: git log {a.remote}/main")

    tree = git("rev-parse", f"{a.source}^{{tree}}")
    if local and git("rev-parse", f"{local}^{{tree}}") == tree:
        print("nothing to publish: GitHub already has exactly these files")
        return
    if local:
        print(git("diff", "--stat", local, a.source) or "(changes)")
    if a.dry_run:
        print("dry run: nothing pushed")
        return
    msg = a.message or input("describe the change in one line: ").strip() or "Update"
    env = dict(os.environ, GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email, GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email)
    cmd = ["git", "commit-tree", tree, "-m", msg] + (["-p", local] if local else [])
    sha = subprocess.run(cmd, capture_output=True, text=True, env=env, check=True).stdout.strip()
    git("branch", "-f", a.branch, sha)
    p = subprocess.run(["git", "push", a.remote, f"{a.branch}:main"])
    if p.returncode:
        sys.exit("push failed (see above); the local branch is ready, rerun to try again")
    print(f"published {sha[:7]} to {a.remote}/main")


if __name__ == "__main__":
    main()
