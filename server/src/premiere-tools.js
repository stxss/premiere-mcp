// MCP tools that act inside Premiere Pro through the UXP bridge.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { script } from "./ppro-prelude.js";
import { API_HELP } from "./api-help.js";
import { config } from "./config.js";
import { fileURLToPath } from "node:url";
import { registerPlanTools, loadPlan, trackOf } from "./plan-tools.js";

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: `Error: ${err.message || err}${err.logs && err.logs.length ? "\nLogs:\n" + err.logs.join("\n") : ""}` }],
});

export function registerPremiereTools(server, bridge) {
  const run = async (label, args, body, opts = {}) => {
    const { result, logs } = await bridge.run(script(args, body), { label, ...opts });
    return logs && logs.length ? { result, logs } : result;
  };
  const tool = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try { return ok(await handler(args || {})); } catch (e) { return fail(e); }
    });
  };

  tool("ppro_status",
    "Check whether Premiere Pro is connected, and summarise the open project (name, path, sequences, active sequence).",
    {},
    async () => {
      const status = bridge.status();
      if (!status.connected) return { ...status, hint: "Open the 'MCP Bridge' panel in Premiere (Window > UXP Plugins)." };
      const project = await run("status", {}, `
        const p = await ppro.Project.getActiveProject();
        if (!p) return { project: null };
        const seqs = await p.getSequences();
        const active = await p.getActiveSequence();
        return { project: { name: p.name, path: p.path }, sequences: seqs.map(s => s.name), activeSequence: active ? active.name : null };
      `);
      return { ...status, ...project };
    });

  tool("ppro_execute_script",
    "Run arbitrary JavaScript inside Premiere Pro via the UXP API. The code is the body of an async function; use `await` and `return` a JSON-serialisable value. In scope: ppro (premierepro module), uxp, log(...), plus helpers: getProject(), tx(project, label, () => actions), T(seconds) -> TickTime, secs(tickTime), walk(project), findItem(project, ref, kinds?), findBin(project, path, create), getSeq(project, name?), sequenceInfo(seq), listMarkers(owner), markerType(name). Edits must be made as actions committed with tx(). Call ppro_api_help first if unsure of the API. Prefer the dedicated tools when one fits.",
    {
      code: z.string().describe("Async function body to execute in Premiere"),
      timeout_seconds: z.number().optional().describe("Default 120"),
    },
    async ({ code, timeout_seconds }) => run("execute_script", {}, code, timeout_seconds ? { timeoutMs: timeout_seconds * 1000 } : {}));

  tool("ppro_api_help",
    "Cheat sheet for the Premiere Pro UXP API (objects, methods, the action/transaction pattern) for writing ppro_execute_script code.",
    {},
    async () => API_HELP);

  tool("ppro_project_overview",
    "List every bin, clip and sequence in the open project with bin paths and source media paths.",
    { include_media_paths: z.boolean().optional().describe("Default true") },
    async ({ include_media_paths = true }) => run("project_overview", { include_media_paths }, `
      const p = await getProject();
      const { items } = await walk(p);
      return {
        project: { name: p.name, path: p.path },
        counts: { bins: items.filter(i => i.kind === "bin").length, clips: items.filter(i => i.kind === "clip").length, sequences: items.filter(i => i.kind === "sequence").length },
        items: items.map(i => {
          const o = { path: i.path, kind: i.kind };
          if (args.include_media_paths && i.mediaPath) o.media = i.mediaPath;
          return o;
        }),
      };
    `));

  tool("ppro_import_files",
    "Import media files (video, audio, images, SRT captions) into the project, optionally into a bin path (created if missing).",
    {
      paths: z.array(z.string()).min(1).describe("Absolute file paths on this computer"),
      bin: z.string().optional().describe("Bin path, e.g. 'Footage/A-cam'. Created if missing."),
    },
    async ({ paths, bin }) => {
      const missing = paths.filter((p) => !fs.existsSync(p));
      if (missing.length) throw new Error("Files not found: " + missing.join(", "));
      return run("import_files", { paths, bin }, `
        const p = await getProject();
        const target = await findBin(p, args.bin, true);
        const ok = await p.importFiles(args.paths, true, target, false);
        return { imported: ok, bin: args.bin || "(root)", files: args.paths };
      `, { timeoutMs: 600000 });
    });

  tool("ppro_organize",
    "Project housekeeping: create bins, move items into bins, rename items, and set label colours. Operations run in order.",
    {
      operations: z.array(z.object({
        op: z.enum(["create_bin", "move", "rename", "label"]),
        item: z.string().optional().describe("Item path/name/media path (move, rename, label)"),
        bin: z.string().optional().describe("Bin path (create_bin target or move destination)"),
        name: z.string().optional().describe("New name (rename)"),
        color_index: z.number().int().min(0).max(15).optional().describe("Label colour index (label)"),
      })).min(1),
    },
    async ({ operations }) => run("organize", { operations }, `
      const p = await getProject();
      const results = [];
      for (const op of args.operations) {
        try {
          if (op.op === "create_bin") {
            await findBin(p, op.bin, true);
            results.push({ op: op.op, bin: op.bin, ok: true });
          } else if (op.op === "move") {
            const it = await findItem(p, op.item);
            const dest = await findBin(p, op.bin, true);
            const parent = it.item.getParentBin();
            tx(p, "Move " + it.name, () => parent.createMoveItemAction(it.item, dest));
            results.push({ op: op.op, item: it.path, to: op.bin, ok: true });
          } else if (op.op === "rename") {
            const it = await findItem(p, op.item);
            tx(p, "Rename " + it.name, () => it.item.createSetNameAction(op.name));
            results.push({ op: op.op, item: it.path, name: op.name, ok: true });
          } else if (op.op === "label") {
            const it = await findItem(p, op.item);
            tx(p, "Label " + it.name, () => it.item.createSetColorLabelAction(op.color_index));
            results.push({ op: op.op, item: it.path, ok: true });
          }
        } catch (e) {
          results.push({ op: op.op, item: op.item, bin: op.bin, ok: false, error: e.message });
        }
      }
      return results;
    `));

  tool("ppro_sequence_info",
    "Detailed info for a sequence (active one by default): frame size, timebase, tracks with every clip's timeline start/end and source in/out, caption tracks, markers.",
    {
      sequence: z.string().optional(),
      max_clips_per_track: z.number().int().optional().describe("Default 500"),
    },
    async ({ sequence, max_clips_per_track }) => run("sequence_info", { sequence, max: max_clips_per_track }, `
      const p = await getProject();
      const s = await getSeq(p, args.sequence);
      return await sequenceInfo(s, { maxItems: args.max || 500 });
    `));

  tool("ppro_open_sequence",
    "Open a sequence and make it active.",
    { sequence: z.string() },
    async ({ sequence }) => run("open_sequence", { sequence }, `
      const p = await getProject();
      const s = await getSeq(p, args.sequence);
      await p.openSequence(s);
      await p.setActiveSequence(s);
      return { active: s.name };
    `));

  // ---------- ExtendScript / QE DOM through the CEP "MCP QE Helper" ----------
  // host.jsx goes with every call, so edits to it work without reloading the CEP panel / restarting Premiere.
  const HOST_JSX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cep", "host.jsx");
  const jsx = async (label, code, opts = {}) => {
    let host = "";
    try { host = fs.readFileSync(HOST_JSX, "utf8") + "\n"; } catch { /* use the copy the panel loaded at startup */ }
    const { result: raw } = await bridge.runJsx(host + code, { label, ...opts });
    if (typeof raw !== "string") return raw;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return raw; }
    if (parsed && parsed.ok === false) throw new Error(parsed.error);
    return parsed && "result" in parsed ? parsed.result : parsed;
  };
  const activate = (sequence) => run("activate", { sequence }, `
    const p = await getProject();
    const s = await getSeq(p, args.sequence);
    await p.openSequence(s);
    await p.setActiveSequence(s);
    return s.name;
  `);

  tool("ppro_execute_extendscript",
    "Run ExtendScript (legacy DOM: app, qe after app.enableQE()) in Premiere through the CEP 'MCP QE Helper'. The code must evaluate to a string; host.jsx gives tqJSON(value) and tqRun(fn) (returns {ok,result|error}). Use only for what UXP can't do (audio transitions, some QE-only features).",
    {
      code: z.string(),
      timeout_seconds: z.number().optional(),
    },
    async ({ code, timeout_seconds }) => jsx("execute_extendscript", code, timeout_seconds ? { timeoutMs: timeout_seconds * 1000 } : {}));

  tool("ppro_audio_transitions",
    "Add an audio transition (default 2-frame Constant Power, centered) on every edit of the given audio tracks: a crossfade where two clips touch, a fade in/out next to a gap. Uses the QE DOM through the CEP helper. Makes the sequence active first. Undo with Ctrl+Z in Premiere.",
    {
      sequence: z.string().describe("Sequence name (it gets opened and made active)"),
      tracks: z.array(z.number().int().min(1)).optional().describe("Audio tracks, 1-based (A1 = 1). Default spec.audio_tracks of the plan, else [1, 2]"),
      transition: z.string().optional().describe("Audio transition name. Default 'Constant Power'. Others: 'Constant Gain', 'Exponential Fade'"),
      frames: z.number().int().min(1).max(99).optional().describe("Duration in frames. Default 2"),
      alignment: z.number().min(0).max(1).optional().describe("0 = starts at the cut, 0.5 = centered (default), 1 = ends at the cut"),
      from: z.number().optional().describe("Only clips starting at/after this time (s)"),
      to: z.number().optional().describe("Only clips starting at/before this time (s)"),
      dry_run: z.boolean().optional().describe("Count what would be added without changing anything"),
      replace_existing: z.boolean().optional().describe("Also replace transitions already on an edge (e.g. hand-placed Custom Fades). Default false: those edges are skipped. With edges/episode_file the default is true"),
      edges: z.array(z.object({ t: z.number(), frames: z.number().int().min(1).max(99), transition: z.string().optional() })).optional()
        .describe("Only these edit points, each with its own length: the clip edge (end, or start after a gap) at t seconds on each track. One call for all per-cut fades"),
      plan_file: z.string().optional().describe("plan.json (absolute): its audio_fades become the edges (per-cut fades) and spec.audio_tracks the default tracks"),
      episode_file: z.string().optional().describe("Episode config whose work dir holds plan.json (alternative to plan_file)"),
      all_edits: z.boolean().optional().describe("With a plan: the pass over every edit (like no plan) on the plan's audio tracks instead of its audio_fades"),
      timeout_seconds: z.number().optional().describe("Default 600"),
    },
    async ({ sequence, tracks, transition = "Constant Power", frames = 2, alignment = 0.5, from, to, dry_run = false, replace_existing, edges, episode_file, plan_file, all_edits = false, timeout_seconds = 600 }) => {
      if (episode_file || plan_file) {
        const { plan, spec } = loadPlan({ episode_file, plan_file }, false);
        if (!tracks && spec.audio_tracks) tracks = spec.audio_tracks.map(trackOf).filter((t) => t.kind === "A").map((t) => t.i + 1);
        if (!edges && !all_edits) {
          edges = (plan.audio_fades || []).map((f) => ({ t: f.t, frames: f.frames }));
          if (!edges.length) return { sequence, edges: 0, note: "plan.json has no audio_fades" };
        }
      }
      tracks = tracks || [1, 2];
      const active = await activate(sequence);
      if (edges) {
        const o = { sequence: active, tracks: tracks.map((t) => t - 1), edges, transition, alignment, dryRun: dry_run, replaceExisting: replace_existing !== false };
        return jsx("audio_edges", `tqAudioEdges(${JSON.stringify(o)})`, { timeoutMs: timeout_seconds * 1000 });
      }
      replace_existing = !!replace_existing;
      const opts = { sequence: active, tracks: tracks.map((t) => t - 1), transition, frames, alignment, dryRun: dry_run, replaceExisting: replace_existing };
      if (from !== undefined) opts.from = from;
      if (to !== undefined) opts.to = to;
      const r = await jsx("audio_transitions", `tqAudioTransitions(${JSON.stringify(opts)})`, { timeoutMs: timeout_seconds * 1000 });
      if (r && r.tracks) r.tracks = r.tracks.map((t) => ({ ...t, track: `A${t.track + 1}` }));
      return r;
    });

  tool("ppro_create_sequence",
    "Create a new sequence from one or more project clips (settings match the first clip). Clips are placed in the order given.",
    {
      name: z.string(),
      clips: z.array(z.string()).min(1).describe("Clip refs: bin path, name or media path"),
      bin: z.string().optional().describe("Bin to put the sequence in"),
    },
    async ({ name, clips, bin }) => run("create_sequence", { name, clips, bin }, `
      const p = await getProject();
      const items = [];
      for (const c of args.clips) {
        const it = await findItem(p, c, ["clip", "sequence"]);
        items.push(ppro.ClipProjectItem.cast(it.item));
      }
      const target = await findBin(p, args.bin, true);
      const seq = await p.createSequenceFromMedia(args.name, items, target);
      if (!seq) throw new Error("Premiere did not create the sequence");
      return await sequenceInfo(seq, { markers: false });
    `, { timeoutMs: 300000 }));

  tool("ppro_rough_cut",
    "Build a rough cut in a NEW sequence from time ranges of one source clip (e.g. silence-removed segments from media_detect_silence, or story beats chosen from a transcript). Sets the source in/out per segment and lays them back to back, frame-accurate, without creating subclips. Times are seconds in the source media.",
    {
      source: z.string().describe("Source clip ref: bin path, item name or media file path"),
      sequence_name: z.string(),
      segments: z.array(z.object({ start: z.number(), end: z.number(), label: z.string().optional() })).optional(),
      segments_file: z.string().optional().describe("JSON file from media_detect_silence (uses its keep segments)"),
      bin: z.string().optional().describe("Bin for the new sequence. Default 'Sequences'"),
      video_track: z.number().int().optional().describe("0-based video track for the footage. Default 0 (V1); use 1 to leave V1 free for a background"),
      audio_track: z.number().int().optional().describe("0-based audio track. Default 0 (A1)"),
    },
    async ({ source, sequence_name, segments, segments_file, bin, video_track, audio_track }) => {
      let segs = segments;
      if (!segs && segments_file) {
        const data = JSON.parse(fs.readFileSync(segments_file, "utf8"));
        segs = (data.keep || data.segments || data).map((s) => (Array.isArray(s) ? { start: s[0], end: s[1] } : s));
      }
      if (!segs || !segs.length) throw new Error("Provide segments or segments_file");
      segs = segs.filter((s) => s.end > s.start + 0.04);
      return run("rough_cut", { source, sequence_name, segments: segs, bin: bin || "Sequences", video_track, audio_track }, `
        // Proven on Premiere 26.5: set the source clip's in/out, overwrite it onto the timeline, repeat.
        const p = await getProject();
        const src = await findItem(p, args.source, ["clip"]);
        const clip = ppro.ClipProjectItem.cast(src.item);
        const target = await findBin(p, args.bin, true);
        const seq = await p.createSequenceFromMedia(args.sequence_name, [clip], target);
        if (!seq) throw new Error("Premiere did not create the sequence");
        const ed = ppro.SequenceEditor.getEditor(seq);
        // remove the full clip Premiere placed when creating the sequence
        const placedNow = [];
        for (let i = 0; i < await seq.getVideoTrackCount(); i++) placedNow.push(...(await seq.getVideoTrack(i)).getTrackItems(C.TrackItemType.CLIP, false));
        for (let i = 0; i < await seq.getAudioTrackCount(); i++) placedNow.push(...(await seq.getAudioTrack(i)).getTrackItems(C.TrackItemType.CLIP, false));
        if (placedNow.length) ppro.TrackItemSelection.createEmptySelection((sel) => { for (const t of placedNow) sel.addItem(t); tx(p, "Clear", () => ed.createRemoveItemsAction(sel, false, C.MediaType.ANY, false)); });
        const tb = Number(await seq.getTimebase());
        const fps = tb ? 254016000000 / tb : 30;
        const origIn = secs(await clip.getInPoint()), origOut = secs(await clip.getOutPoint());
        let tF = 0, placed = 0;
        try {
          for (const sgm of args.segments) {
            const aF = Math.round(sgm.start * fps), bF = Math.round(sgm.end * fps);
            if (bF - aF < 2) continue;
            tx(p, "In/out", () => clip.createSetInOutPointsAction(T(aF / fps), T(bF / fps)));
            tx(p, "Place segment", () => ed.createOverwriteItemAction(src.item, T(tF / fps), args.video_track || 0, args.audio_track || 0));
            tF += bF - aF;
            placed++;
          }
        } finally {
          if (origOut > origIn) tx(p, "Restore in/out", () => clip.createSetInOutPointsAction(T(origIn), T(origOut)));
        }
        await p.openSequence(seq);
        return {
          sequence: seq.name,
          bin: args.bin,
          segments: placed,
          fps: Math.round(fps * 1000) / 1000,
          cutDurationSeconds: Math.round(tF / fps * 100) / 100,
          sequenceEnd: secs(await seq.getEndTime()),
        };
      `, { timeoutMs: 900000 });
    });

  tool("ppro_replace_with_matte",
    "Swap every timeline use of a source clip for its alpha matte from media_matte, keeping the edit: each clip is overwritten in place with the matte at the same source range (matte time = source time - offset_seconds). Audio is untouched. Optionally copies the source clip's non-key master-clip effects (e.g. Drop Shadow) onto the matte's master clip and removes keyers from the timeline clips.",
    {
      matte_path: z.string(),
      source: z.string().describe("Original clip ref (name, bin path or media path)"),
      matte_map: z.string().optional().describe("The .map.json written by media_matte (preferred)"),
      offset_seconds: z.number().optional().describe("For a single continuous matte without a map: its source start time"),
      sequence: z.string().optional().describe("Default: active sequence"),
      video_track: z.number().int().optional().describe("0-based; default: every video track"),
      bin: z.string().optional().describe("Default 'Mattes'"),
      copy_master_effects: z.boolean().optional().describe("Copy non-keyer master-clip effects from source to matte. Default true"),
    },
    async (a) => {
      let ranges = null, srcFps = null;
      if (a.matte_map) {
        const m = JSON.parse(fs.readFileSync(a.matte_map, "utf8"));
        ranges = m.ranges;
        const [n, d] = String(m.fps || "").split("/").map(Number);
        srcFps = n ? n / (d || 1) : null;
      }
      else if (a.offset_seconds === undefined) throw new Error("Pass matte_map or offset_seconds");
      return run("replace_with_matte", { ...a, ranges, srcFps, bin: a.bin || "Mattes", copy: a.copy_master_effects !== false }, `
      const p = await getProject();
      const seq = await getSeq(p, args.sequence);
      const src = await findItem(p, args.source, ["clip"]);
      const srcPath = await ppro.ClipProjectItem.cast(src.item).getMediaFilePath();
      let mt;
      try { mt = await findItem(p, args.matte_path, ["clip"]); } catch { mt = null; }
      if (!mt || (mt.mediaPath || "").toLowerCase() !== args.matte_path.toLowerCase()) {
        const target = await findBin(p, args.bin, true);
        await p.importFiles([args.matte_path], true, target, false);
        mt = await findItem(p, args.matte_path, ["clip"]);
      }
      const mclip = ppro.ClipProjectItem.cast(mt.item);
      const tb = Number(await seq.getTimebase());
      const seqFps = tb ? 254016000000 / tb : 30;
      const fps = args.srcFps || seqFps; // source/matte frame rate for in/out math
      const ed = ppro.SequenceEditor.getEditor(seq);
      // video-only clips need the media type for in/out queries
      const ioT = async (fn) => { try { return secs(await mclip[fn]()); } catch { return secs(await mclip[fn](C.MediaType.VIDEO)); } };
      const origIn = await ioT("getInPoint"), origOut = await ioT("getOutPoint");
      const tracks = [];
      const nV = await seq.getVideoTrackCount();
      for (let v = 0; v < nV; v++) if (args.video_track === undefined || args.video_track === v) tracks.push(v);
      let replaced = 0;
      const skipped = [];
      try {
        for (const v of tracks) {
          const items = (await seq.getVideoTrack(v)).getTrackItems(C.TrackItemType.CLIP, false);
          const jobs = [];
          for (const ti of items) {
            const pi = ppro.ClipProjectItem.cast(await ti.getProjectItem());
            if (!pi || (await pi.getMediaFilePath()) !== srcPath) continue;
            jobs.push({ start: secs(await ti.getStartTime()), in: secs(await ti.getInPoint()), out: secs(await ti.getOutPoint()) });
          }
          for (const j of jobs) {
            let aF, bF;
            const inF = Math.round(j.in * fps), outF = Math.round(j.out * fps);
            if (args.ranges) {
              const r = args.ranges.find((r) => inF >= r.src_start_frame && outF <= r.src_end_frame);
              if (!r) { skipped.push({ track: v, start: j.start, reason: "clip range not inside any matted range" }); continue; }
              aF = r.matte_start_frame + (inF - r.src_start_frame); bF = aF + (outF - inF);
            } else {
              aF = inF - Math.round(args.offset_seconds * fps); bF = aF + (outF - inF);
              if (aF < 0) { skipped.push({ track: v, start: j.start, reason: "matte starts after this clip's in point" }); continue; }
            }
            // +half a frame on the out point so tick rounding can never drop the last frame
            tx(p, "Matte in/out", () => mclip.createSetInOutPointsAction(T(aF / fps), T(bF / fps + 0.5 / fps)));
            tx(p, "Place matte", () => ed.createOverwriteItemAction(mt.item, T(Math.round(j.start * seqFps) / seqFps), v, 0));
            replaced++;
          }
        }
      } finally {
        if (origOut > origIn) tx(p, "Restore in/out", () => mclip.createSetInOutPointsAction(T(origIn), T(origOut)));
      }
      const copied = [];
      if (args.copy) {
        const from = await ppro.ClipProjectItem.cast(src.item).getComponentChain(C.MediaType.VIDEO);
        const to = await mclip.getComponentChain(C.MediaType.VIDEO);
        const have = [];
        for (let i = 0; i < to.getComponentCount(); i++) have.push(await to.getComponentAtIndex(i).getMatchName());
        for (let i = 0; i < from.getComponentCount(); i++) {
          const c = from.getComponentAtIndex(i);
          const mn = await c.getMatchName();
          if (/key/i.test(mn) || have.includes(mn)) continue;
          const nc = await ppro.VideoFilterFactory.createComponent(mn);
          tx(p, "Add " + mn, () => to.createAppendComponentAction(nc));
          const added = to.getComponentAtIndex(to.getComponentCount() - 1);
          const acts = [];
          for (let k = 0; k < c.getParamCount(); k++) {
            try {
              const sv = (await c.getParam(k).getStartValue()).value;
              const val = sv && typeof sv === "object" && "value" in sv ? sv.value : sv;
              const prm = added.getParam(k);
              acts.push(prm.createSetValueAction(prm.createKeyframe(val), true));
            } catch (e) { /* params that cannot be set statically are left at default */ }
          }
          if (acts.length) tx(p, "Copy " + mn, () => acts);
          copied.push(mn);
        }
      }
      return { sequence: seq.name, matte: mt.path, replaced, skipped, copiedMasterEffects: copied };
    `, { timeoutMs: 600000 });
    });

  tool("ppro_add_markers",
    "Add markers to a sequence (default: active) or to a clip. Types: comment, chapter (YouTube chapters), segmentation, weblink. Times in seconds.",
    {
      markers: z.array(z.object({
        time: z.number(),
        name: z.string(),
        comment: z.string().optional(),
        type: z.enum(["comment", "chapter", "segmentation", "weblink"]).optional(),
        duration: z.number().optional(),
        color_index: z.number().int().min(0).max(7).optional(),
      })).min(1),
      sequence: z.string().optional(),
      clip: z.string().optional().describe("Put markers on this clip instead of a sequence"),
    },
    async ({ markers, sequence, clip }) => run("add_markers", { markers, sequence, clip }, `
      const p = await getProject();
      let owner;
      if (args.clip) owner = ppro.ClipProjectItem.cast((await findItem(p, args.clip, ["clip"])).item);
      else owner = await getSeq(p, args.sequence);
      const mk = await ppro.Markers.getMarkers(owner);
      tx(p, "Add markers", () => args.markers.map((m) => mk.createAddMarkerAction(m.name, markerType(m.type), T(m.time), T(m.duration || 0), m.comment || "")));
      const colored = args.markers.filter((m) => m.color_index !== undefined);
      if (colored.length) {
        const fresh = (await ppro.Markers.getMarkers(owner)).getMarkers();
        tx(p, "Colour markers", () => colored.map((m) => {
          const hit = fresh.find((x) => x.getName() === m.name && Math.abs(x.getStart().seconds - m.time) < 0.05);
          return hit ? hit.createSetColorByIndexAction(m.color_index) : null;
        }));
      }
      return { added: args.markers.length, owner: args.clip || owner.name };
    `));

  tool("ppro_list_markers",
    "List markers on a sequence (default: active) or clip. Optional type filter. Useful for YouTube chapters.",
    { sequence: z.string().optional(), clip: z.string().optional(), type: z.string().optional() },
    async ({ sequence, clip, type }) => run("list_markers", { sequence, clip, type }, `
      const p = await getProject();
      const owner = args.clip ? ppro.ClipProjectItem.cast((await findItem(p, args.clip, ["clip"])).item) : await getSeq(p, args.sequence);
      let list = await listMarkers(owner);
      if (args.type) list = list.filter((m) => String(m.type).toLowerCase() === args.type.toLowerCase());
      return list;
    `));

  tool("ppro_remove_markers",
    "Remove markers from a sequence (default: active) by name and/or type, or all of them.",
    { sequence: z.string().optional(), name: z.string().optional(), type: z.string().optional(), all: z.boolean().optional() },
    async (a) => {
      if (!a.all && !a.name && !a.type) throw new Error("Pass name, type, or all=true");
      return run("remove_markers", a, `
        const p = await getProject();
        const s = await getSeq(p, args.sequence);
        const mk = await ppro.Markers.getMarkers(s);
        const targets = mk.getMarkers().filter((m) => args.all || ((!args.name || m.getName() === args.name) && (!args.type || String(m.getType()).toLowerCase() === args.type.toLowerCase())));
        tx(p, "Remove markers", () => targets.map((m) => mk.createRemoveMarkerAction(m)));
        return { removed: targets.length };
      `);
    });

  tool("ppro_youtube_chapters",
    "Turn chapter markers (or all markers) on a sequence into a YouTube chapters block ready for the description. YouTube needs the first chapter at 0:00 and at least 3 chapters of 10s+.",
    { sequence: z.string().optional(), include_all_marker_types: z.boolean().optional() },
    async ({ sequence, include_all_marker_types }) => {
      const markers = await run("list_markers_for_chapters", { sequence }, `
        const p = await getProject();
        return await listMarkers(await getSeq(p, args.sequence));
      `);
      const list = (Array.isArray(markers) ? markers : markers.result)
        .filter((m) => include_all_marker_types || String(m.type).toLowerCase() === "chapter")
        .sort((a, b) => a.start - b.start);
      const fmt = (s) => {
        s = Math.floor(s);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
      };
      const warnings = [];
      if (!list.length) warnings.push("No chapter markers found. Add some with ppro_add_markers type=chapter.");
      if (list.length && list[0].start > 0.5) warnings.push("First chapter is not at 0:00 - YouTube requires one.");
      if (list.length && list.length < 3) warnings.push("YouTube needs at least 3 chapters.");
      list.forEach((m, i) => { if (list[i + 1] && list[i + 1].start - m.start < 10) warnings.push(`'${m.name}' is shorter than 10s.`); });
      return { chapters: list.map((m) => `${fmt(m.start)} ${m.name}`).join("\n"), warnings };
    });

  tool("ppro_import_captions",
    "Import an SRT caption file into the project and try to place it on the sequence as a caption track starting at `start` seconds. If Premiere does not accept the placement through the API, the SRT stays in the project bin to drag onto the timeline.",
    { srt_path: z.string(), sequence: z.string().optional(), start: z.number().optional(), bin: z.string().optional() },
    async ({ srt_path, sequence, start = 0, bin = "Captions" }) => {
      if (!fs.existsSync(srt_path)) throw new Error("File not found: " + srt_path);
      return run("import_captions", { srt_path, sequence, start, bin }, `
        const p = await getProject();
        const s = await getSeq(p, args.sequence);
        const target = await findBin(p, args.bin, true);
        await p.importFiles([args.srt_path], true, target, false);
        const it = await findItem(p, args.srt_path);
        const before = await s.getCaptionTrackCount();
        let placed = false, error = null;
        try {
          const editor = ppro.SequenceEditor.getEditor(s);
          tx(p, "Place captions", () => editor.createOverwriteItemAction(it.item, T(args.start), 0, 0));
          placed = (await s.getCaptionTrackCount()) > before;
        } catch (e) { error = e.message; }
        return {
          imported: it.path,
          placedOnTimeline: placed,
          captionTracks: await s.getCaptionTrackCount(),
          note: placed ? "Caption track added." : "Imported to the bin. Drag it onto the timeline to create the caption track" + (error ? " (API placement failed: " + error + ")" : "") + ". Check V1 was not overwritten - undo once if it was.",
        };
      `);
    });

  tool("ppro_premiere_transcribe",
    "Use Premiere's own built-in Speech to Text on a clip (free, runs locally if the language pack is installed) and return the transcript JSON. Alternative to transcribe_media (Whisper).",
    { clip: z.string(), language: z.string().optional().describe("e.g. en-US, pt-PT"), save_to: z.string().optional() },
    async ({ clip, language, save_to }) => {
      const res = await run("premiere_transcribe", { clip, language }, `
        const p = await getProject();
        const it = await findItem(p, args.clip, ["clip"]);
        const c = ppro.ClipProjectItem.cast(it.item);
        if (!(await ppro.Transcript.hasTranscript(c))) {
          const ok = await ppro.Transcript.transcribeClipProjectItem(c, args.language ? { language: args.language } : undefined);
          if (!ok) throw new Error("Transcription failed. Check the language pack: Premiere > Settings > Transcription.");
        }
        return await ppro.Transcript.exportToJSON(c);
      `, { timeoutMs: 1800000 });
      const text = typeof res === "string" ? res : JSON.stringify(res);
      if (save_to) { fs.writeFileSync(save_to, text); return { saved: save_to, chars: text.length }; }
      return text.length > 60000 ? { note: "Large transcript, pass save_to to write it to disk", preview: text.slice(0, 60000) } : text;
    });

  tool("ppro_export_frame",
    "Export a still frame from a sequence (PNG/JPG/TIF etc.) at a time in seconds - useful for thumbnails.",
    {
      output_path: z.string().describe("Full path incl. file name, e.g. C:/exports/thumb.png"),
      time: z.number().optional().describe("Seconds. Default: playhead"),
      sequence: z.string().optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
    },
    async ({ output_path, time, sequence, width, height }) => {
      // Premiere's exportSequenceFrame needs a native folder path WITH a trailing separator, else it returns false.
      const dir = path.resolve(path.dirname(output_path)) + path.sep;
      fs.mkdirSync(dir, { recursive: true });
      return run("export_frame", { dir, file: path.basename(output_path), time, sequence, width, height }, `
        const p = await getProject();
        const s = await getSeq(p, args.sequence);
        const fs = await s.getFrameSize();
        const t = args.time === undefined || args.time === null ? await s.getPlayerPosition() : T(args.time);
        const ok = await ppro.Exporter.exportSequenceFrame(s, t, args.file, args.dir, args.width || fs.width, args.height || fs.height);
        return { ok, path: args.dir + args.file };
      `);
    });

  tool("ppro_find_export_presets",
    "Find Premiere / Media Encoder export presets (.epr) on this computer, including your own saved presets. Use the path with ppro_export_sequence.",
    { filter: z.string().optional().describe("Case-insensitive substring, e.g. 'youtube', 'h.264', '4k'") },
    async ({ filter }) => findPresets(filter));

  tool("ppro_export_sequence",
    "Export a sequence with an .epr preset. mode 'immediately' renders inside Premiere (blocks Premiere until done); 'ame' queues in Adobe Media Encoder and starts it. Use ppro_find_export_presets to get preset paths.",
    {
      output_path: z.string(),
      preset_path: z.string(),
      sequence: z.string().optional(),
      mode: z.enum(["immediately", "ame"]).optional(),
      in_out_only: z.boolean().optional().describe("Export only the sequence in/out range. Default false (full sequence)"),
    },
    async ({ output_path, preset_path, sequence, mode = "ame", in_out_only = false }) => {
      if (!fs.existsSync(preset_path)) throw new Error("Preset not found: " + preset_path);
      fs.mkdirSync(path.dirname(output_path), { recursive: true });
      return run("export_sequence", { output_path, preset_path, sequence, mode, in_out_only }, `
        const p = await getProject();
        const s = await getSeq(p, args.sequence);
        const em = await ppro.EncoderManager.getManager();
        const type = args.mode === "immediately" ? C.ExportType.IMMEDIATELY : C.ExportType.QUEUE_TO_AME;
        if (args.mode === "ame" && !em.isAMEInstalled) throw new Error("Adobe Media Encoder is not installed - use mode 'immediately'.");
        const ok = await em.exportSequence(s, type, args.output_path, args.preset_path, !args.in_out_only);
        if (args.mode === "ame") { try { await em.startBatchEncode(); } catch (e) { log("startBatchEncode: " + e.message); } }
        return { ok, sequence: s.name, output: args.output_path, mode: args.mode };
      `, { timeoutMs: mode === "immediately" ? 3600000 : 120000 });
    });

  tool("ppro_set_in_out",
    "Set the sequence in/out points (seconds), e.g. to export only a section.",
    { in_point: z.number(), out_point: z.number(), sequence: z.string().optional() },
    async ({ in_point, out_point, sequence }) => run("set_in_out", { in_point, out_point, sequence }, `
      const p = await getProject();
      const s = await getSeq(p, args.sequence);
      tx(p, "Set in/out", () => [s.createSetInPointAction(T(args.in_point)), s.createSetOutPointAction(T(args.out_point))]);
      return { in: args.in_point, out: args.out_point };
    `));

  registerPlanTools(server, bridge, { run, jsx, activate, tool });

  tool("ppro_save_project",
    "Save the open project.",
    {},
    async () => run("save", {}, `const p = await getProject(); return { saved: await p.save(), path: p.path };`));
}

