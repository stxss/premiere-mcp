// Background jobs for long-running local work (transcription, renders), so MCP calls return quickly.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const jobs = new Map();

export function startJob({ kind, cmd, args, cwd, totalSeconds, parseProgress, onDone, meta }) {
  const id = `${kind}-${randomUUID().slice(0, 8)}`;
  const job = {
    id, kind, status: "running", progress: 0, startedAt: new Date().toISOString(),
    finishedAt: null, result: null, error: null, meta: meta || {}, stderrTail: [],
  };
  jobs.set(id, job);
  let child;
  try {
    child = spawn(cmd, args, { cwd, windowsHide: true });
  } catch (e) {
    job.status = "failed"; job.error = e.message; return job;
  }
  job.pid = child.pid;
  const onData = (buf) => {
    const text = buf.toString();
    for (const line of text.split(/\r|\n/)) {
      if (!line.trim()) continue;
      job.stderrTail.push(line);
      if (job.stderrTail.length > 40) job.stderrTail.shift();
      const p = parseProgress ? parseProgress(line, totalSeconds) : null;
      if (p !== null && p !== undefined && !Number.isNaN(p)) job.progress = Math.max(job.progress, Math.min(0.999, p));
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => { job.status = "failed"; job.error = e.message; job.finishedAt = new Date().toISOString(); });
  child.on("close", async (code) => {
    if (job.status === "cancelled") return;
    if (code === 0) {
      try {
        job.result = onDone ? await onDone() : null;
        job.status = "done"; job.progress = 1;
      } catch (e) { job.status = "failed"; job.error = e.message; }
    } else if (job.status !== "failed") {
      job.status = "failed";
      job.error = `exit code ${code}: ${job.stderrTail.slice(-6).join(" | ")}`;
    }
    job.finishedAt = new Date().toISOString();
  });
  job.cancel = () => { job.status = "cancelled"; try { child.kill(); } catch { /* ignore */ } };
  return job;
}

export function ffmpegProgress(line, total) {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m || !total) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / total;
}

export function getJob(id) { return jobs.get(id); }
export function listJobs() { return [...jobs.values()]; }

export function publicJob(j) {
  if (!j) return null;
  const { cancel, stderrTail, ...rest } = j;
  return { ...rest, progress: Math.round(j.progress * 1000) / 10 + "%", log: j.status === "failed" ? stderrTail.slice(-10) : undefined };
}
