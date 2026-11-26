// HyperFrames (HeyGen, open source): HTML compositions -> video, rendered locally.
// These tools scaffold, edit, check and render a project, and can drop the render into Premiere.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { config, ROOT_DIR } from "./config.js";
import { startJob } from "./jobs.js";
import { script } from "./ppro-prelude.js";

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message || e}` }] });

// Run the CLI through Node directly (no shell), so paths and JSON args are safe on Windows too.
export function hyperframesCommand() {
  if (process.env.HYPERFRAMES_BIN) return { cmd: process.execPath, pre: [process.env.HYPERFRAMES_BIN] };
  const local = path.join(ROOT_DIR, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
  if (fs.existsSync(local)) return { cmd: process.execPath, pre: [local] };
  return null;
}

function nodeMajor() { return Number(process.versions.node.split(".")[0]); }

function requireCli() {
  if (nodeMajor() < 22) throw new Error(`HyperFrames needs Node 22+, this server runs Node ${process.versions.node}. Install a newer Node and restart Claude.`);
  const c = hyperframesCommand();
  if (!c) throw new Error("HyperFrames is not installed for this server. In the server folder run: npm install");
  return c;
}

function runCli(args, { cwd, timeoutMs = 170000 } = {}) {
  const { cmd, pre } = requireCli();
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    const child = spawn(cmd, [...pre, ...args], { cwd, windowsHide: true, env: { ...process.env, CI: "1", FFMPEG_PATH: config.ffmpeg } });
    const t = setTimeout(() => { child.kill(); reject(new Error("hyperframes timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

function projectDir(p) {
  const dir = path.resolve(p);
  if (!fs.existsSync(path.join(dir, "index.html"))) throw new Error(`Not a HyperFrames project (no index.html): ${dir}`);
  return dir;
}

function insideProject(dir, rel) {
  const full = path.resolve(dir, rel);
  const r = path.relative(dir, full);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new Error("Path must stay inside the project folder");
  return full;
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function registerHyperframesTools(server, bridge) {
  const tool = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try { return ok(await handler(args || {})); } catch (e) { return fail(e); }
    });
  };

  tool("hyperframes_init",
    "Create a new HyperFrames project (HTML + GSAP composition rendered to video): titles, lower thirds, animated captions, intros, explainer graphics. Then edit it with hyperframes_write_file and render with hyperframes_render.",
    {
      name: z.string().describe("Project folder name"),
      parent_dir: z.string().optional().describe("Where to create it. Default ~/PremiereMCP/hyperframes"),
      resolution: z.enum(["landscape", "portrait", "square", "landscape-4k", "portrait-4k"]).optional(),
      example: z.string().optional().describe("Starter example, e.g. blank, warm-grain, swiss-grid. Default blank"),
      video: z.string().optional().describe("Optional source video to build around (gets transcribed by HyperFrames)"),
    },
    async ({ name, parent_dir, resolution = "landscape", example, video }) => {
      const parent = path.resolve(parent_dir || path.join(config.workDir, "hyperframes"));
      fs.mkdirSync(parent, { recursive: true });
      const args = ["init", name, "--non-interactive", "--resolution", resolution];
      if (example) args.push("--example", example);
      if (video) args.push("--video", path.resolve(video));
      else args.push("--skip-transcribe");
      const r = await runCli(args, { cwd: parent });
      if (r.code !== 0) throw new Error(strip(r.err || r.out).slice(-1500));
      const dir = path.join(parent, name);
      return {
        project: dir,
        files: fs.readdirSync(dir),
        index_html: fs.readFileSync(path.join(dir, "index.html"), "utf8"),
        authoring_notes: fs.existsSync(path.join(dir, "CLAUDE.md")) ? fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").slice(0, 6000) : null,
      };
    });

  tool("hyperframes_read_file",
    "Read a file from a HyperFrames project (index.html, compositions/*.html, CLAUDE.md for authoring rules).",
    { project: z.string(), file: z.string().optional().describe("Relative path. Default index.html") },
    async ({ project, file = "index.html" }) => fs.readFileSync(insideProject(projectDir(project), file), "utf8"));

  tool("hyperframes_write_file",
    "Write a file inside a HyperFrames project (usually index.html). Compositions are HTML with a root element carrying data-composition-id/data-duration/data-width/data-height, clips with class 'clip' and data-start/data-duration/data-track-index, and a paused GSAP timeline registered at window.__timelines['<composition id>']. For overlays to use over footage in Premiere, keep the page background transparent and render as MOV.",
    { project: z.string(), file: z.string().optional(), content: z.string() },
    async ({ project, file = "index.html", content }) => {
      const full = insideProject(projectDir(project), file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
      return { written: full, bytes: Buffer.byteLength(content) };
    });

  tool("hyperframes_check",
    "Validate a HyperFrames composition in headless Chrome: lint, JS errors, missing assets, layout overflow, contrast. Run before rendering.",
    { project: z.string(), at: z.array(z.number()).optional().describe("Extra timestamps to sample") },
    async ({ project, at }) => {
      const dir = projectDir(project);
      const args = ["check", dir, "--json"];
      if (at && at.length) args.push("--at", at.join(","));
      const r = await runCli(args, { cwd: dir });
      const text = strip(r.out).trim();
      try { return { passed: r.code === 0, report: JSON.parse(text.slice(text.indexOf("{"))) }; }
      catch { return { passed: r.code === 0, output: (text + "\n" + strip(r.err)).slice(-6000) }; }
    });

  tool("hyperframes_render",
    "Render a HyperFrames project to video locally (headless Chrome + ffmpeg), optionally import it into Premiere and place it on the timeline. Use format 'mov' (ProRes 4444 with alpha) for graphics that go over footage, 'mp4' for full-frame pieces. Runs in the background; returns job_id if it takes over ~45s.",
    {
      project: z.string(),
      output_path: z.string().optional().describe("Default <project>/renders/<name>.<ext>"),
      format: z.enum(["mp4", "mov", "webm", "gif"]).optional().describe("Default mp4"),
      quality: z.enum(["draft", "looks", "delivery"]).optional().describe("Default looks"),
      fps: z.string().optional().describe("Frame rate matching your sequence: 24, 25, 30, 60, or 30000/1001 for 29.97"),
      composition: z.string().optional().describe("Render a specific composition file instead of index.html"),
      variables: z.record(z.string(), z.any()).optional().describe("Values for data-composition-variables, e.g. {\"name\":\"Alex Doe\",\"role\":\"Editor\"} for a lower-third template"),
      start: z.number().optional(),
      end: z.number().optional(),
      import_to_premiere: z.boolean().optional().describe("Import the render into the open Premiere project. Default false"),
      bin: z.string().optional().describe("Premiere bin. Default 'HyperFrames'"),
      place_at: z.number().optional().describe("Also overwrite it onto the sequence at this time (seconds)"),
      video_track: z.number().int().optional().describe("0-based video track for place_at. Default 1 (V2, above footage)"),
      audio_track: z.number().int().optional().describe("0-based audio track for place_at. Default 1 (A2)"),
      sequence: z.string().optional().describe("Sequence for place_at. Default active"),
    },
    async (a) => {
      const { cmd, pre } = requireCli();
      const dir = projectDir(a.project);
      const format = a.format || "mp4";
      const ext = format === "gif" ? "gif" : format;
      const out = path.resolve(a.output_path || path.join(dir, "renders", `${path.basename(dir)}_${Date.now().toString(36)}.${ext}`));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const args = [...pre, "render", dir, "-o", out, "--format", format, "-q", a.quality || "looks", "--quiet"];
      if (format === "mov") args.push("--prores-profile", "4444");
      if (a.fps) args.push("--fps", String(a.fps));
      if (a.composition) args.push("--composition", a.composition);
      if (a.start !== undefined) args.push("--start", String(a.start));
      if (a.end !== undefined) args.push("--end", String(a.end));
      if (a.variables) {
        const vf = path.join(dir, ".hyperframes-mcp-vars.json");
        fs.writeFileSync(vf, JSON.stringify(a.variables));
        args.push("--variables-file", vf);
      }
      const wantPremiere = a.import_to_premiere || a.place_at !== undefined;
      if (wantPremiere && !bridge.isConnected()) throw new Error("Premiere is not connected (needed for import_to_premiere/place_at). Open the MCP Bridge panel or render without importing.");

      const job = startJob({
        kind: "hyperframes",
        cmd,
        args: args.slice(0),
        cwd: dir,
        meta: { project: dir, output: out },
        parseProgress: (line) => {
          const m = line.match(/(\d{1,3})%/);
          return m ? Number(m[1]) / 100 : null;
        },
        onDone: async () => {
          if (!fs.existsSync(out)) throw new Error("Render finished but no output file at " + out);
          const res = { output: out, format, sizeMB: Math.round(fs.statSync(out).size / 104857.6) / 10 };
          if (wantPremiere) {
            const { result } = await bridge.run(script({ out, bin: a.bin || "HyperFrames", place_at: a.place_at, v: a.video_track ?? 1, aud: a.audio_track ?? 1, sequence: a.sequence }, `
              const p = await getProject();
              const target = await findBin(p, args.bin, true);
              await p.importFiles([args.out], true, target, false);
              const it = await findItem(p, args.out, ["clip"]);
              const o = { imported: it.path };
              if (args.place_at !== undefined && args.place_at !== null) {
                const s = await getSeq(p, args.sequence);
                const vc = await s.getVideoTrackCount();
                if (args.v >= vc) throw new Error("Sequence has only " + vc + " video tracks; add a track or use a lower video_track");
                const ed = ppro.SequenceEditor.getEditor(s);
                tx(p, "Place HyperFrames render", () => ed.createOverwriteItemAction(it.item, T(args.place_at), args.v, args.aud));
                o.placed = { sequence: s.name, at: args.place_at, videoTrack: "V" + (args.v + 1) };
              }
              return o;
            `), { label: "hyperframes_import" });
            res.premiere = result;
          }
          return res;
        },
      });
      const deadline = Date.now() + 45000;
      while (job.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 400));
      if (job.status === "done") return { status: "done", job_id: job.id, ...job.result };
      if (job.status === "failed") throw new Error(strip(job.error || "render failed"));
      return { status: "running", job_id: job.id, hint: "Call job_status with this job_id (wait_seconds up to 55)." };
    });

  tool("hyperframes_snapshot",
    "Capture PNG frames of a HyperFrames composition at given times to check the look before a full render. Returns the image paths.",
    { project: z.string(), at: z.array(z.number()).min(1).max(12) },
    async ({ project, at }) => {
      const dir = projectDir(project);
      const outDir = path.join(dir, "snapshots");
      const r = await runCli(["snapshot", dir, "--at", at.join(","), "--no-end", "--output", outDir], { cwd: dir });
      const text = strip(r.out + "\n" + r.err);
      if (r.code !== 0) throw new Error(text.slice(-1500));
      const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith(".png")).map((f) => path.join(outDir, f)) : [];
      return { files };
    });
}