function findPresets(filter) {
  const home = os.homedir();
  const roots = process.platform === "win32"
    ? [
        "C:/Program Files/Adobe",
        path.join(home, "Documents", "Adobe"),
        path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Adobe"),
      ]
    : [
        "/Applications",
        path.join(home, "Documents", "Adobe"),
        path.join(home, "Library", "Application Support", "Adobe"),
      ];
  const found = [];
  const seen = new Set();
  const want = filter ? filter.toLowerCase() : null;
  const walkDir = (dir, depth) => {
    if (depth > 9 || found.length > 400) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && process.platform !== "win32" && dir === "/Applications" && !/adobe/i.test(e.name)) continue;
        walkDir(full, depth + 1);
      } else if (e.name.toLowerCase().endsWith(".epr")) {
        if (seen.has(full)) continue;
        seen.add(full);
        if (!want || full.toLowerCase().includes(want)) found.push(full.replace(/\\/g, "/"));
      }
    }
  };
  for (const r of roots) walkDir(r, 0);
  return {
    count: found.length,
    presets: found.slice(0, 200),
    note: found.length ? "Your own presets saved from the Export dialog are usually under Documents/Adobe/Adobe Media Encoder/<version>/Presets." : "No .epr presets found. Save one from Premiere's Export panel (Preset > Save Preset) or Media Encoder.",
    searched: roots,
  };
}

export { findPresets };
