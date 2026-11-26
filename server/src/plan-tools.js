// Batch timeline tools: one MCP call does a whole edit step (place a cut list, layout, transitions, markers, nests, read
// back). Show-agnostic: everything show-specific (tracks, project item names, labels, transforms, nests, parking
// sequence) comes from plan.json "spec", written by the pipeline. Every tool reports its own wall-clock time (ms).
//
// plan.json: { fps, D, U, switches:[frame], clips:[{t:"V1".."A2", item, i, d, s, dis}], markers:[{name,start,dur,color}],
//              <nest keys>:{s,i,d}, audio_fades:[{t,frames}], spec:{...} }   (frames at fps; marker times in seconds)
// spec: { fps, speakers, names:{item key -> project item name}, labels, temp_labels, layout_tracks, audio_tracks,
//         clear_tracks, keep_markers, strip_audio_of, divider:{track,item}|null, layout_transition:{id,frames,alignment},
//         speaker_tracks, split_transforms:{track:[{comp:"motion"|"tN", param|param_index, value}]},
//         outro_slide:{frames,rest,down,up_from}|null, nests:[{key,name,track,audio_track,level_db}],
//         remove_before_nests:{names,tracks}, park_sequence|null, template_sequences }
// Track names: "V<n>" = video track n-1, "A<n>" = audio track n-1.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
export const trackOf = (name) => {
  const m = /^([VA])(\d+)$/.exec(String(name || ""));
  if (!m) throw new Error("Bad track name '" + name + "' (want V<n> or A<n>)");
  return { kind: m[1], i: Number(m[2]) - 1 };
};

