// Local, free media tools: ffmpeg analysis/rendering, Whisper transcription, captions, shorts.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { config, ROOT_DIR } from "./config.js";
import { script } from "./ppro-prelude.js";
import { startJob, getJob, listJobs, publicJob, ffmpegProgress } from "./jobs.js";
import {
  listTemplates, loadTemplate, saveTemplate, chunkWords, writeCaptions,
  wordsFromTranscript, wordsFromSubtitles, mergeTemplate, DEFAULT_TEMPLATE,
} from "./captions.js";

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message || e}` }] });
const r3 = (n) => Math.round(n * 1000) / 1000;

function mustExist(p, what = "File") {
  if (!p || !fs.existsSync(p)) throw new Error(`${what} not found: ${p}`);
  return path.resolve(p);
}

function runCapture(cmd, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not run '${cmd}': ${e.message}`)); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

export async function probe(file) {
  const { code, out, err } = await runCapture(config.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60000 });
  if (code !== 0) throw new Error("ffprobe failed: " + err.slice(-500));
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  const fps = v && v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? (() => { const [n, d] = v.avg_frame_rate.split("/").map(Number); return d ? r3(n / d) : null; })() : null;
  let rotation = 0;
  if (v) {
    const sd = (v.side_data_list || []).find((x) => x.rotation !== undefined);
    rotation = Number((v.tags && v.tags.rotate) || (sd && sd.rotation) || 0);
  }
  return {
    path: file,
    duration: r3(Number(j.format.duration || 0)),
    sizeMB: Math.round(Number(j.format.size || 0) / 1048576 * 10) / 10,
    format: j.format.format_name,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps, fpsRational: v.r_frame_rate || v.avg_frame_rate, rotation, pixFmt: v.pix_fmt } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
  };
}

// Run a job and wait up to waitSeconds for it; return result if done, otherwise the job handle.
async function startAndWait(jobSpec, waitSeconds = 40) {
  const job = startJob(jobSpec);
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline && job.status === "running") await new Promise((r) => setTimeout(r, 400));
  if (job.status === "done") return { status: "done", job_id: job.id, ...job.result };
  if (job.status === "failed") throw new Error(job.error);
  return { status: "running", job_id: job.id, progress: publicJob(job).progress, hint: "Still working. Call job_status with this job_id (it can wait up to 55s per call)." };
}

// ---------- silence ----------
export function parseSilences(stderr) {
  const sil = [];
  let cur = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) cur = { start: Math.max(0, Number(s[1])) };
    if (e && cur) { cur.end = Number(e[1]); sil.push(cur); cur = null; }
  }
  if (cur) cur.end = null; // silence runs to end of file
  if (cur) sil.push(cur);
  return sil;
}

export function keepSegments(silences, duration, { padding = 0.12, minKeep = 0.3 } = {}) {
  const keeps = [];
  let t = 0;
  for (const s of silences) {
    const end = s.end === null ? duration : s.end;
    if (s.start > t) keeps.push([t, s.start]);
    t = end;
  }
  if (t < duration) keeps.push([t, duration]);
  const padded = keeps.map(([a, b]) => [Math.max(0, a - padding), Math.min(duration, b + padding)]);
  const merged = [];
  for (const k of padded) {
    const last = merged[merged.length - 1];
    if (last && k[0] <= last[1]) last[1] = Math.max(last[1], k[1]);
    else merged.push([...k]);
  }
  return merged.filter(([a, b]) => b - a >= minKeep).map(([a, b]) => [r3(a), r3(b)]);
}

// ---------- transcripts ----------
export function transcriptPathFor(media, model, language) {
  const st = fs.statSync(media);
  const key = crypto.createHash("sha1").update(`${path.resolve(media)}|${st.size}|${st.mtimeMs}|${model}|${language || "auto"}`).digest("hex").slice(0, 10);
  const base = path.basename(media).replace(/[^\w.-]+/g, "_");
  // Model ids can be HF repo ids ("nyrahealth/faster_CrisperWhisper"); a "/" would make a subfolder.
  const safeModel = String(model).replace(/[^\w.-]+/g, "_");
  const out = path.join(config.transcriptsDir, `${base}.${safeModel}.${key}.json`);
  // Older builds wrote <base>.<org>/<name>.<key>.json into hand-made folders: keep using those caches.
  const legacy = path.join(config.transcriptsDir, `${base}.${model}.${key}.json`);
  if (legacy !== out && !fs.existsSync(out) && fs.existsSync(legacy)) return legacy;
  return out;
}

function findTranscriptFor(media) {
  const abs = path.resolve(media);
  if (!fs.existsSync(config.transcriptsDir)) return null;
  // Top level plus one level of subfolders (legacy caches from model ids containing "/").
  const candidates = [];
  for (const e of fs.readdirSync(config.transcriptsDir, { withFileTypes: true })) {
    const p = path.join(config.transcriptsDir, e.name);
    if (e.isFile() && e.name.endsWith(".json")) candidates.push(p);
    else if (e.isDirectory()) {
      for (const f of fs.readdirSync(p)) if (f.endsWith(".json")) candidates.push(path.join(p, f));
    }
  }
  let best = null;
  for (const f of candidates) {
    try {
      const head = fs.readFileSync(f, "utf8").slice(0, 2000);
      const m = head.match(/"source":\s*"((?:[^"\\]|\\.)*)"/);
      if (m && path.resolve(JSON.parse(`"${m[1]}"`)) === abs) {
        const mt = fs.statSync(f).mtimeMs;
        if (!best || mt > best.mt) best = { f, mt };
      }
    } catch { /* ignore */ }
  }
  return best ? best.f : null;
}

