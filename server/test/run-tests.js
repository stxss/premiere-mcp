// End-to-end test: starts the MCP server over stdio, attaches a mock Premiere panel,
// and calls every tool. Usage: node test/run-tests.js [test-video.mp4] [--whisper]
// Without a video it generates a 60 s test clip with ffmpeg (tone with silent gaps; --whisper needs real speech).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createMockPpro, connectMockPanel, connectMockCep } from "./mock-premiere.js";

const useWhisper = process.argv.includes("--whisper");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-"));
let video = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (video) video = path.resolve(video);
else {
  if (useWhisper) { console.error("--whisper needs a video with speech: node test/run-tests.js <video> --whisper"); process.exit(1); }
  video = path.join(work, "test_video.mp4");
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=60", "-f", "lavfi", "-i", "sine=frequency=330:duration=60",
    "-af", "volume=enable='between(mod(t\,10)\,7\,9)':volume=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  console.log("generated " + video);
}
if (!fs.existsSync(video)) { console.error("video not found: " + video); process.exit(1); }
const port = 18765;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("src/index.js")],
  env: { ...process.env, PREMIERE_MCP_PORT: String(port), PREMIERE_MCP_WORKDIR: work },
  stderr: "pipe",
});
const client = new Client({ name: "test", version: "1" });
await client.connect(transport);

