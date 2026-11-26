// Caption templates: chunk word-timed transcripts into captions and write SRT / VTT / ASS.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export const DEFAULT_TEMPLATE = {
  name: "default",
  description: "",
  maxCharsPerLine: 42,
  maxLines: 2,
  maxWordsPerCaption: 0, // 0 = no limit
  minDuration: 0.8,
  maxDuration: 6,
  maxGap: 0.6, // start a new caption when the speaker pauses longer than this
  splitOnSentenceEnd: true,
  case: "none", // none | upper | lower | sentence
  stripPunctuation: false,
  removeFillers: false,
  fillers: ["um", "uh", "erm", "ah", "hmm", "mm", "uhm", "hum", "ahn", "tipo", "pronto"],
  highlightActiveWord: false, // ASS only: re-colour the word being spoken
  style: {
    font: "Arial",
    fontSize: 48,
    bold: true,
    primaryColor: "#FFFFFF",
    highlightColor: "#FFE11F",
    outlineColor: "#000000",
    backColor: "#000000",
    backOpacity: 0.0,
    outline: 3,
    shadow: 0,
    borderStyle: 1, // 1 = outline + shadow, 3 = opaque box
    alignment: 2, // numpad: 2 bottom-centre, 5 middle-centre, 8 top-centre
    marginV: 60,
    marginH: 60,
    playResX: 1920,
    playResY: 1080,
  },
};

// ---------- templates ----------
function readJson(f) { return JSON.parse(fs.readFileSync(f, "utf8")); }

export function listTemplates() {
  const out = [];
  for (const [dir, source] of [[config.builtinTemplatesDir, "builtin"], [config.userTemplatesDir, "user"]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const t = readJson(path.join(dir, f));
        out.push({ name: t.name || f.replace(/\.json$/, ""), description: t.description || "", source, file: path.join(dir, f) });
      } catch { /* skip broken */ }
    }
  }
  // user templates override builtins of the same name
  const byName = new Map();
  for (const t of out) byName.set(t.name, t);
  return [...byName.values()];
}

export function mergeTemplate(base, override) {
  return { ...base, ...override, style: { ...(base.style || {}), ...((override && override.style) || {}) } };
}

export function loadTemplate(nameOrObj) {
  if (!nameOrObj) return mergeTemplate(DEFAULT_TEMPLATE, {});
  if (typeof nameOrObj === "object") return mergeTemplate(DEFAULT_TEMPLATE, nameOrObj);
  if (fs.existsSync(nameOrObj) && nameOrObj.endsWith(".json")) return mergeTemplate(DEFAULT_TEMPLATE, readJson(nameOrObj));
  const t = listTemplates().find((x) => x.name.toLowerCase() === String(nameOrObj).toLowerCase());
  if (!t) throw new Error(`Caption template '${nameOrObj}' not found. Available: ${listTemplates().map((x) => x.name).join(", ")}`);
  const data = readJson(t.file);
  // allow "extends": "other-template"
  if (data.extends) return mergeTemplate(loadTemplate(data.extends), data);
  return mergeTemplate(DEFAULT_TEMPLATE, data);
}

export function saveTemplate(name, template) {
  const safe = name.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
  const file = path.join(config.userTemplatesDir, `${safe}.json`);
  fs.mkdirSync(config.userTemplatesDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...template, name }, null, 2));
  return file;
}

// ---------- words ----------
// Accepts our transcript JSON ({segments:[{start,end,text,words:[{start,end,word}]}]}).
export function wordsFromTranscript(tr, { start = null, end = null } = {}) {
  const words = [];
  for (const seg of tr.segments || []) {
    if (seg.words && seg.words.length) {
      for (const w of seg.words) words.push({ start: w.start, end: w.end, word: String(w.word).trim() });
    } else {
      words.push(...interpolateWords(seg.text, seg.start, seg.end));
    }
  }
  return words.filter((w) => w.word && (start === null || w.end > start) && (end === null || w.start < end));
}