// An episode config may keep "work" relative to a media root from local.json (next to the config or in a parent
// folder, or at $TQ_LOCAL; per show under "shows": {id: {media_root}}). Without one: the first parent folder where
// the path exists. Passing plan_file (absolute) avoids all of this.
function resolveWork(episodeFile, cfg) {
  const work = cfg.work;
  if (!work || path.isAbsolute(work)) return work;
  let local = process.env.TQ_LOCAL;
  for (let d = path.dirname(path.resolve(episodeFile)); !local; ) {
    if (fs.existsSync(path.join(d, "local.json"))) local = path.join(d, "local.json");
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  if (local) {
    try {
      const L = readJson(local); const show = cfg.show || cfg.show_id;
      const root = (show && L.shows && L.shows[show] && L.shows[show].media_root) || L.media_root;
      if (root) return path.join(root, work);
    } catch { /* fall through */ }
  }
  for (let d = path.dirname(path.resolve(episodeFile)); ; ) {
    if (fs.existsSync(path.join(d, work))) return path.join(d, work);
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  throw new Error("Can't resolve relative work dir '" + work + "': pass plan_file (absolute)");
}

// plan.json from plan_file, or <episode work dir>/plan.json. needSpec: the tool needs plan.spec.
export function loadPlan({ episode_file, plan_file }, needSpec = true) {
  let planPath = plan_file;
  if (!planPath && episode_file) { const cfg = readJson(episode_file); if (cfg.work) planPath = path.join(resolveWork(episode_file, cfg), "plan.json"); }
  if (!planPath) throw new Error("Pass plan_file (absolute path of plan.json) or episode_file");
  if (!fs.existsSync(planPath)) throw new Error("plan.json not found: " + planPath);
  const plan = readJson(planPath);
  const missing = ["fps", "clips"].filter((k) => !(k in plan));
  const bad = (plan.clips || []).find((c) => !["t", "item", "i", "d", "s"].every((k) => k in c));
  if (missing.length || bad) throw new Error("plan.json does not match what premiere-mcp expects (" + planPath + "): "
    + (missing.length ? "missing " + missing.join(", ") : "clip without t/item/i/d/s: " + JSON.stringify(bad)) + ". Update plan-tools.js together with the plan writer.");
  if (needSpec && !plan.spec) throw new Error("plan.json has no 'spec' (tracks, item names, layout of the show): rebuild it with the pipeline's make_plan (" + planPath + ")");
  return { plan, spec: plan.spec || {}, planPath };
}

// Divider pieces, one per layout run: a run starts at each clip start on the speaker tracks; the divider is enabled
// where two or more speaker clips are enabled (both hosts on screen), disabled otherwise; neighbouring runs with the
// same state merge. In-point = timeline frame, so every piece has material before and after it and centered
// transitions fit. Same runs as the old background-based rule on two real episodes.
export function dividerClips(plan, spec) {
  if (!spec.divider) return [];
  const tracks = spec.speaker_tracks || [];
  const at = {};
  for (const c of plan.clips) {
    if (!tracks.includes(c.t)) continue;
    const r = at[c.s] || (at[c.s] = { s: c.s, e: c.s + c.d, on: 0 });
    if (!c.dis) r.on++;
  }
  const m = [];
  for (const k of Object.keys(at).map(Number).sort((a, b) => a - b)) {
    const r = at[k], both = r.on >= 2, L = m[m.length - 1];
    if (L && L.both === both && L.e === r.s) L.e = r.e; else m.push({ s: r.s, e: r.e, both });
  }
  return m.map((r) => ({ t: spec.divider.track, item: spec.divider.item, i: r.s, d: r.e - r.s, s: r.s, dis: !r.both }));
}

// Body shared by the UXP scripts: frame-exact TickTime, refetch helpers.
const COMMON = `
const TPS = 254016000000;
const FPS = args.fps || 30;
const FT = (f) => ppro.TickTime.createWithTicks(String(Math.round(f) * (TPS / FPS)));
const FR = (t) => Math.round(secs(t) * FPS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stale = (e) => /no longer valid|locked access/i.test(String(e && e.message));
// Commit actions in their own lock (an action must be created and committed inside the same lockedAccess).
function commit(p, label, build) {
  let ok = false;
  p.lockedAccess(() => { const a = [].concat(build() || []).filter(Boolean); if (!a.length) { ok = true; return; } ok = p.executeTransaction((ca) => { for (const x of a) ca.addAction(x); }, label); });
  if (!ok) throw new Error("Premiere rejected: " + label);
}
async function trackItems(seq, kind, i) { return (await (kind === "V" ? seq.getVideoTrack(i) : seq.getAudioTrack(i))).getTrackItems(C.TrackItemType.CLIP, false); }
// After a big edit Premiere keeps invalidating script objects for a while; anything read across awaits can be
// stale by the time it is committed. Retry on "no longer valid" with a growing wait.
async function retrying(fn, tries = 12) {
  for (let a = 0; ; a++) {
    try { return await fn(a); } catch (e) { if (!stale(e) || a >= tries - 1) throw e; await sleep(250 * (a + 1)); }
  }
}
// Commit actions on track items picked by POSITION on their track ({kind:"V"|"A", track, index, act: (ti) => action}).
// The items are re-read inside the lock, right before the commit, so no await sits in between.
async function commitPicks(label, picks) {
  if (!picks.length) return 0;
  return retrying(async () => {
    const p = await getProject(); const seq = await getSeq(p, args.sequence);
    const tracks = {};
    for (const k of new Set(picks.map((x) => x.kind + ":" + x.track))) { const [kind, i] = k.split(":"); tracks[k] = await (kind === "V" ? seq.getVideoTrack(+i) : seq.getAudioTrack(+i)); }
    const made = []; for (const x of picks) made.push(x.prep ? await x.prep() : null);   // async objects (transitions) before the lock
    let ok = false;
    p.lockedAccess(() => {
      const lists = {}; for (const k in tracks) lists[k] = tracks[k].getTrackItems(C.TrackItemType.CLIP, false);
      ok = p.executeTransaction((ca) => { picks.forEach((x, n) => ca.addAction(x.act(lists[x.kind + ":" + x.track][x.index], made[n]))); }, label);
    });
    if (!ok) throw new Error("Premiere rejected: " + label);
    return picks.length;
  });
}
// Remove track items picked by position ({kind, track, index}); re-read inside the lock like commitPicks.
// An empty selection is never sent (Premiere throws on it).
async function removePicks(label, picks, mediaType) {
  if (!picks.length) return 0;
  return retrying(async () => {
    const p = await getProject(); const seq = await getSeq(p, args.sequence); const ed = ppro.SequenceEditor.getEditor(seq);
    const tracks = {};
    for (const k of new Set(picks.map((x) => x.kind + ":" + x.track))) { const [kind, i] = k.split(":"); tracks[k] = await (kind === "V" ? seq.getVideoTrack(+i) : seq.getAudioTrack(+i)); }
    let ok = false;
    ppro.TrackItemSelection.createEmptySelection((sel) => {
      p.lockedAccess(() => {
        const lists = {}; for (const k in tracks) lists[k] = tracks[k].getTrackItems(C.TrackItemType.CLIP, false);
        for (const x of picks) sel.addItem(lists[x.kind + ":" + x.track][x.index]);
        ok = p.executeTransaction((ca) => ca.addAction(ed.createRemoveItemsAction(sel, false, mediaType, false)), label);
      });
    });
    if (!ok) throw new Error("Premiere rejected: " + label);
    return picks.length;
  });
}
`;

// QE: every named transition per track, frames at fps. kind "V" or "A". Needs the sequence active.
const qeTransitions = (sequence, kind, fps) => `tqRun(function(){
  var q = tqActiveQESeq(${JSON.stringify(sequence)}); var out = [];
  var n = ${kind === "V" ? "q.numVideoTracks" : "q.numAudioTracks"};
  for (var t = 0; t < n; t++) { var tr = ${kind === "V" ? "q.getVideoTrackAt(t)" : "q.getAudioTrackAt(t)"}; var l = [];
    for (var x = 0; x < tr.numTransitions; x++) { var it = tr.getTransitionAt(x); if (String(it.name) === "") continue;
      l.push({ name: String(it.name), s: Math.round(tqSecs(it.start) * ${fps}), e: Math.round(tqSecs(it.end) * ${fps}) }); }
    out.push(l); }
  return out; })`;

const planArgs = {
  plan_file: z.string().optional().describe("Absolute path of plan.json (preferred)"),
  episode_file: z.string().optional().describe("Episode config whose work dir holds plan.json (alternative to plan_file)"),
};

export function registerPlanTools(server, bridge, { run, jsx, activate, tool }) {
  // While Premiere redraws timelines (several long sequences open as tabs, or a long nest in front) UXP script
  // objects go stale between reading and committing, even inside one lock; hammering that crashed Premiere once
  // (2026-11-26). Every commit re-reads and retries (commitPicks/removePicks/retrying), and the edit runs with another
  // sequence in front (spec.park_sequence, ideally an empty one; never one of spec.template_sequences): put it in
  // front, edit, bring the target back, close the parking tab.
  const parked = async (sequence, spec, fn) => {
    const other = await run("park", { sequence, park: spec.park_sequence || null, avoid: spec.template_sequences || [] }, `
      const p = await getProject(); const a = await p.getActiveSequence();
      if (!a || a.name !== args.sequence) return null;
      const all = await p.getSequences();
      const o = (args.park && all.find((x) => x.name === args.park)) || all.find((x) => x.name !== args.sequence && !args.avoid.includes(x.name));
      if (!o) return null;
      await p.openSequence(o); await p.setActiveSequence(o);
      return o.name;`);
    try {
      const r = await fn();
      return other && r && typeof r === "object" ? { ...r, parked_on: other } : r;
    } finally {
      if (other) {
        await activate(sequence);
        // close the parking tab again so tabs don't pile up (ExtendScript; skipped without the CEP helper)
        try { await jsx("close_park", `tqRun(function(){ var s = app.project.sequences; for (var i = 0; i < s.numSequences; i++) if (s[i].name === ${JSON.stringify(other)}) return s[i].close(); return false; })`, { timeoutMs: 30000 }); } catch { /* ignore */ }
      }
    }
  };

  // ---------------------------------------------------------------- place
  tool("ppro_place_from_plan",
    "Lay a whole edit from plan.json in ONE call: clear the plan's tracks (spec.clear_tracks + the divider track), place every clip frame-exact (label colours from spec.labels / spec.temp_labels), the divider pieces (spec.divider: one piece of that nest per layout run, enabled where two or more speakers are on screen), strip the audio that nested items bring along, set each clip's enabled/disabled flag, then check every clip against the plan (ok:true, mismatches:[]). Run it only on a sequence that may be overwritten (or a duplicate).",
    {
      sequence: z.string().describe("Target sequence name"),
      ...planArgs,
      names: z.record(z.string(), z.string()).optional().describe("Override plan item key -> project item name (default spec.names)"),
      clear: z.boolean().optional().describe("Remove existing clips on the plan's tracks first. Default true"),
      divider: z.boolean().optional().describe("Place the divider pieces (clears that track first). Default true when spec.divider is set; false leaves that track alone"),
      timeout_seconds: z.number().optional().describe("Default 900"),
    },
    async (a) => {
      const { plan, spec, planPath } = loadPlan(a);
      const names = { ...(spec.names || {}), ...(a.names || {}) };
      // divider first: a nest placed after the dialogue could overwrite the dialogue track with its (empty) audio
      const div = a.divider === false ? [] : dividerClips(plan, spec);
      const clips = [...div, ...plan.clips];
      const missing = [...new Set(clips.map((c) => c.item))].filter((k) => !names[k]);
      if (missing.length) throw new Error("No project item name for plan items: " + missing.join(", ") + " (spec.names or names)");
      const clear = [...new Set([...(spec.clear_tracks || []), ...(div.length ? [spec.divider.track] : [])])];
      const r = await parked(a.sequence, spec, () => run("place_from_plan", {
        sequence: a.sequence, clips, names, fps: plan.fps || spec.fps || 30, clear: a.clear !== false ? clear : [],
        labels: spec.labels || {}, temp_labels: spec.temp_labels || {}, strip: (spec.strip_audio_of || []).map((k) => names[k] || k),
        divider_item: div.length ? spec.divider.item : null,
      }, COMMON + PLACE_BODY, { timeoutMs: (a.timeout_seconds || 900) * 1000 }));
      return { plan: planPath, ...r };
    });

  // ---------------------------------------------------------------- layout
  tool("ppro_set_layout",
    "Layout pass on a placed edit in ONE call: enabled/disabled flag per clip on spec.layout_tracks (+ divider track), the split transforms of spec.split_transforms (Motion params and appended Transform effects) and the outro slide of spec.outro_slide (an extra Transform on spec.speaker_tracks clips between plan.D and plan.U). Clips that already carry extra effects are left alone, so it can be rerun.",
    {
      sequence: z.string(),
      ...planArgs,
      timeout_seconds: z.number().optional().describe("Default 300"),
    },
    async (a) => {
      const { plan, spec, planPath } = loadPlan(a);
      if (spec.outro_slide && (typeof plan.D !== "number" || typeof plan.U !== "number")) throw new Error("spec.outro_slide is set but plan.json has no D/U frames");
      const layout = [...new Set([...(spec.layout_tracks || []), ...(spec.divider ? [spec.divider.track] : [])])];
      const r = await parked(a.sequence, spec, () => run("set_layout", {
        sequence: a.sequence, clips: [...dividerClips(plan, spec), ...plan.clips].filter((c) => layout.includes(c.t)), layout,
        speaker_tracks: spec.speaker_tracks || [], split: spec.split_transforms || {}, slide: spec.outro_slide || null,
        D: plan.D, U: plan.U, fps: plan.fps || spec.fps || 30,
      }, COMMON + LAYOUT_BODY, { timeoutMs: (a.timeout_seconds || 300) * 1000 }));
      return { plan: planPath, ...r };
    });

  // ---------------------------------------------------------------- video transitions
  tool("ppro_add_video_transitions",
    "Add a video transition at many edit points on many video tracks in ONE call. At each frame given, the clip ENDING there gets the transition (centered by default, so it spans the cut). Edges that already have a video transition are skipped. With plan_file/episode_file: plan.switches on spec.layout_tracks (+ divider track) with spec.layout_transition, unless given here.",
    {
      sequence: z.string(),
      tracks: z.array(z.number().int().min(1)).optional().describe("Video tracks, 1-based. Default from the plan spec"),
      at_frames: z.array(z.number().int()).optional().describe("Timeline frames (at fps) of the edits"),
      at_seconds: z.array(z.number()).optional().describe("Edit times in seconds (snapped to frames)"),
      ...planArgs,
      match_name: z.string().optional().describe("Video transition match name (e.g. AE.ADBE Cross Dissolve New). Default spec.layout_transition.id"),
      frames: z.number().int().min(1).optional().describe("Duration. Default spec.layout_transition.frames, else 10"),
      alignment: z.number().min(0).max(1).optional().describe("0.5 = centered on the cut (default)"),
      fps: z.number().optional().describe("Frame rate of at_frames. Default plan fps or 30"),
    },
    async (a) => {
      let at = a.at_frames, fps = a.fps || 30, spec = {};
      if (a.plan_file || a.episode_file) { const L = loadPlan(a, false); spec = L.spec; fps = a.fps || L.plan.fps || 30; if (!at && !a.at_seconds) at = L.plan.switches; }
      if (!at && a.at_seconds) at = a.at_seconds.map((s) => Math.round(s * fps));
      if (!at || !at.length) throw new Error("No edit points (at_frames, at_seconds or plan switches)");
      const lt = spec.layout_transition || {};
      const tracks = a.tracks ? a.tracks.map((t) => t - 1)
        : [...new Set([...(spec.layout_tracks || []), ...(spec.divider ? [spec.divider.track] : [])])].map((t) => trackOf(t)).filter((t) => t.kind === "V").map((t) => t.i);
      const match = a.match_name || lt.id;
      if (!tracks.length) throw new Error("No tracks (tracks, or spec.layout_tracks in the plan)");
      if (!match) throw new Error("No transition (match_name, or spec.layout_transition.id in the plan)");
      // UXP can't read transitions (getTrackItems(TRANSITION) gives nulls): ask QE which edges already have one.
      let busy = null, note;
      try { await activate(a.sequence); busy = await jsx("video_transitions_read", qeTransitions(a.sequence, "V", fps), { timeoutMs: 120000 }); }
      catch (e) { note = "existing transitions not checked (CEP helper: " + String(e.message).slice(0, 120) + ")"; }
      const r = await parked(a.sequence, spec, () => run("add_video_transitions", {
        sequence: a.sequence, tracks, at, fps, busy, match, frames: a.frames || lt.frames || 10, align: a.alignment ?? lt.alignment ?? 0.5,
      }, COMMON + VTRANS_BODY, { timeoutMs: 300000 }));
      return note ? { ...r, note } : r;
    });

  // ---------------------------------------------------------------- markers
  tool("ppro_set_markers_from_json",
    "Put a whole marker list on a sequence in ONE call (names, start, duration, color, type), frame-snapped. Source: plan.json markers (plan_file/episode_file), a JSON file, or an inline list. replace=true (default) first removes the existing sequence markers except the names in keep (default spec.keep_markers).",
    {
      sequence: z.string(),
      ...planArgs,
      markers_file: z.string().optional().describe("JSON: [{name,start,dur?,color?,type?,comment?}] or {markers:[...]}"),
      markers: z.array(z.object({
        name: z.string(), start: z.number(), dur: z.number().optional(), color: z.number().int().min(0).max(7).optional(),
        type: z.string().optional(), comment: z.string().optional(),
      })).optional(),
      replace: z.boolean().optional().describe("Default true"),
      keep: z.array(z.string()).optional().describe("Marker names never removed. Default spec.keep_markers, else none"),
      fps: z.number().optional().describe("Snap grid. Default plan fps or 30"),
    },
    async (a) => {
      let list = a.markers, fps = a.fps || 30, spec = {};
      if (a.plan_file || a.episode_file) { const L = loadPlan(a, false); spec = L.spec; fps = a.fps || L.plan.fps || 30; if (!list && !a.markers_file) list = L.plan.markers; }
      if (!list && a.markers_file) { const j = readJson(a.markers_file); list = Array.isArray(j) ? j : j.markers; }
      if (!Array.isArray(list)) throw new Error("No markers found");
      return parked(a.sequence, spec, () => run("set_markers", { sequence: a.sequence, markers: list, fps, replace: a.replace !== false, keep: a.keep || spec.keep_markers || [] }, COMMON + MARKERS_BODY));
    });

  // ---------------------------------------------------------------- nests (intro / outro ...)
  tool("ppro_place_intro_outro",
    "Place the plan's nested sequences (spec.nests: e.g. intro and outro) in ONE call: first remove spec.remove_before_nests (old shell items and earlier nest instances on those tracks), then for each nest place that sequence trimmed to plan[key] = {s,i,d} on its video track (audio on its audio_track), then set its audio level (level_db, through the CEP helper).",
    {
      sequence: z.string(),
      ...planArgs,
      nest_level_db: z.number().optional().describe("Override every nest's level_db"),
    },
    async (a) => {
      const { plan, spec } = loadPlan(a);
      const nests = (spec.nests || []).filter((n) => plan[n.key]).map((n) => {
        const v = trackOf(n.track), au = n.audio_track ? trackOf(n.audio_track) : { i: 0 };
        return { ...n, ...plan[n.key], vi: v.i, ai: au.i };
      });
      if (!nests.length) throw new Error("No nests to place (spec.nests with plan keys)");
      const rb = spec.remove_before_nests || { names: [], tracks: [] };
      const t0 = Date.now();
      const placed = await parked(a.sequence, spec, () => run("place_nests", {
        sequence: a.sequence, nests, fps: plan.fps || spec.fps || 30, remove_names: rb.names || [], remove_tracks: (rb.tracks || []).map(trackOf),
      }, COMMON + NESTS_BODY));
      const levels = {};
      for (const n of nests) { const db = a.nest_level_db ?? n.level_db; if (db !== undefined && db !== null) levels[n.name] = db; }
      let level_set = [];
      if (Object.keys(levels).length) level_set = await jsx("nest_levels", `tqRun(function(){
        var L = ${JSON.stringify(levels)};
        var seqs = app.project.sequences, s = null; for (var i = 0; i < seqs.numSequences; i++) if (seqs[i].name === ${JSON.stringify(a.sequence)}) s = seqs[i];
        if (!s) throw new Error("sequence not found");
        var done = [];
        for (var t = 0; t < s.audioTracks.numTracks; t++) { var cl = s.audioTracks[t].clips;
          for (var k = 0; k < cl.numItems; k++) { var c = cl[k]; if (!L.hasOwnProperty(c.name)) continue;
            var lv = Math.pow(10, (L[c.name] - 15) / 20);   // legacy DOM audio Level scale (0 dB = 0.17783)
            for (var m = 0; m < c.components.numItems; m++) { var comp = c.components[m]; if (comp.displayName !== "Volume") continue;
              for (var q = 0; q < comp.properties.numItems; q++) if (comp.properties[q].displayName === "Level") { comp.properties[q].setValue(lv, true); done.push("A" + (t + 1) + " " + c.name + " " + L[c.name] + " dB"); } } } }
        return done; })`);
      return { ...placed, level_set, ms_total: Date.now() - t0 };
    });

  // ---------------------------------------------------------------- read
  tool("ppro_read_timeline",
    "Read a sequence in ONE call: every clip on every (or the given) track with start/end/source in-out in frames, name, disabled; optionally effects with parameter values and keyframes, video + audio transitions (read through QE: needs the CEP helper and makes the sequence active) and markers. Write it to out_file for big sequences. Use it to verify a placement or to diff against an editor's timeline.",
    {
      sequence: z.string(),
      video_tracks: z.array(z.number().int().min(1)).optional().describe("1-based. Default all"),
      audio_tracks: z.array(z.number().int().min(1)).optional().describe("1-based. Default all"),
      effects: z.boolean().optional().describe("Include component chains (match name + param values). Default false"),
      keyframes: z.boolean().optional().describe("With effects: include keyframes of time-varying params. Default false"),
      transitions: z.boolean().optional().describe("Video and audio transitions (QE). Default false"),
      markers: z.boolean().optional().describe("Default true"),
      fps: z.number().optional().describe("Frame grid for the frame numbers. Default 30"),
      out_file: z.string().optional().describe("Write the full JSON here and return only a summary"),
      timeout_seconds: z.number().optional().describe("Default 300"),
    },
    async (a) => {
      const r = await run("read_timeline", {
        sequence: a.sequence, v: a.video_tracks && a.video_tracks.map((t) => t - 1), a: a.audio_tracks && a.audio_tracks.map((t) => t - 1),
        effects: !!a.effects, keyframes: !!a.keyframes, transitions: !!a.transitions, markers: a.markers !== false, fps: a.fps || 30,
      }, COMMON + READ_BODY, { timeoutMs: (a.timeout_seconds || 300) * 1000 });
      if (a.transitions) {
        await activate(a.sequence);
        const fps = a.fps || 30;
        const vt = await jsx("read_video_transitions", qeTransitions(a.sequence, "V", fps), { timeoutMs: 300000 });
        const at = await jsx("read_audio_transitions", qeTransitions(a.sequence, "A", fps), { timeoutMs: 300000 });
        r.video.forEach((tr) => { tr.transitions = vt[tr.index] || []; });
        r.audio.forEach((tr) => { tr.transitions = at[tr.index] || []; });
      }
      if (a.out_file) {
        fs.mkdirSync(path.dirname(a.out_file), { recursive: true });
        fs.writeFileSync(a.out_file, JSON.stringify(r, null, 1));
        const sum = (l) => l.map((t) => ({ track: t.track, clips: t.clips.length, ...(t.transitions ? { transitions: t.transitions.length } : {}) }));
        return { out_file: a.out_file, sequence: r.sequence, video: sum(r.video), audio: sum(r.audio), markers: r.markers ? r.markers.length : undefined, ms: r.ms };
      }
      return r;
    });
}

// ===================================================================== UXP bodies

const TRACKS_JS = String.raw`
const TRK = (t) => { const m = /^([VA])(\d+)$/.exec(t); if (!m) throw new Error("bad track " + t); return { kind: m[1], i: Number(m[2]) - 1 }; };
const VAI = (t) => { const x = TRK(t); return x.kind === "V" ? [x.i, 0] : [0, x.i]; };   // overwrite targets: video idx, audio idx
`;

const PLACE_BODY = TRACKS_JS + String.raw`
const T0 = Date.now(); const ms = {};
const LAB = args.labels || {};          // item label set before placing and kept
const TEMP = args.temp_labels || {};    // shared items: set while placing, then restored
let clips = args.clips;
let p, seq, ed, items;
async function fresh() {
  p = await getProject(); seq = await getSeq(p, args.sequence); ed = ppro.SequenceEditor.getEditor(seq);
  const { items: all } = await walk(p); items = {};
  for (const k in args.names) {
    const f = all.find((x) => x.name === args.names[k] && (x.kind === "clip" || x.kind === "sequence"));
    if (f) items[k] = { raw: f.item, kind: f.kind };
  }
}
await fresh();
let divider = args.divider_item ? "placed" : "not requested";
let clearTracks = args.clear;
if (args.divider_item && !items[args.divider_item]) {
  divider = "skipped: '" + args.names[args.divider_item] + "' not in project";
  const dt = new Set(clips.filter((c) => c.item === args.divider_item).map((c) => c.t));
  clips = clips.filter((c) => c.item !== args.divider_item);
  clearTracks = clearTracks.filter((t) => !dt.has(t) || clips.some((c) => c.t === t));   // leave the divider track alone
}
const need = [...new Set(clips.map((c) => c.item))].filter((k) => !items[k]);
if (need.length) throw new Error("Project items not found: " + need.map((k) => args.names[k]).join(", "));

// 1. clear the plan's tracks
let cleared = 0;
if (clearTracks.length) {
  const picks = [];
  for (const t of clearTracks) { const x = TRK(t); const n = (await trackItems(seq, x.kind, x.i)).length; for (let j = 0; j < n; j++) picks.push({ kind: x.kind, track: x.i, index: j }); }
  cleared = await removePicks("Plan: clear", picks, C.MediaType.ANY);
  await fresh();
}
ms.clear = Date.now() - T0;

// 2. labels (instance label = project item label at placement time)
const orig = {};
for (const k in TEMP) if (items[k]) orig[k] = await ppro.ClipProjectItem.cast(items[k].raw).getColorLabelIndex();
await retrying(async (a) => { if (a) await fresh(); commit(p, "Plan: labels", () => [
  ...Object.keys(LAB).filter((k) => items[k]).map((k) => ppro.ClipProjectItem.cast(items[k].raw).createSetColorLabelAction(LAB[k])),
  ...Object.keys(TEMP).filter((k) => items[k]).map((k) => ppro.ClipProjectItem.cast(items[k].raw).createSetColorLabelAction(TEMP[k])),
]); });

// 3. place: in/out + overwrite per clip, all inside one lockedAccess. The overwrite takes the item's in/out at the
// moment it runs, so in/out and overwrite can't share a transaction. Script objects go stale now and then
// ("no longer valid"): stop, refetch, resume at the same clip.
const t3 = Date.now();
let k = 0, retries = 0; const errs = [];
while (k < clips.length) {
  let err = null;
  p.lockedAccess(() => {
    while (k < clips.length) {
      const c = clips[k]; const it = items[c.item]; const [vi, ai] = VAI(c.t);
      try {
        if (!p.executeTransaction((ca) => ca.addAction(ppro.ClipProjectItem.cast(it.raw).createSetInOutPointsAction(FT(c.i), FT(c.i + c.d))), "Plan: in/out")) throw new Error("in/out rejected");
        if (!p.executeTransaction((ca) => ca.addAction(ed.createOverwriteItemAction(it.raw, FT(c.s), vi, ai)), "Plan: place")) throw new Error("overwrite rejected");
        k++;
      } catch (e) { err = e; return; }
    }
  });
  if (err) {
    errs.push(k + ": " + err.message.split("\n")[0]);
    if (++retries > 50) throw new Error("Placement keeps failing at clip " + k + ": " + errs.slice(-3).join(" | "));
    await sleep(stale(err) ? 50 : 200); await fresh();
  }
}
ms.place = Date.now() - t3;

// 4. restore item in/out and shared labels
await retrying(async () => { await fresh(); commit(p, "Plan: restore items", () => [
  ...Object.keys(items).map((k) => ppro.ClipProjectItem.cast(items[k].raw).createClearInOutPointsAction()),
  ...Object.keys(orig).map((k) => ppro.ClipProjectItem.cast(items[k].raw).createSetColorLabelAction(orig[k])),
]); });

// 5. strip the audio that nested items bring onto the audio tracks (spec.strip_audio_of + every sequence placed on video)
const t5 = Date.now();
const nestNames = new Set([...(args.strip || []),
  ...Object.keys(items).filter((k) => items[k].kind === "sequence" && clips.some((c) => c.item === k && c.t[0] === "V")).map((k) => args.names[k])]);
let stripped = 0;
if (nestNames.size) {
  let rm = [];
  await retrying(async () => {
    seq = await getSeq(await getProject(), args.sequence); rm = [];
    const nA = await seq.getAudioTrackCount();
    for (let i = 0; i < nA; i++) { const its = await trackItems(seq, "A", i); for (let x = 0; x < its.length; x++) if (nestNames.has(await its[x].getName())) rm.push({ kind: "A", track: i, index: x }); }
  });
  stripped = await removePicks("Plan: strip nest audio", rm, C.MediaType.AUDIO);
}
ms.strip = Date.now() - t5;

// 6. enabled/disabled flags + check every clip against the plan (flags committed by position, see commitPicks).
const t6 = Date.now();
const STILL = /\.(png|jpe?g|tiff?|psd|gif|bmp)$/i;
const want = {}; for (const c of clips) (want[c.t] = want[c.t] || {})[c.s] = c;
let toggle = [], check = {}, bad = [];
await retrying(async () => {
  p = await getProject(); seq = await getSeq(p, args.sequence);
  toggle = []; check = {}; bad = [];
  for (const t of Object.keys(want)) {
    const x = TRK(t); const its = await trackItems(seq, x.kind, x.i);
    let hit = 0;
    for (let n = 0; n < its.length; n++) {
      const ti = its[n];
      const s = FR(await ti.getStartTime()); const c = want[t][s];
      if (!c) { if (bad.length < 20) bad.push({ t, s, why: "not in plan" }); continue; }
      if (x.kind === "V" && c.dis !== undefined && (await ti.isDisabled()) !== !!c.dis) toggle.push({ kind: "V", track: x.i, index: n, d: !!c.dis });
      // stills (png/jpg) report an arbitrary source in-point (108000 on 26.5): check only their timeline range
      const still = STILL.test(args.names[c.item] || "");
      const e = FR(await ti.getEndTime()), i = still ? c.i : FR(await ti.getInPoint());
      if (e !== c.s + c.d || i !== c.i) { if (bad.length < 20) bad.push({ t, s, end: e, in: i, want_end: c.s + c.d, want_in: c.i }); continue; }
      hit++;
    }
    check[t] = { plan: Object.keys(want[t]).length, timeline: its.length, match: hit };
  }
});
await commitPicks("Plan: layout flags", toggle.map((x) => ({ ...x, act: (ti) => ti.createSetDisabledAction(x.d) })));
ms.flags_and_check = Date.now() - t6;
const ok = Object.values(check).every((x) => x.plan === x.match && x.timeline === x.plan);
return { ok, sequence: args.sequence, divider, placed: k, total: clips.length, cleared, stripped_nest_audio: stripped, toggled: toggle.length, check, mismatches: bad, retries, errors: errs.slice(0, 5), ms: { ...ms, total: Date.now() - T0 } };
`;

const LAYOUT_BODY = TRACKS_JS + String.raw`
const T0 = Date.now();
const D = args.D, U = args.U, S = args.slide, SPK = new Set(args.speaker_tracks), SPLIT = args.split || {};
let p = await getProject(); let seq = await getSeq(p, args.sequence);
// 1. enabled/disabled flags on the layout tracks
const want = {}; for (const c of args.clips) (want[c.t] = want[c.t] || {})[c.s] = c;
let toggle = [], unmatched = {};
await retrying(async () => {
  seq = await getSeq(await getProject(), args.sequence); toggle = []; unmatched = {};
  for (const t in want) { const x = TRK(t); let m = 0; const its = await trackItems(seq, "V", x.i);
    for (let n = 0; n < its.length; n++) { const c = want[t][FR(await its[n].getStartTime())]; if (!c) continue; m++; if ((await its[n].isDisabled()) !== !!c.dis) toggle.push({ kind: "V", track: x.i, index: n, d: !!c.dis }); }
    if (m !== Object.keys(want[t]).length) unmatched[t] = Object.keys(want[t]).length - m; }
});
await commitPicks("Plan: layout flags", toggle.map((x) => ({ ...x, act: (ti) => ti.createSetDisabledAction(x.d) })));
// 2. append Transform effects: the outro slide one first (speaker tracks, clips starting in [D, U]), then the split ones
// ("tN" in spec.split_transforms -> N+1 Transforms on that track). A chain with more than Opacity+Motion already got
// its effects (rerun): skip it.
const nSplit = (t) => { let n = 0; for (const op of SPLIT[t] || []) { const m = /^t(\d+)$/.exec(op.comp || ""); if (m) n = Math.max(n, Number(m[1]) + 1); } return n; };
const tracks = [...new Set([...SPK, ...Object.keys(SPLIT)])];
const inSlide = (t, f) => !!S && SPK.has(t) && f >= D && f <= U;
let adds = [], skipped = 0; const fresh = new Set();
await retrying(async () => {
  p = await getProject(); seq = await getSeq(p, args.sequence);
  adds = []; skipped = 0; fresh.clear();
  for (const t of tracks) { const x = TRK(t); for (const ti of await trackItems(seq, "V", x.i)) {
    const f = FR(await ti.getStartTime()); const count = (inSlide(t, f) ? 1 : 0) + nSplit(t);
    if (!count) continue;
    const ch = await ti.getComponentChain(); if (ch.getComponentCount() > 2) { skipped++; continue; }
    fresh.add(t + ":" + f);
    for (let j = 0; j < count; j++) adds.push([ch, await ppro.VideoFilterFactory.createComponent("AE.ADBE Geometry2")]);
  } }
  let okA = true;
  if (adds.length) p.lockedAccess(() => { okA = p.executeTransaction((ca) => { for (const [ch, c] of adds) ca.addAction(ch.createAppendComponentAction(c)); }, "Plan: transforms"); });
  if (!okA) throw new Error("Premiere rejected the transforms");
});
// 3. values (only on chains that got their effects in this run)
const PF = (v) => new ppro.PointF(v[0], v[1]);
const val = (v) => (Array.isArray(v) ? PF(v) : v);
const prm = (c, op) => { if (op.param === undefined) return c.getParam(op.param_index); for (let j = 0; j < c.getParamCount(); j++) if (c.getParam(j).displayName === op.param) return c.getParam(j); throw new Error("param " + op.param); };
let rows = [];
await retrying(async () => {
  p = await getProject(); seq = await getSeq(p, args.sequence);
  rows = [];
  for (const t of tracks) { const x = TRK(t); for (const ti of await trackItems(seq, "V", x.i)) {
    const f = FR(await ti.getStartTime()); if (!fresh.has(t + ":" + f)) continue;
    const slide = inSlide(t, f), ch = await ti.getComponentChain();
    if (ch.getComponentCount() !== 2 + (slide ? 1 : 0) + nSplit(t)) continue;
    rows.push({ ch, t, f, slide, fin: FR(await ti.getInPoint()) });
  } }
  let ok = !rows.length;
  if (rows.length) p.lockedAccess(() => { ok = p.executeTransaction((ca) => {
    const set = (pr, v) => ca.addAction(pr.createSetValueAction(pr.createKeyframe(val(v)), true));
    for (const r of rows) { const ch = r.ch; let idx = 2;
      if (r.slide) { const pos = prm(ch.getComponentAtIndex(idx++), { param: "Position" });
        const kf = (fr, v) => { const k = pos.createKeyframe(PF(v)); k.position = FT(fr); return k; };
        if (r.f === D) { ca.addAction(pos.createSetTimeVaryingAction(true)); ca.addAction(pos.createAddKeyframeAction(kf(r.fin, S.rest))); ca.addAction(pos.createAddKeyframeAction(kf(r.fin + S.frames, S.down))); }
        else if (r.f === U) { ca.addAction(pos.createSetTimeVaryingAction(true)); ca.addAction(pos.createAddKeyframeAction(kf(r.fin, S.up_from))); ca.addAction(pos.createAddKeyframeAction(kf(r.fin + S.frames, S.rest))); }
        else set(pos, S.down); }
      for (const op of SPLIT[r.t] || []) {
        const m = /^t(\d+)$/.exec(op.comp || ""), comp = op.comp === "motion" ? ch.getComponentAtIndex(1) : ch.getComponentAtIndex(idx + Number(m[1]));
        set(prm(comp, op), op.value);
      } }
  }, "Plan: transform values"); });
  if (!ok) throw new Error("Premiere rejected the transform values");
});
return { sequence: args.sequence, toggled: toggle.length, unmatched, appended: adds.length, valued_clips: rows.length, skipped_already_done: skipped, ms: Date.now() - T0 };
`;

const NESTS_BODY = String.raw`
const T0 = Date.now();
const REMOVE = new Set(args.remove_names || []);
let old = [];
await retrying(async () => {
  const seq = await getSeq(await getProject(), args.sequence); old = [];
  for (const tr of args.remove_tracks || []) { const its = await trackItems(seq, tr.kind, tr.i); for (let x = 0; x < its.length; x++) if (REMOVE.has(await its[x].getName())) old.push({ kind: tr.kind, track: tr.i, index: x }); }
});
const removed = await removePicks("Plan: remove old nests", old, C.MediaType.ANY);
const placed = [];
for (const n of args.nests) {
  await retrying(async () => {
    const p = await getProject(); const seq = await getSeq(p, args.sequence); const ed = ppro.SequenceEditor.getEditor(seq);
    const { items } = await walk(p);
    const f = items.find((x) => x.name === n.name && x.kind === "sequence"); if (!f) throw new Error(n.name + " not in project");
    let ok = true;
    p.lockedAccess(() => {
      ok = p.executeTransaction((ca) => ca.addAction(ppro.ClipProjectItem.cast(f.item).createSetInOutPointsAction(FT(n.i), FT(n.i + n.d))), "io")
        && p.executeTransaction((ca) => ca.addAction(ed.createOverwriteItemAction(f.item, FT(n.s), n.vi, n.ai)), "Plan: place " + n.name)
        && p.executeTransaction((ca) => ca.addAction(ppro.ClipProjectItem.cast(f.item).createClearInOutPointsAction()), "clear io");
    });
    if (!ok) throw new Error("Premiere rejected placing " + n.name);
  });
  placed.push({ name: n.name, start: n.s / FPS, dur: n.d / FPS });
}
return { removed, placed, ms_place: Date.now() - T0 };
`;

const VTRANS_BODY = String.raw`
const T0 = Date.now();
const at = new Set(args.at); const picks = []; const missing = []; const skipped = [];
await retrying(async () => {
  const seq = await getSeq(await getProject(), args.sequence);
  picks.length = 0; missing.length = 0; skipped.length = 0;
  for (const vi of args.tracks) {
    const its = await trackItems(seq, "V", vi);
    const ends = {}; for (let n = 0; n < its.length; n++) ends[FR(await its[n].getEndTime())] = n;
    const busy = ((args.busy && args.busy[vi]) || []).map((x) => [x.s, x.e]);   // edges already carrying a transition (QE)
    for (const f of at) {
      if (ends[f] === undefined) { missing.push({ track: "V" + (vi + 1), frame: f }); continue; }
      if (busy.some(([s, e]) => f >= s && f <= e)) { skipped.push({ track: "V" + (vi + 1), frame: f }); continue; }
      picks.push({ kind: "V", track: vi, index: ends[f] });
    }
  }
});
const dur = ppro.TickTime.createWithTicks(String(args.frames * (TPS / FPS)));
await commitPicks("Add video transitions", picks.map((x) => ({ ...x,
  prep: () => ppro.TransitionFactory.createVideoTransition(args.match),
  act: (ti, tr) => { const o = new ppro.AddTransitionOptions(); o.setApplyToStart(false); o.setDuration(dur); o.setForceSingleSided(false); o.setTransitionAlignment(args.align); return ti.createAddVideoTransitionAction(tr, o); } })));
return { sequence: args.sequence, added: picks.length, skipped_existing: skipped, missing, ms: Date.now() - T0 };
`;

const MARKERS_BODY = String.raw`
const T0 = Date.now();
const keep = new Set(args.keep);
const list = args.markers;
const ST = (s) => FT(Math.round(Number(s || 0) * FPS));
let removed = 0;
await retrying(async () => {
  const p = await getProject(); const seq = await getSeq(p, args.sequence); const M = await ppro.Markers.getMarkers(seq);
  const old = args.replace ? M.getMarkers().filter((m) => !keep.has(m.getName())) : [];
  commit(p, "Set markers", () => [
    ...old.map((m) => M.createRemoveMarkerAction(m)),
    ...list.map((m) => M.createAddMarkerAction(m.name, markerType(m.type), ST(m.start), ST(m.dur), m.comment || "")),
  ]);
  removed = old.length;
});
const col = new Map(); for (const m of list) if (m.color !== undefined) col.set(m.name + "@" + Math.round(m.start * FPS), m.color);
let colored = 0, total = 0;
await retrying(async () => {
  const p = await getProject(); const seq = await getSeq(p, args.sequence); const M2 = await ppro.Markers.getMarkers(seq);
  colored = 0; const ms = M2.getMarkers(); total = ms.length;
  commit(p, "Marker colors", () => ms.map((m) => { const c = col.get(m.getName() + "@" + FR(m.getStart())); if (c === undefined) return null; colored++; return m.createSetColorByIndexAction(c); }));
});
return { sequence: args.sequence, removed, added: list.length, colored, total_now: total, ms: Date.now() - T0 };
`;

const READ_BODY = String.raw`
const T0 = Date.now();
const p = await getProject(); const seq = await getSeq(p, args.sequence);
const nV = await seq.getVideoTrackCount(), nA = await seq.getAudioTrackCount();
const vIdx = args.v || [...Array(nV).keys()], aIdx = args.a || [...Array(nA).keys()];
async function valueOf(prm) {
  try { const sv = await prm.getStartValue(); let v = sv && sv.value; if (v && typeof v === "object" && "value" in v) v = v.value;
    if (v && typeof v === "object") { if ("x" in v && "y" in v) return [v.x, v.y]; if ("0" in v && "1" in v) return [v[0], v[1]]; return String(v); } return v; } catch (e) { return null; }
}
async function chainOf(ti) {
  const ch = await ti.getComponentChain(); const out = [];
  for (let c = 0; c < ch.getComponentCount(); c++) {
    const comp = ch.getComponentAtIndex(c); const o = { match: await comp.getMatchName(), params: {} };
    try { o.name = await comp.getDisplayName(); } catch (e) { /* ignore */ }
    for (let j = 0; j < comp.getParamCount(); j++) {
      const prm = comp.getParam(j); const key = prm.displayName || ("#" + j);
      let tv = false; try { tv = await prm.isTimeVarying(); } catch (e) { /* ignore */ }
      if (tv && args.keyframes) {
        const kfs = []; try { for (const t of await prm.getKeyframeListAsTickTimes()) { const k = await prm.getKeyframePtr(t); let v = k.value && k.value.value; if (v && typeof v === "object") v = "x" in v ? [v.x, v.y] : ("0" in v ? [v[0], v[1]] : String(v)); kfs.push([FR(t), v]); } } catch (e) { kfs.push("unreadable: " + e.message); }
        o.params[key] = { keyframes: kfs };
      } else o.params[key] = tv ? { timeVarying: true, start: await valueOf(prm) } : await valueOf(prm);
    }
    out.push(o);
  }
  return out;
}
async function track(kind, i) {
  const tr = await (kind === "V" ? seq.getVideoTrack(i) : seq.getAudioTrack(i));
  const clips = [];
  for (const ti of tr.getTrackItems(C.TrackItemType.CLIP, false)) {
    const c = { name: await ti.getName(), s: FR(await ti.getStartTime()), e: FR(await ti.getEndTime()), in: FR(await ti.getInPoint()), out: FR(await ti.getOutPoint()) };
    if (await ti.isDisabled()) c.disabled = true;
    if (args.effects) c.effects = await chainOf(ti);
    clips.push(c);
  }
  const o = { index: i, track: kind + (i + 1), name: tr.name, clips };
  return o;
}
const video = []; for (const i of vIdx) video.push(await track("V", i));
const audio = []; for (const i of aIdx) audio.push(await track("A", i));
const r = { sequence: seq.name, fps: FPS, end: FR(await seq.getEndTime()), video, audio };
if (args.markers) r.markers = (await listMarkers(seq)).map((m) => ({ name: m.name, s: Math.round(m.start * FPS), dur: Math.round((m.duration || 0) * FPS), color: m.colorIndex, type: m.type }));
r.ms = Date.now() - T0;
return r;
`;