let failures = 0;
async function call(name, args = {}, { expectError = false, show = 600 } = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  const bad = !!r.isError !== expectError;
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "ok  "} ${name}: ${text.slice(0, show).replace(/\n\s*/g, " ")}`);
  try { return JSON.parse(text); } catch { return text; }
}

const tools = (await client.listTools()).tools;
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

// --- before the panel connects
await call("ppro_project_overview", {}, { expectError: true });

// --- mock panel
const info = JSON.parse((await client.callTool({ name: "media_probe", arguments: { path: video } })).content[0].text);
const ppro = createMockPpro(video, info.duration);
await connectMockPanel(port, ppro);
await connectMockCep(port);

await call("setup_check");
await call("ppro_status");
await call("ppro_project_overview");
await call("ppro_api_help", {}, { show: 120 });
await call("ppro_execute_script", { code: "const p = await getProject(); return (await walk(p)).items.map(i => i.path);" });
await call("ppro_execute_script", { code: "throw new Error('boom')" }, { expectError: true });
await call("ppro_organize", { operations: [
  { op: "create_bin", bin: "Selects/Best" },
  { op: "rename", item: "Footage/talk_test.mp4", name: "Interview A" },
  { op: "move", item: "Interview A", bin: "Selects" },
  { op: "move", item: "does-not-exist", bin: "Selects" },
] });

// --- silence -> rough cut
const sil = await call("media_detect_silence", { path: video });
const rc = await call("ppro_rough_cut", { source: video, sequence_name: "Tight Cut", segments_file: sil.segments_file });
{ const si = JSON.parse((await client.callTool({ name: "ppro_sequence_info", arguments: { sequence: "Tight Cut" } })).content[0].text);
  if (si.videoTracks[0].clipCount !== rc.segments) { failures++; console.log("FAIL rough cut placed", si.videoTracks[0].clipCount, "of", rc.segments); } }
await call("ppro_sequence_info", { sequence: "Tight Cut" }, { show: 400 });
await call("ppro_rough_cut", { source: "Interview A", sequence_name: "Beats", segments: [{ start: 1, end: 5, label: "intro" }, { start: 30, end: 33 }] });

// --- markers & chapters
await call("ppro_add_markers", { sequence: "Tight Cut", markers: [
  { time: 0, name: "Intro", type: "chapter" },
  { time: 15, name: "Why it works", type: "chapter", color_index: 3 },
  { time: 40, name: "Wrap up", type: "chapter" },
  { time: 22, name: "fix audio", comment: "pop here" },
] });
await call("ppro_list_markers", { sequence: "Tight Cut", type: "chapter" });
await call("ppro_youtube_chapters", { sequence: "Tight Cut" });
await call("ppro_remove_markers", { sequence: "Tight Cut", name: "fix audio" });
await call("ppro_set_in_out", { in_point: 2, out_point: 20, sequence: "Tight Cut" });
await call("ppro_open_sequence", { sequence: "Beats" });
await call("ppro_export_frame", { output_path: path.join(work, "thumb.png"), time: 3 });
await call("ppro_find_export_presets", { filter: "youtube" }, { show: 200 });
await call("ppro_save_project");

// --- batch timeline tools on a small two-host plan (frames at 30 fps); everything show-specific is in plan.spec
{
  const P = ppro._project;
  const bin = P._addBin("Show");
  P._addClip("EP99 A VIDEO", 120, bin, "v"); P._addClip("EP99 B VIDEO", 120, bin, "v");
  P._addClip("EP99 A AUDIO", 120, bin, "a"); P._addClip("EP99 B AUDIO", 120, bin, "a");
  P._addClip("solo_a.png", 3600, bin, "v"); P._addClip("solo_b.png", 3600, bin, "v");
  P._addSequence("Split bg", bin); P._addSequence("Intro nest", bin); P._addSequence("Outro nest", bin);
  P._addSequence("Divider nest", bin); P._addSequence("Park", bin);
  const seq = P._addSequence("EP99 test");
  await P.setActiveSequence(seq);   // the tools must park on spec.park_sequence and come back
  const c = (t, item, i, d, s, dis) => ({ t, item, i, d, s, dis });
  const spec = {
    fps: 30, speakers: ["a", "b"],
    names: { aV: "EP99 A VIDEO", bV: "EP99 B VIDEO", aA: "EP99 A AUDIO", bA: "EP99 B AUDIO", bg: "Split bg", soloA: "solo_a.png", soloB: "solo_b.png", divider: "Divider nest" },
    labels: { aV: 2, aA: 2, bV: 0, bA: 0 }, temp_labels: { bg: 6, soloA: 2, soloB: 0 },
    layout_tracks: ["V1", "V3", "V4", "V6", "V7", "V9", "V10"], audio_tracks: ["A1", "A2"],
    clear_tracks: ["V1", "V3", "V4", "V6", "V7", "V9", "V10", "A1", "A2"], keep_markers: ["Intro"], strip_audio_of: ["bg"],
    divider: { track: "V11", item: "divider" },
    layout_transition: { id: "AE.ADBE Cross Dissolve New", frames: 8, alignment: 0.5 },
    speaker_tracks: ["V6", "V7", "V9", "V10"],
    split_transforms: {
      V9: [{ comp: "motion", param: "Crop Right", value: 50 }, { comp: "t0", param: "Position", value: [0.28, 0.5] }],
      V10: [{ comp: "motion", param: "Crop Left", value: 50 }, { comp: "t0", param: "Position", value: [0.73, 0.5] },
            { comp: "t1", param: "Position", value: [0.5, 0.5] }, { comp: "t1", param_index: 3, value: 130 }, { comp: "t1", param_index: 4, value: 130 }],
    },
    outro_slide: { frames: 16, rest: [0.5, 0.5], down: [0.5, 1.59], up_from: [0.5, 1.51] },
    nests: [{ key: "intro_nest", name: "Intro nest", track: "V13", audio_track: "A4", level_db: -6 },
            { key: "outro_nest", name: "Outro nest", track: "V14", audio_track: "A4", level_db: -6 }],
    remove_before_nests: { names: ["Intro nest", "Outro nest"], tracks: ["V13", "V14", "A3", "A4"] },
    park_sequence: "Park", template_sequences: ["Divider nest", "Intro nest", "Outro nest", "Split bg"],
  };
  const plan = {
    fps: 30, D: 90, U: 200, switches: [90],
    clips: [
      c("V1", "bg", 0, 90, 0, false), c("V1", "bg", 90, 90, 90, false),
      c("V3", "soloA", 0, 90, 0, true), c("V3", "soloA", 0, 60, 90, false),
      c("V6", "aV", 300, 90, 0, true), c("V6", "aV", 500, 60, 90, false),
      c("V7", "bV", 310, 90, 0, true), c("V7", "bV", 510, 60, 90, true),
      c("V9", "aV", 300, 90, 0, false), c("V9", "aV", 500, 60, 90, true),
      c("V10", "bV", 310, 90, 0, false), c("V10", "bV", 510, 60, 90, true),
      c("A1", "aA", 300, 90, 0), c("A1", "aA", 500, 60, 90), c("A2", "bA", 310, 150, 0),
    ],
    markers: [{ name: "Chapter one", start: 0, dur: 0, color: 0 }, { name: "SHORT: test", start: 1, dur: 2, color: 1 }],
    intro_nest: { s: 0, i: 0, d: 30 }, outro_nest: { s: 120, i: 0, d: 30 },
    audio_fades: [{ t: 3, frames: 4 }],
    spec,
  };
  const planFile = path.join(work, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const A = { sequence: "EP99 test", plan_file: planFile };
  const expect = (cond, msg) => { if (!cond) failures++; console.log((cond ? "ok   " : "FAIL ") + msg); };
  const noSpec = path.join(work, "plan_nospec.json"); fs.writeFileSync(noSpec, JSON.stringify({ ...plan, spec: undefined }));
  const ns = await call("ppro_place_from_plan", { sequence: "EP99 test", plan_file: noSpec }, { expectError: true, show: 160 });
  expect(typeof ns === "string" && /no 'spec'/.test(ns), "place_from_plan: a plan without spec is refused");
  const pl = await call("ppro_place_from_plan", A, { show: 300 });
  expect(pl.ok === true && pl.placed === plan.clips.length + 2 && pl.divider === "placed", "place_from_plan: every clip where the plan says + 2 divider pieces");
  expect(pl.parked_on === "Park" && (await P.getActiveSequence()) === seq, "place_from_plan: parked on spec.park_sequence, target back in front");
  { const d = [...seq.v[10].items].sort((a, b) => a.start - b.start);
    expect(d.length === 2 && !d[0].disabled && d[1].disabled && d[1].inP === 3, "divider: one piece per layout run, solo run disabled, in-point = timeline start"); }
  expect(pl.stripped_nest_audio === 1, "place_from_plan: background nest audio left past the dialogue stripped");
  { const a1 = seq.a[0].items.map((t) => t.clip.name); expect(a1.every((n) => n === "EP99 A AUDIO"), "place_from_plan: A1 holds only host A dialogue"); }
  const pl2 = await call("ppro_place_from_plan", A, { show: 120 });
  expect(pl2.ok === true && pl2.cleared === 17, "place_from_plan: rerun clears and places again");
  const lay = await call("ppro_set_layout", A, { show: 200 });
  expect(lay.appended === 10 && lay.valued_clips === 6, "set_layout: Transforms for the split (V9 1, V10 2) + outro slide on the speaker tracks");
  expect((await call("ppro_set_layout", A, { show: 120 })).appended === 0, "set_layout: rerun adds nothing");
  const vt = await call("ppro_add_video_transitions", A, { show: 200 });
  expect(vt.added === 7 && seq.v[10].transitions[0].match === "AE.ADBE Cross Dissolve New" && Math.abs(seq.v[10].transitions[0].dur - 8 / 30) < 1e-6, "add_video_transitions: spec transition on the 7 tracks with an edit at the switch (incl. the divider)");
  const mk = await call("ppro_set_markers_from_json", A, { show: 200 });
  expect(mk.added === 2 && mk.colored === 2, "set_markers_from_json: markers + colors");
  const io = await call("ppro_place_intro_outro", A, { show: 200 });
  expect(io.placed && io.placed.length === 2 && seq.v[12].items.length === 1 && seq.v[13].items.length === 1, "place_intro_outro: spec.nests placed on their tracks");
  const rd = await call("ppro_read_timeline", { sequence: "EP99 test", effects: true, keyframes: true, transitions: true, out_file: path.join(work, "read.json") }, { show: 200 });
  const full = JSON.parse(fs.readFileSync(path.join(work, "read.json"), "utf8"));
  const v9 = full.video[8].clips[0], v10 = full.video[9].clips[0];
  expect(rd.video[8].clips === 2 && v9.effects[1].params["Crop Right"] === 50 && JSON.stringify(v9.effects[2].params.Position) === "[0.28,0.5]", "read_timeline: V9 split crop + Transform position from spec");
  expect(v10.effects.length === 4 && v10.effects[3].params["Scale Height"] === 130, "read_timeline: V10 second Transform scale from spec (param_index)");
  { const v6 = full.video[5].clips.find((x) => x.s === 90); expect(v6 && v6.effects.length === 3 && v6.effects[2].params.Position.keyframes, "read_timeline: outro slide keyframes at D"); }
  expect(full.markers.length === 2 && full.markers[1].color === 1, "read_timeline: markers");
  await call("ppro_audio_transitions", { sequence: "EP99 test", plan_file: planFile }, { show: 120 });
  expect(seq.v[5].items.find((t) => t.start === 3).disabled === false && seq.v[6].items.every((t) => t.disabled), "layout flags from plan");
}

// --- transcript (real Whisper or a synthetic transcript)
let transcript;
if (useWhisper) {
  let t = await call("transcribe_media", { path: video, model: "tiny", language: "en", device: "cpu" });
  while (t.status === "running") t = await call("job_status", { job_id: t.job_id, wait_seconds: 30 });
  transcript = t.transcript || t.result?.transcript;
  const again = await call("transcribe_media", { path: video, model: "tiny", language: "en" });
  if (!again.cached) { failures++; console.log("FAIL cache"); }
} else {
  transcript = path.join(work, "synthetic.json");
  const words = "So today we are going to talk about how physics works and why it matters. Um the first idea is energy. Energy is conserved! The second idea is momentum and it is also conserved.".split(" ");
  let t = 0.5;
  const segs = [{ start: 0.5, end: 0, text: words.join(" "), words: words.map((w) => { const o = { start: t, end: t + 0.35, word: w }; t += 0.42; return o; }) }];
  segs[0].end = t;
  fs.writeFileSync(transcript, JSON.stringify({ source: video, language: "en", duration: info.duration, segments: segs }));
}
await call("transcript_read", { transcript, max_chars: 500 }, { show: 300 });
await call("transcript_read", { transcript: video }, { show: 120, expectError: !useWhisper });
await call("transcript_search", { transcript, query: useWhisper ? ["physics", "energy"] : ["energy", "is conserved"] }, { show: 400 });
await call("transcript_search", { transcript, query: ["\\bmoment\\w+"], mode: "regex" }, { show: 200 });

// --- captions
await call("captions_list_templates");
await call("captions_get_template", { name: "shorts-punchy" }, { show: 150 });
await call("captions_save_template", { name: "my-tiktok", template: { extends: "shorts-punchy", maxWordsPerCaption: 2, style: { highlightColor: "#FF3355" } } }, { show: 200 });
const srt = await call("captions_generate", { transcript, template: "youtube-standard", format: "srt" });
await call("captions_generate", { transcript, template: "my-tiktok", format: "ass", start: 2, end: 12 });
await call("captions_generate", { transcript, template: "youtube-single-line", format: "vtt" });
await call("captions_reformat", { input_path: srt.output, template: "shorts-boxed", format: "ass" });
await call("captions_get_template", { name: "nope" }, { expectError: true });
await call("ppro_import_captions", { srt_path: srt.output, sequence: "Tight Cut" });
console.log("\n--- SRT sample ---\n" + fs.readFileSync(srt.output, "utf8").split("\n").slice(0, 12).join("\n"));

// --- shorts
let short = await call("shorts_render", { source: video, start: 1, end: 9, transcript, caption_template: "shorts-punchy" });
while (short.status === "running") short = await call("job_status", { job_id: short.job_id, wait_seconds: 30 });
const shortPath = short.output || short.result?.output;
await call("shorts_render", { source: video, start: 10, end: 14, framing: "blur_pad", burn_captions: false, output_path: path.join(work, "blur.mp4") });
await call("media_extract_frames", { path: shortPath, times: [1, 4], width: 540 });
await call("media_probe", { path: shortPath });
await call("job_status");

// --- HyperFrames
const hf = await call("hyperframes_init", { name: "lower-third", resolution: "landscape" }, { show: 200 });
let html = await call("hyperframes_read_file", { project: hf.project }, { show: 80 });
html = html.replace("--ground: #000;", "--ground: transparent;").replace(/data-duration="10"/g, 'data-duration="3"')
  .replace(">Title<", ">Alex Doe - Editor<")
  .replace("window.__timelines", 'tl.fromTo("#title", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5 }, 0);\n      window.__timelines');
await call("hyperframes_write_file", { project: hf.project, content: html });
await call("hyperframes_write_file", { project: hf.project, file: "../escape.html", content: "x" }, { expectError: true });
await call("hyperframes_check", { project: hf.project }, { show: 200 });
await call("hyperframes_snapshot", { project: hf.project, at: [0.2, 2] });
let hr = await call("hyperframes_render", { project: hf.project, format: "mov", quality: "draft", place_at: 5, sequence: "Tight Cut" });
while (hr.status === "running") hr = await call("job_status", { job_id: hr.job_id, wait_seconds: 30 });
await call("ppro_sequence_info", { sequence: "Tight Cut" }, { show: 0 }).then((s) => {
  const v2 = s.videoTracks[1].clips.map((c) => c.name);
  console.log(v2.some((n) => n.endsWith(".mov")) ? "ok   overlay on V2: " + v2.join(", ") : (failures++, "FAIL overlay not on V2"));
});

console.log(`\nworkdir: ${work}`);
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
await client.close();
process.exit(failures ? 1 : 0);