// Spread a caption's text across its time span, weighted by word length.
export function interpolateWords(text, start, end) {
  const toks = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!toks.length) return [];
  const weights = toks.map((t) => Math.max(1, t.replace(/[^\p{L}\p{N}]/gu, "").length) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0.01, end - start);
  let t = start;
  return toks.map((word, i) => {
    const d = (span * weights[i]) / total;
    const w = { start: t, end: t + d, word };
    t += d;
    return w;
  });
}

const SENT_END = /[.!?…]["')\]]?$/;
const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

function applyCase(text, mode) {
  if (mode === "upper") return text.toLocaleUpperCase();
  if (mode === "lower") return text.toLocaleLowerCase();
  if (mode === "sentence") return text.charAt(0).toLocaleUpperCase() + text.slice(1).toLocaleLowerCase();
  return text;
}

function cleanWord(w, tpl) {
  let s = w;
  if (tpl.stripPunctuation) s = s.replace(/[.,!?;:…"“”]/g, "");
  return s;
}

// Split words into lines of <= maxChars, as balanced as possible across maxLines.
export function layoutLines(words, maxChars, maxLines) {
  const text = words.join(" ");
  if (text.length <= maxChars || maxLines <= 1) return [text];
  // try a balanced 2+ line split
  const lines = [];
  let cur = [];
  const target = Math.min(maxChars, Math.ceil(text.length / Math.min(maxLines, Math.ceil(text.length / maxChars))));
  for (const w of words) {
    const candidate = [...cur, w].join(" ");
    if (cur.length && candidate.length > target && lines.length < maxLines - 1) {
      lines.push(cur.join(" "));
      cur = [w];
    } else cur.push(w);
  }
  if (cur.length) lines.push(cur.join(" "));
  return lines;
}

// Core: turn words into caption events {start,end,words:[{start,end,text}],lines:[...]}
export function chunkWords(words, tpl) {
  const t = mergeTemplate(DEFAULT_TEMPLATE, tpl);
  const fillers = new Set((t.fillers || []).map((f) => f.toLowerCase()));
  const src = words
    .filter((w) => !(t.removeFillers && fillers.has(bare(w.word))))
    .map((w) => ({ ...w, text: cleanWord(w.word, t) }))
    .filter((w) => w.text.trim());
  const maxLen = t.maxCharsPerLine * t.maxLines;
  const caps = [];
  let cur = [];
  const flush = () => { if (cur.length) caps.push(cur); cur = []; };
  for (let i = 0; i < src.length; i++) {
    const w = src[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const textLen = [...cur, w].map((x) => x.text).join(" ").length;
      const tooLong = textLen > maxLen;
      const tooMany = t.maxWordsPerCaption > 0 && cur.length >= t.maxWordsPerCaption;
      const tooSlow = w.end - cur[0].start > t.maxDuration;
      const pause = w.start - prev.end > t.maxGap;
      const sentence = t.splitOnSentenceEnd && SENT_END.test(prev.word.trim()) && cur.map((x) => x.text).join(" ").length >= Math.min(12, maxLen / 3);
      if (tooLong || tooMany || tooSlow || pause || sentence) flush();
    }
    cur.push(w);
  }
  flush();

  const events = caps.map((ws) => ({
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    words: ws.map((w) => ({ start: w.start, end: w.end, text: applyCase(w.text, t.case === "sentence" ? "none" : t.case) })),
  }));
  // min duration, without overlapping the next caption
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const next = events[i + 1];
    if (e.end - e.start < t.minDuration) e.end = Math.min(e.start + t.minDuration, next ? next.start - 0.01 : Infinity);
    if (next && e.end > next.start) e.end = next.start - 0.01;
    e.end = Math.max(e.end, e.start + 0.05);
    let text = e.words.map((w) => w.text).join(" ");
    if (t.case === "sentence") text = applyCase(text, "sentence");
    e.lines = layoutLines(text.split(" "), t.maxCharsPerLine, t.maxLines);
  }
  return events;
}

// ---------- writers ----------
const pad = (n, l = 2) => String(n).padStart(l, "0");
function srtTime(s) {
  s = Math.max(0, s);
  const ms = Math.round(s * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
const vttTime = (s) => srtTime(s).replace(",", ".");
function assTime(s) {
  s = Math.max(0, s);
  const cs = Math.round(s * 100);
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

export function toSRT(events, offset = 0) {
  return events.map((e, i) => `${i + 1}\n${srtTime(e.start + offset)} --> ${srtTime(e.end + offset)}\n${e.lines.join("\n")}\n`).join("\n");
}
export function toVTT(events, offset = 0) {
  return "WEBVTT\n\n" + events.map((e) => `${vttTime(e.start + offset)} --> ${vttTime(e.end + offset)}\n${e.lines.join("\n")}\n`).join("\n");
}

function assColor(hex, opacity = 1) {
  const h = String(hex || "#FFFFFF").replace("#", "").padEnd(6, "0");
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255).toString(16).padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}
const assEsc = (s) => s.replace(/\\/g, "\\\\").replace(/[{}]/g, "");

export function toASS(events, tpl, { offset = 0, playResX, playResY } = {}) {
  const t = mergeTemplate(DEFAULT_TEMPLATE, tpl);
  const s = t.style;
  const W = playResX || s.playResX, H = playResY || s.playResY;
  const scale = H / (s.playResY || 1080);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // With BorderStyle 3 (opaque box) libass paints the box in the outline colour, so give it the box opacity.
    `Style: Default,${s.font},${Math.round(s.fontSize * scale)},${assColor(s.primaryColor)},${assColor(s.highlightColor)},${assColor(s.borderStyle === 3 ? s.backColor : s.outlineColor, s.borderStyle === 3 ? (s.backOpacity ?? 0.6) : 1)},${assColor(s.backColor, s.backOpacity ?? 0)},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle || 1},${s.outline},${s.shadow},${s.alignment},${Math.round(s.marginH * scale)},${Math.round(s.marginH * scale)},${Math.round(s.marginV * scale)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = [];
  const hl = assColor(s.highlightColor);
  for (const e of events) {
    if (!t.highlightActiveWord) {
      lines.push(`Dialogue: 0,${assTime(e.start + offset)},${assTime(e.end + offset)},Default,,0,0,0,,${e.lines.map(assEsc).join("\\N")}`);
      continue;
    }
    // one event per active word, recolouring that word
    const flat = e.words;
    const breaks = new Set();
    let idx = 0;
    for (const line of e.lines.slice(0, -1)) { idx += line.split(" ").length; breaks.add(idx); }
    for (let i = 0; i < flat.length; i++) {
      const ws = i === 0 ? e.start : flat[i].start;
      const we = i === flat.length - 1 ? e.end : flat[i + 1].start;
      if (we <= ws) continue;
      let text = "";
      flat.forEach((w, j) => {
        if (j > 0) text += breaks.has(j) ? "\\N" : " ";
        text += j === i ? `{\\c${hl}&}${assEsc(w.text)}{\\r}` : assEsc(w.text);
      });
      lines.push(`Dialogue: 0,${assTime(ws + offset)},${assTime(we + offset)},Default,,0,0,0,,${text}`);
    }
  }
  return header.join("\n") + "\n" + lines.join("\n") + "\n";
}

// ---------- parsing existing caption files ----------
function parseTime(str) {
  const m = str.trim().replace(",", ".").match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

export function parseSubtitles(content) {
  const blocks = content.replace(/\r/g, "").split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split("-->");
    const start = parseTime(a), end = parseTime(z.split(" ").filter(Boolean)[0] || z);
    const text = lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (start !== null && end !== null && text) cues.push({ start, end, text });
  }
  return cues;
}

export function wordsFromSubtitles(content) {
  return parseSubtitles(content).flatMap((c) => interpolateWords(c.text, c.start, c.end));
}

export function writeCaptions(events, format, outPath, tpl, opts = {}) {
  const offset = opts.offset || 0;
  let body;
  if (format === "srt") body = toSRT(events, offset);
  else if (format === "vtt") body = toVTT(events, offset);
  else if (format === "ass") body = toASS(events, tpl, { offset, playResX: opts.playResX, playResY: opts.playResY });
  else throw new Error("Unknown caption format: " + format);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body, "utf8");
  return outPath;
}