// Accept a transcript JSON path, or a media path that has been transcribed.
export function loadTranscript(ref) {
  if (!ref) throw new Error("transcript is required (transcript JSON path, or the media path you transcribed)");
  let file = ref;
  if (!ref.toLowerCase().endsWith(".json")) {
    file = findTranscriptFor(ref);
    if (!file) throw new Error(`No transcript found for ${ref}. Run transcribe_media first.`);
  }
  mustExist(file, "Transcript");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, data };
}

const fmtTs = (s) => {
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
};

// ---------- registration ----------
export function registerMediaTools(server, bridge) {
  const tool = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try { return ok(await handler(args || {})); } catch (e) { return fail(e); }
    });
  };

  tool("setup_check",
    "Check everything this MCP needs: Premiere panel connection, ffmpeg/ffprobe, Python + faster-whisper, and the working folders. Run this first if something fails.",
    {},
    async () => {
      const check = (cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
        if (r.error) return { ok: false, error: r.error.message };
        return { ok: r.status === 0, output: (r.stdout || r.stderr || "").split("\n")[0].trim() };
      };
      const ff = check(config.ffmpeg, ["-version"]);
      const fp = check(config.ffprobe, ["-version"]);
      const py = check(config.python, ["--version"]);
      const fw = check(config.python, ["-c", "import faster_whisper; print(faster_whisper.__version__)"]);
      let libass = null;
      if (ff.ok) {
        const f = spawnSync(config.ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8" });
        libass = /\bass\b/.test(f.stdout || "");
      }
      return {
        premiere: bridge.status(),
        ffmpeg: ff, ffprobe: fp, ffmpegHasLibass: libass,
        python: py, fasterWhisper: fw,
        workDir: config.workDir,
        fixes: [
          !ff.ok && "Install ffmpeg (Windows: winget install Gyan.FFmpeg | macOS: brew install ffmpeg) or set FFMPEG_PATH/FFPROBE_PATH.",
          ff.ok && libass === false && "Your ffmpeg lacks libass, so burned-in captions won't work. Use a full build (Gyan.FFmpeg / brew ffmpeg).",
          !py.ok && "Install Python 3.9+ or set PREMIERE_MCP_PYTHON to its path.",
          py.ok && !fw.ok && `Run: ${config.python} -m pip install faster-whisper`,
          !bridge.status().connected && "Open Premiere Pro and the MCP Bridge panel (Window > UXP Plugins > MCP Bridge).",
        ].filter(Boolean),
      };
    });

  tool("media_probe",
    "Read duration, resolution, fps, rotation and audio info of a media file (ffprobe).",
    { path: z.string() },
    async ({ path: p }) => probe(mustExist(p)));

  tool("media_detect_silence",
    "Find silences/dead air in a media file with ffmpeg and compute the KEEP segments for a tightened cut. Writes a segments JSON you can pass to ppro_rough_cut (segments_file). Tune noise_db for your mic: -30 is aggressive, -40 is gentle.",
    {
      path: z.string(),
      noise_db: z.number().optional().describe("Silence threshold in dB. Default -35"),
      min_silence: z.number().optional().describe("Minimum silence length to cut, seconds. Default 0.5"),
      padding: z.number().optional().describe("Seconds kept around speech. Default 0.12"),
      min_keep: z.number().optional().describe("Drop kept bits shorter than this. Default 0.3"),
      audio_stream: z.number().int().optional().describe("Audio stream index if the file has several. Default 0"),
    },
    async ({ path: p, noise_db = -35, min_silence = 0.5, padding = 0.12, min_keep = 0.3, audio_stream = 0 }) => {
      const file = mustExist(p);
      const info = await probe(file);
      if (!info.audio) throw new Error("No audio stream in " + file);
      let stderr = "";
      const out = path.join(config.outputsDir, `${path.basename(file).replace(/[^\w.-]+/g, "_")}.silence.json`);
      return startAndWait({
        kind: "silence",
        cmd: config.ffmpeg,
        args: ["-hide_banner", "-i", file, "-map", `0:a:${audio_stream}`, "-af", `silencedetect=noise=${noise_db}dB:d=${min_silence}`, "-f", "null", "-"],
        totalSeconds: info.duration,
        parseProgress: (line, total) => { stderr += line + "\n"; return ffmpegProgress(line, total); },
        onDone: async () => {
          const sil = parseSilences(stderr);
          const keep = keepSegments(sil, info.duration, { padding, minKeep: min_keep });
          const kept = keep.reduce((a, [s, e]) => a + (e - s), 0);
          fs.writeFileSync(out, JSON.stringify({ source: file, duration: info.duration, settings: { noise_db, min_silence, padding, min_keep }, silences: sil, keep }, null, 1));
          return {
            segments_file: out,
            duration: info.duration,
            silences: sil.length,
            keepSegments: keep.length,
            keptSeconds: r3(kept),
            removedSeconds: r3(info.duration - kept),
            removedPercent: Math.round((1 - kept / info.duration) * 1000) / 10,
            preview: keep.slice(0, 15),
          };
        },
      });
    });

  tool("transcribe_media",
    "Transcribe a video/audio file locally with Whisper (faster-whisper, free, no cloud) with word-level timestamps. Runs in the background; returns a job_id if not finished within ~40s. Results are cached per file+model. Models: tiny, base, small (default), medium, large-v3, distil-large-v3, turbo.",
    {
      path: z.string(),
      model: z.string().optional(),
      language: z.string().optional().describe("ISO code like 'en' or 'pt'. Auto-detected if omitted."),
      device: z.enum(["auto", "cpu", "cuda"]).optional(),
      initial_prompt: z.string().optional().describe("Names/jargon to help spelling, e.g. 'Premiere Pro, product names'"),
      force: z.boolean().optional().describe("Re-transcribe even if cached"),
    },
    async ({ path: p, model = "small", language, device = "auto", initial_prompt, force = false }) => {
      const file = mustExist(p);
      const out = transcriptPathFor(file, model, language);
      if (!force && fs.existsSync(out)) {
        const d = JSON.parse(fs.readFileSync(out, "utf8"));
        return { status: "done", cached: true, transcript: out, language: d.language, duration: d.duration, segments: d.segments.length };
      }
      const args = [path.join(ROOT_DIR, "src", "transcribe.py"), "--input", file, "--output", out, "--model", model, "--device", device, "--ffmpeg", config.ffmpeg];
      if (language) args.push("--language", language);
      if (initial_prompt) args.push("--initial-prompt", initial_prompt);
      return startAndWait({
        kind: "transcribe",
        cmd: config.python,
        args,
        parseProgress: (line) => {
          const m = line.match(/^PROGRESS ([\d.]+) ([\d.]+)/);
          return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
        },
        meta: { source: file, model },
        onDone: async () => {
          const d = JSON.parse(fs.readFileSync(out, "utf8"));
          return { transcript: out, language: d.language, duration: d.duration, segments: d.segments.length, elapsedSeconds: d.elapsed_seconds };
        },
      });
    });

  // ---------- AI matte (green screen / talking head) ----------
  const RVM_URLS = {
    resnet50: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50.pth",
    mobilenetv3: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth",
  };

  tool("matte_setup",
    "Install what media_matte needs into the configured Python: PyTorch + torchvision with CUDA (cu128 wheels, needed for RTX 50xx; works on older NVIDIA GPUs too), Pillow, and the Robust Video Matting weights. Downloads ~3 GB once. Runs in the background; poll job_status. Use check_only to just report what is installed.",
    {
      check_only: z.boolean().optional(),
      cuda: z.enum(["cu128", "cu126", "cpu"]).optional().describe("Wheel flavour. Default cu128 (macOS always uses the default PyPI build)"),
    },
    async ({ check_only = false, cuda = "cu128" }) => {
      const probeCode = "import json\nr={}\ntry:\n import torch;r['torch']=torch.__version__;r['cuda']=torch.cuda.is_available();r['gpu']=torch.cuda.get_device_name(0) if r['cuda'] else None\nexcept Exception as e: r['torch']=None;r['error']=str(e)\ntry:\n import torchvision;r['torchvision']=torchvision.__version__\nexcept Exception: r['torchvision']=None\ntry:\n import PIL;r['pillow']=PIL.__version__\nexcept Exception: r['pillow']=None\nprint(json.dumps(r))";
      const state = () => {
        const r = spawnSync(config.python, ["-c", probeCode], { encoding: "utf8", windowsHide: true });
        let j = {};
        try { j = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { j = { error: (r.stderr || "").slice(-400) }; }
        j.weights = Object.fromEntries(Object.entries(RVM_URLS).map(([k, u]) => [k, fs.existsSync(path.join(config.modelsDir, path.basename(u)))]));
        return j;
      };
      const before = state();
      if (check_only) return before;
      const idx = process.platform === "darwin" || cuda === "cpu" ? [] : ["--index-url", `https://download.pytorch.org/whl/${cuda}`];
      const py = [
        "import subprocess, sys",
        `idx=${JSON.stringify(idx)}`,
        "print('PROGRESS 1 4', file=sys.stderr, flush=True)",
        "subprocess.check_call([sys.executable,'-m','pip','install','--upgrade','torch','torchvision']+idx)",
        "print('PROGRESS 3 4', file=sys.stderr, flush=True)",
        "subprocess.check_call([sys.executable,'-m','pip','install','--upgrade','pillow','numpy'])",
        "import torch",
        `for u in ${JSON.stringify(Object.values(RVM_URLS))}: torch.hub.load_state_dict_from_url(u, model_dir=${JSON.stringify(config.modelsDir)}, map_location='cpu', progress=False, weights_only=True)`,
        "print('PROGRESS 4 4', file=sys.stderr, flush=True)",
      ].join("\n");
      return startAndWait({
        kind: "matte_setup", cmd: config.python, args: ["-c", py],
        parseProgress: (line) => { const m = line.match(/^PROGRESS ([\d.]+) ([\d.]+)/); return m ? Number(m[1]) / Number(m[2]) : null; },
        onDone: async () => ({ before, after: state() }),
      }, 20);
    });

  tool("media_matte",
    "Cut the subject out of static-camera footage on the GPU and write a ProRes 4444 .mov with alpha (replaces Ultra Key). mode=hybrid (default, for green/blue screens): AI matte (Robust Video Matting) combined with a clean-plate difference key built from the footage itself, so uneven/dark/compressed screens key cleanly, hair keeps detail, and props like chairs/desks/mics are kept; edges are colour-unmixed and despilled. mode=rvm: AI only, any background, people only. Use preview_times first for a quick look (PNGs). For an edit, pass ranges = the source in/out of every timeline clip (only those frames are matted, back to back) and place it with ppro_replace_with_matte(matte_map). 4K ProRes 4444 is ~2.3 MB/frame. Needs matte_setup once.",
    {
      path: z.string(),
      ranges: z.array(z.array(z.number()).length(2)).optional().describe("Only matte these source ranges [start,end] (e.g. the in/out of every clip in your edit); written back to back with a map file. Saves a lot of disk vs one long range"),
      handles: z.number().optional().describe("Extra seconds kept around each range (default 0.5); ranges closer than 1 s are merged"),
      start: z.number().optional().describe("Source seconds. Default 0"),
      end: z.number().optional().describe("Source seconds. Default end of file"),
      output_path: z.string().optional().describe("Default: <source folder>/<name>.matte.mov"),
      mode: z.enum(["hybrid", "rvm"]).optional(),
      screen: z.enum(["green", "blue", "none"]).optional(),
      model: z.enum(["resnet50", "mobilenetv3"]).optional().describe("Default resnet50 (better); mobilenetv3 is faster"),
      downsample: z.number().optional().describe("AI working scale (0-1). Default auto (~540p internal)"),
      diff_low: z.number().optional().describe("Plate difference treated as background. Default 0.06; raise if screen noise shows"),
      diff_high: z.number().optional().describe("Plate difference treated as solid. Default 0.16"),
      despill: z.number().min(0).max(1).optional().describe("Edge despill strength. Default 1"),
      prores_q: z.number().int().min(1).max(31).optional().describe("ProRes qscale, lower = larger/better. Default 6"),
      preview_times: z.array(z.number()).optional().describe("Only render RGBA PNG previews at these source times"),
      device: z.enum(["auto", "cuda", "cpu"]).optional(),
    },
    async (o) => {
      const file = mustExist(o.path);
      const info = await probe(file);
      if (!info.video) throw new Error("No video stream");
      const [n, d] = String(info.video.fpsRational || "30/1").split("/").map(Number);
      const fps = d ? n / d : n;
      const lastF = Math.floor(info.duration * fps);
      let frameRanges = null;
      if (o.ranges && o.ranges.length) {
        const h = o.handles ?? 0.5;
        const rs = o.ranges.map(([a, b]) => [Math.max(0, Math.round((a - h) * fps)), Math.min(lastF, Math.round((b + h) * fps))])
          .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
        frameRanges = [];
        for (const r of rs) {
          const prev = frameRanges[frameRanges.length - 1];
          if (prev && r[0] <= prev[1] + Math.round(fps)) prev[1] = Math.max(prev[1], r[1]);
          else frameRanges.push([...r]);
        }
      }
      const startF = frameRanges ? frameRanges[0][0] : Math.max(0, Math.round((o.start || 0) * fps));
      const endF = frameRanges ? frameRanges[frameRanges.length - 1][1] : Math.min(lastF, Math.round((o.end ?? info.duration) * fps));
      if (endF <= startF) throw new Error("end must be after start");
      const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
      const preview = o.preview_times && o.preview_times.length;
      const out = preview ? path.join(config.outputsDir, `matte-preview-${path.basename(base)}`)
        : (o.output_path ? path.resolve(o.output_path) : `${base}.matte.mov`);
      const args = [path.join(ROOT_DIR, "src", "matte.py"), "--input", file, "--output", out,
        "--width", String(info.video.width), "--height", String(info.video.height), "--fps", `${n}/${d || 1}`,
        "--start-frame", String(startF), "--end-frame", String(endF), "--ffmpeg", config.ffmpeg, "--ffprobe", config.ffprobe, "--models-dir", config.modelsDir,
        "--mode", o.mode || "hybrid", "--screen", o.screen || "green", "--model", o.model || "resnet50", "--device", o.device || "auto"];
      const opt = { downsample: "--downsample", diff_low: "--diff-low", diff_high: "--diff-high", despill: "--despill", prores_q: "--prores-q" };
      for (const [k, flag] of Object.entries(opt)) if (o[k] !== undefined) args.push(flag, String(o[k]));
      if (preview) args.push("--preview-times", o.preview_times.join(","));
      const mapFile = preview ? null : out.replace(/\.mov$/i, "") + ".map.json";
      if (mapFile) args.push("--map-out", mapFile);
      if (frameRanges && !preview) args.push("--ranges", frameRanges.map((r) => r.join(":")).join(","));
      let last = "";
      return startAndWait({
        kind: "matte", cmd: config.python, args,
        parseProgress: (line) => {
          if (line.startsWith("{")) last = line;
          const m = line.match(/^PROGRESS (\d+) (\d+)/);
          return m ? Number(m[1]) / Number(m[2]) : null;
        },
        meta: { source: file, output: out, startFrame: startF, endFrame: endF },
        onDone: async () => {
          const r = last ? JSON.parse(last) : {};
          return { ...r, source: file, fps, matte_map: mapFile,
            seconds: frameRanges ? frameRanges.reduce((n, [a, b]) => n + (b - a), 0) / fps : (endF - startF) / fps,
            note: preview ? "Preview PNGs are straight RGBA." : "Place with ppro_replace_with_matte(matte_map=...)." };
        },
      }, preview ? 50 : 20);
    });

  // ---------- mouth noises ----------
  const detectMouthNoises = async (file, segs, extra = {}) => {
    const segFile = path.join(config.outputsDir, `mouth-${Date.now()}.segments.json`);
    fs.writeFileSync(segFile, JSON.stringify(segs.map((s) => (Array.isArray(s) ? s : [s.start, s.end]))));
    const args = [path.join(ROOT_DIR, "src", "mouth_noises.py"), "--input", file, "--segments", segFile, "--ffmpeg", config.ffmpeg];
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) args.push(`--${k.replace(/_/g, "-")}`, String(v));
    const r = await runCapture(config.python, args, { timeoutMs: 600000 });
    if (r.code !== 0) throw new Error("mouth_noises.py failed: " + r.err.slice(-600));
    return JSON.parse(r.out.trim().split("\n").pop());
  };

  tool("media_detect_mouth_noises",
    "Find tongue clicks / lip smacks right before speech at the start of each segment (and right after speech at the end). Returns per segment: speech_onset, clicks, clean_start (first clean point after the last noise) and whether it can be removed without touching the word. Pure analysis; ppro_declick_audio applies it to a sequence.",
    {
      path: z.string(),
      segments: z.array(z.union([z.array(z.number()).length(2), z.object({ start: z.number(), end: z.number() })])).min(1),
      click_db: z.number().optional().describe("Sensitivity: dB over the noise floor that counts as a noise. Default 14 (lower = more sensitive)"),
      speech_db: z.number().optional().describe("dB over floor that counts as speech. Default 18"),
    },
    async ({ path: p, segments, click_db, speech_db }) => detectMouthNoises(mustExist(p), segments, { click_db, speech_db }));

  tool("ppro_declick_audio",
    "Remove mouth noises (tongue clicks, lip smacks) at the starts (and optionally ends) of every clip on an audio track, without changing the edit: analyses each clip's source audio, then shapes the clip's Volume keyframes so it stays silent until just after the last noise and fades in a few ms before the word. Keeps each clip's current level. Run after a rough cut.",
    {
      sequence: z.string().optional().describe("Default: active sequence"),
      audio_track: z.number().int().optional().describe("0-based. Default 0 (A1)"),
      tails: z.boolean().optional().describe("Also clean noises after the last word of each clip. Default false (word-final t/k/p releases look like clicks)"),
      guard_ms: z.number().optional().describe("When the transcript shows the clip starts (or ends) on a plosive/fricative (p t k b d g s f h th ch...), a noise must be at least this far from the word to be removed. Default 120"),
      fade_ms: z.number().optional().describe("Fade-in/out length around the cleaned point. Default 12"),
      click_db: z.number().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ sequence, audio_track = 0, tails = false, fade_ms = 12, click_db, dry_run = false, guard_ms = 120 }) => {
      const items = await bridge.run(script({ sequence, audio_track }, `
        const p = await getProject();
        const seq = await getSeq(p, args.sequence);
        const tr = await seq.getAudioTrack(args.audio_track);
        const out = [];
        for (const ti of tr.getTrackItems(C.TrackItemType.CLIP, false)) {
          const pi = ppro.ClipProjectItem.cast(await ti.getProjectItem());
          out.push({ path: pi ? await pi.getMediaFilePath() : null, in: secs(await ti.getInPoint()), out: secs(await ti.getOutPoint()) });
        }
        return { sequence: seq.name, items: out };
      `), { label: "declick_list" }).then((r) => r.result);
      const byPath = {};
      items.items.forEach((it, i) => { if (it.path) (byPath[it.path] = byPath[it.path] || []).push({ ...it, i }); });
      const plan = [];
      for (const [file, list] of Object.entries(byPath)) {
        const res = await detectMouthNoises(file, list.map((x) => [x.in, x.out]), { click_db, tails: tails ? 1 : 0 });
        res.segments.forEach((s, k) => plan.push({ i: list[k].i, in: list[k].in, out: list[k].out,
          head: s.head_fixable ? { clean: s.clean_start, onset: s.speech_onset, clicks: s.clicks.length } : null,
          tail: tails && s.tail_fixable ? { clean: s.clean_end, offset: s.speech_offset, clicks: s.tail_clicks.length } : null }));
        // A plosive/fricative at the edge of a word starts/ends with a click-like burst. With a transcript,
        // only remove a noise that is clearly separate from such a word.
        let words = null;
        try { words = loadTranscript(file).data.segments.flatMap((sg) => sg.words || []); } catch { words = null; }
        if (words) {
          const clean = (w) => w.word.toLowerCase().replace(/[^a-z']/g, "");
          const hard = /^(th|ch|sh|p|t|k|b|d|g|c|q|j|s|z|f|v|h|x)/;
          const hardEnd = /(p|t|k|b|d|g|ck|ch|sh|s|z|f|v|x|th)$/;
          for (const x of plan) {
            if (!list.some((l) => l.i === x.i)) continue;
            if (x.head) {
              const w = words.find((w) => w.end > x.head.onset - 0.05 && w.start < x.out && w.end > x.in);
              if (w && hard.test(clean(w)) && x.head.onset - x.head.clean < guard_ms / 1000) { x.skipped = (x.skipped || []).concat(`head: starts on "${w.word.trim()}"`); x.head = null; }
            }
            if (x.tail) {
              const w = [...words].reverse().find((w) => w.start < x.tail.offset + 0.05 && w.start >= x.in);
              if (w && hardEnd.test(clean(w)) && x.tail.clean - x.tail.offset < guard_ms / 1000) { x.skipped = (x.skipped || []).concat(`tail: ends on "${w.word.trim()}"`); x.tail = null; }
            }
          }
        }
      }
      const skipped = plan.filter((x) => x.skipped).map((x) => ({ i: x.i, in: x.in, why: x.skipped }));
      const todo = plan.filter((x) => x.head || x.tail);
      if (dry_run || !todo.length) return { sequence: items.sequence, clips: items.items.length, toFix: todo.length, plan: todo, skipped, applied: false };
      const applied = await bridge.run(script({ sequence, audio_track, todo, fade: fade_ms / 1000 }, `
        const p = await getProject();
        const seq = await getSeq(p, args.sequence);
        const tis = (await seq.getAudioTrack(args.audio_track)).getTrackItems(C.TrackItemType.CLIP, false);
        let n = 0;
        for (const job of args.todo) {
          const ti = tis[job.i];
          const ch = await ti.getComponentChain();
          let lv = null;
          for (let c = 0; c < ch.getComponentCount(); c++) { const comp = ch.getComponentAtIndex(c); if ((await comp.getDisplayName()) === "Volume") { lv = comp.getParam(1); break; } }
          if (!lv) continue;
          const mid = (job.in + job.out) / 2;
          const v = await lv.getValueAtTime(T(mid));
          const level = typeof v === "object" ? (v.value ?? v) : v;
          if (!(await lv.isTimeVarying())) tx(p, "Keyframes on", () => [lv.createSetTimeVaryingAction(true)]);
          const kts = (await lv.getKeyframeListAsTickTimes()).map(secs);
          const kill = [];
          if (job.head) for (const t of kts) if (t >= job.in - 1e-4 && t < job.head.onset) kill.push(t);
          if (job.tail) for (const t of kts) if (t > job.tail.offset && t <= job.out + 1e-4) kill.push(t);
          if (kill.length) tx(p, "Clear keyframes", () => kill.map((t) => lv.createRemoveKeyframeAction(T(t))));
          const adds = [];
          const kf = (t, val) => { const k = lv.createKeyframe(val); k.position = T(t); adds.push(k); };
          if (job.head) { const c = job.head.clean; kf(job.in, 0); kf(c, 0); kf(Math.min(c + args.fade, job.head.onset - 0.002), level); }
          if (job.tail) { const c = job.tail.clean; kf(Math.max(c - args.fade, job.tail.offset + 0.002), level); kf(c, 0); kf(job.out, 0); }
          tx(p, "Declick", () => adds.map((k) => lv.createAddKeyframeAction(k)));
          n++;
        }
        return n;
      `), { label: "declick_apply", timeoutMs: 300000 }).then((r) => r.result);
      return { sequence: items.sequence, clips: items.items.length, fixed: applied, plan: todo, skipped };
    });

  tool("job_status",
    "Check (and optionally wait for) a background job: transcription, silence detection, shorts render. Without job_id lists all jobs.",
    { job_id: z.string().optional(), wait_seconds: z.number().max(55).optional().describe("Wait up to this long for completion. Default 0") },
    async ({ job_id, wait_seconds = 0 }) => {
      if (!job_id) return listJobs().map(publicJob);
      const j = getJob(job_id);
      if (!j) throw new Error("Unknown job " + job_id);
      const deadline = Date.now() + wait_seconds * 1000;
      while (j.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
      return publicJob(j);
    });

  tool("job_cancel", "Cancel a running background job.", { job_id: z.string() },
    async ({ job_id }) => { const j = getJob(job_id); if (!j) throw new Error("Unknown job"); j.cancel && j.cancel(); return publicJob(j); });

  tool("transcript_read",
    "Read a transcript as timestamped lines, optionally only a time range. Use this to understand the content, pick story beats, chapters, or short-form moments. Paginate with start/end for long videos.",
    {
      transcript: z.string().describe("Transcript JSON path, or the media path that was transcribed"),
      start: z.number().optional(),
      end: z.number().optional(),
      max_chars: z.number().int().optional().describe("Default 40000"),
    },
    async ({ transcript, start = 0, end = Infinity, max_chars = 40000 }) => {
      const { file, data } = loadTranscript(transcript);
      const lines = [];
      let used = 0, cutAt = null;
      for (const s of data.segments) {
        if (s.end <= start || s.start >= end) continue;
        const line = `[${fmtTs(s.start)}-${fmtTs(s.end)}] ${s.text}`;
        if (used + line.length > max_chars) { cutAt = s.start; break; }
        lines.push(line); used += line.length + 1;
      }
      return `transcript: ${file}\nlanguage: ${data.language} | duration: ${fmtTs(data.duration)} (${data.duration}s)\n` +
        (cutAt !== null ? `NOTE: truncated - continue with start=${cutAt}\n` : "") + "\n" + lines.join("\n");
    });

  tool("transcript_search",
    "Search a transcript for keywords or phrases (free alternative to paid AI clip finders). Returns precise word-level timestamps with context, ready to use as cut points, markers or shorts ranges.",
    {
      transcript: z.string(),
      query: z.array(z.string()).min(1).describe("Keywords or phrases. Phrases match consecutive words."),
      mode: z.enum(["any", "regex"]).optional().describe("'any' (default): each query term separately; 'regex': query[0] as a regex over the full text"),
      context_seconds: z.number().optional().describe("Context window around each hit. Default 6"),
      max_hits: z.number().int().optional().describe("Default 100"),
    },
    async ({ transcript, query, mode = "any", context_seconds = 6, max_hits = 100 }) => {
      const { file, data } = loadTranscript(transcript);
      const words = wordsFromTranscript(data);
      const strip = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}' ]/gu, "").trim();
      const norm = words.map((w) => strip(w.word));
      // character offsets of each word in one joined string
      let joined = ""; const offs = [];
      norm.forEach((w) => { offs.push(joined.length); joined += w + " "; });
      const wordAt = (charPos) => { let lo = 0, hi = offs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= charPos) lo = mid; else hi = mid - 1; } return lo; };
      const hits = [];
      const patterns = mode === "regex"
        ? [{ q: query[0], re: new RegExp(query[0], "giu") }]
        : query.map((q) => ({ q, re: new RegExp(`(?<![\\p{L}\\p{N}])${strip(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, " +")}(?![\\p{L}\\p{N}])`, "giu") }));
      for (const { q, re } of patterns) {
        for (const m of joined.matchAll(re)) {
          const a = wordAt(m.index), b = wordAt(m.index + Math.max(0, m[0].trimEnd().length - 1));
          const st = words[a].start, en = words[b].end;
          const ctx = words.filter((w) => w.end >= st - context_seconds && w.start <= en + context_seconds).map((w) => w.word).join(" ");
          hits.push({ query: q, start: r3(st), end: r3(en), at: fmtTs(st), matched: words.slice(a, b + 1).map((w) => w.word).join(" "), context: ctx });
          if (hits.length >= max_hits) break;
        }
      }
      hits.sort((x, y) => x.start - y.start);
      const counts = Object.fromEntries(query.map((q) => [q, hits.filter((h) => h.query === q).length]));
      return { transcript: file, counts, hits };
    });

  tool("captions_list_templates",
    "List caption templates (built-in and your saved ones).",
    {},
    async () => ({ templates: listTemplates(), userTemplatesFolder: config.userTemplatesDir }));

  tool("captions_get_template",
    "Show a caption template's full settings (resolved with defaults), e.g. before tweaking it.",
    { name: z.string() },
    async ({ name }) => loadTemplate(name));

  tool("captions_save_template",
    "Create or overwrite a caption template. Partial settings are fine: anything omitted uses defaults, or set 'extends' to start from another template. Keys: maxCharsPerLine, maxLines, maxWordsPerCaption, minDuration, maxDuration, maxGap, splitOnSentenceEnd, case (none|upper|lower|sentence), stripPunctuation, removeFillers, fillers[], highlightActiveWord, style{font,fontSize,bold,primaryColor,highlightColor,outlineColor,backColor,backOpacity,outline,shadow,borderStyle(1 outline|3 box),alignment(2 bottom,5 middle,8 top),marginV,marginH,playResX,playResY}.",
    {
      name: z.string(),
      template: z.record(z.string(), z.any()).describe("Template settings"),
    },
    async ({ name, template }) => {
      const resolved = template.extends ? mergeTemplate(loadTemplate(template.extends), template) : mergeTemplate(DEFAULT_TEMPLATE, template);
      const file = saveTemplate(name, template);
      return { saved: file, resolved };
    });

  tool("captions_generate",
    "Create captions from a Whisper transcript using a template. srt/vtt for Premiere or YouTube upload; ass for styled burn-in. Optionally only a time range, rebased so the range starts at 0 (for a short).",
    {
      transcript: z.string().describe("Transcript JSON or transcribed media path"),
      template: z.string().optional().describe("Template name or JSON path. Default youtube-standard"),
      format: z.enum(["srt", "vtt", "ass"]).optional(),
      output_path: z.string().optional(),
      start: z.number().optional(),
      end: z.number().optional(),
      rebase: z.boolean().optional().describe("Shift times so 'start' becomes 0. Default true when start is given"),
      template_overrides: z.record(z.string(), z.any()).optional().describe("One-off tweaks on top of the template"),
    },
    async ({ transcript, template = "youtube-standard", format = "srt", output_path, start, end, rebase, template_overrides }) => {
      const { data } = loadTranscript(transcript);
      let tpl = loadTemplate(template);
      if (template_overrides) tpl = mergeTemplate(tpl, template_overrides);
      const words = wordsFromTranscript(data, { start: start ?? null, end: end ?? null })
        .map((w) => ({ ...w, start: Math.max(w.start, start ?? -Infinity), end: Math.min(w.end, end ?? Infinity) }));
      const events = chunkWords(words, tpl);
      const shift = (rebase ?? start !== undefined) && start ? -start : 0;
      const base = path.basename(data.source || "captions").replace(/\.[^.]+$/, "");
      const out = output_path || path.join(config.outputsDir, `${base}.${tpl.name}${start !== undefined ? `.${Math.round(start)}s` : ""}.${format}`);
      writeCaptions(events, format, out, tpl, { offset: shift });
      return { output: out, captions: events.length, template: tpl.name, format, preview: events.slice(0, 5).map((e) => `${fmtTs(e.start + shift)} ${e.lines.join(" / ")}`) };
    });

  tool("captions_reformat",
    "Re-chunk and restyle an existing SRT/VTT (e.g. exported from Premiere or YouTube) with a template: change line length, words per caption, casing, filler removal, or convert to styled ASS. Word timing is interpolated inside each original cue.",
    {
      input_path: z.string(),
      template: z.string(),
      format: z.enum(["srt", "vtt", "ass"]).optional(),
      output_path: z.string().optional(),
      template_overrides: z.record(z.string(), z.any()).optional(),
    },
    async ({ input_path, template, format = "srt", output_path, template_overrides }) => {
      const file = mustExist(input_path);
      let tpl = loadTemplate(template);
      if (template_overrides) tpl = mergeTemplate(tpl, template_overrides);
      const words = wordsFromSubtitles(fs.readFileSync(file, "utf8"));
      if (!words.length) throw new Error("No cues found in " + file);
      const events = chunkWords(words, tpl);
      const out = output_path || file.replace(/\.[^.]+$/, `.${tpl.name}.${format}`);
      writeCaptions(events, format, out, tpl);
      return { output: out, captionsBefore: null, captionsAfter: events.length, template: tpl.name };
    });

  tool("shorts_render",
    "Render a vertical short (default 1080x1920) from a time range of a source video with ffmpeg: crop or blurred-background framing, optional burned-in styled captions from the transcript. Free and local. Runs in the background; returns job_id if it takes long.",
    {
      source: z.string(),
      start: z.number(),
      end: z.number(),
      output_path: z.string().optional(),
      framing: z.enum(["crop", "blur_pad", "fit_black"]).optional().describe("crop (default) fills the frame; blur_pad keeps the full width over a blurred copy; fit_black letterboxes"),
      crop_x: z.number().min(0).max(1).optional().describe("Horizontal crop position 0=left, 0.5=centre (default), 1=right"),
      burn_captions: z.boolean().optional().describe("Default true if a transcript exists"),
      transcript: z.string().optional().describe("Transcript JSON (default: the cached one for the source)"),
      caption_template: z.string().optional().describe("Default shorts-punchy"),
      template_overrides: z.record(z.string(), z.any()).optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      crf: z.number().int().optional().describe("x264 quality, lower=better. Default 18"),
      fade: z.boolean().optional().describe("Short audio/video fade in/out. Default true"),
    },
    async (a) => {
      const src = mustExist(a.source);
      if (a.end <= a.start) throw new Error("end must be after start");
      const W = a.width || 1080, H = a.height || 1920;
      const dur = r3(a.end - a.start);
      const info = await probe(src);
      const outDir = a.output_path ? path.dirname(path.resolve(a.output_path)) : path.join(config.outputsDir, "shorts");
      fs.mkdirSync(outDir, { recursive: true });
      const base = path.basename(src).replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_");
      const out = a.output_path ? path.resolve(a.output_path) : path.join(outDir, `${base}_${Math.round(a.start)}-${Math.round(a.end)}.mp4`);

      // captions
      let assName = null, captionCount = 0;
      let transcriptFile = null;
      try { transcriptFile = a.transcript ? loadTranscript(a.transcript).file : findTranscriptFor(src); } catch { transcriptFile = null; }
      const burn = a.burn_captions ?? !!transcriptFile;
      if (burn) {
        if (!transcriptFile) throw new Error("burn_captions needs a transcript. Run transcribe_media on the source first, or set burn_captions=false.");
        const { data } = loadTranscript(transcriptFile);
        let tpl = loadTemplate(a.caption_template || "shorts-punchy");
        if (a.template_overrides) tpl = mergeTemplate(tpl, a.template_overrides);
        const words = wordsFromTranscript(data, { start: a.start, end: a.end })
          .map((w) => ({ ...w, start: Math.max(w.start, a.start), end: Math.min(w.end, a.end) }));
        const events = chunkWords(words, tpl);
        captionCount = events.length;
        assName = `.${base}_${Math.round(a.start)}_${crypto.randomBytes(3).toString("hex")}.ass`;
        writeCaptions(events, "ass", path.join(outDir, assName), tpl, { offset: -a.start, playResX: W, playResY: H });
      }

      // framing
      const xf = a.crop_x ?? 0.5;
      let vf;
      const framing = a.framing || "crop";
      if (framing === "crop") {
        vf = `[0:v]scale=w=${W}:h=${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(in_w-${W})*${xf}:(in_h-${H})/2,setsar=1`;
      } else if (framing === "blur_pad") {
        vf = `[0:v]split[a][b];[a]scale=w=${W}:h=${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:4,eq=brightness=-0.08[bg];[b]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
      } else {
        vf = `[0:v]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
      }
      const fade = a.fade !== false && dur > 2;
      if (fade) vf += `,fade=t=in:st=0:d=0.15,fade=t=out:st=${r3(dur - 0.25)}:d=0.25`;
      if (assName) vf += `,ass=${assName}`;
      vf += `,format=yuv420p[v]`;

      const args = ["-hide_banner", "-y", "-ss", String(a.start), "-t", String(dur), "-i", src,
        "-filter_complex", vf, "-map", "[v]"];
      if (info.audio) {
        args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", "192k");
        if (fade) args.push("-af", `afade=t=in:st=0:d=0.1,afade=t=out:st=${r3(dur - 0.25)}:d=0.25`);
      }
      args.push("-c:v", "libx264", "-preset", "medium", "-crf", String(a.crf || 18), "-r", String(info.video && info.video.fps && info.video.fps <= 60 ? info.video.fps : 30),
        "-movflags", "+faststart", out);

      return startAndWait({
        kind: "short",
        cmd: config.ffmpeg,
        args,
        cwd: outDir, // lets the ass filter use a plain relative file name on every OS
        totalSeconds: dur,
        parseProgress: ffmpegProgress,
        meta: { source: src, start: a.start, end: a.end },
        onDone: async () => {
          if (assName) { try { fs.unlinkSync(path.join(outDir, assName)); } catch { /* ignore */ } }
          return { output: out, duration: dur, size: `${W}x${H}`, framing, captions: captionCount, captionTemplate: burn ? (a.caption_template || "shorts-punchy") : null };
        },
      }, 45);
    });

  tool("media_extract_frames",
    "Save still frames from a media file at given times (thumbnail candidates, visual checks). Returns file paths.",
    {
      path: z.string(),
      times: z.array(z.number()).min(1).max(50),
      output_dir: z.string().optional(),
      width: z.number().int().optional().describe("Resize width, keeps aspect. Default original"),
      format: z.enum(["jpg", "png"]).optional(),
    },
    async ({ path: p, times, output_dir, width, format = "jpg" }) => {
      const file = mustExist(p);
      const dir = output_dir || path.join(config.outputsDir, "frames");
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(file).replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_");
      const outs = [];
      for (const t of times) {
        const out = path.join(dir, `${base}_${t.toFixed(2).replace(".", "s")}.${format}`);
        const args = ["-hide_banner", "-y", "-ss", String(t), "-i", file, "-frames:v", "1"];
        if (width) args.push("-vf", `scale=${width}:-2`);
        if (format === "jpg") args.push("-q:v", "2");
        args.push(out);
        const r = await runCapture(config.ffmpeg, args, { timeoutMs: 60000 });
        outs.push(r.code === 0 ? { time: t, path: out } : { time: t, error: r.err.slice(-300) });
      }
      return outs;
    });
}
