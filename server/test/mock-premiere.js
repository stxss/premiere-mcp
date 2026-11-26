// Minimal in-memory imitation of the Premiere UXP API, enough to execute the
// server's scripts end-to-end in tests. It is NOT Premiere; it checks our script
// logic and the bridge protocol, not Adobe's behaviour.
// Copies a few real 26.5 quirks the tools must handle: removing an empty selection throws,
// overwrite takes the project item's in/out at the moment it runs, nested sequences bring audio.
import { WebSocket } from "ws";

const ticksPerSec = 254016000000;
class TickTime {
  constructor(s) { this.seconds = s; this.ticks = String(Math.round(s * ticksPerSec)); }
  static createWithSeconds(s) { return new TickTime(s); }
  static createWithTicks(t) { return new TickTime(Number(t) / ticksPerSec); }
}
TickTime.TIME_ZERO = new TickTime(0);

const Constants = {
  ContentType: { MEDIA: 0, SEQUENCE: 1 },
  TrackItemType: { EMPTY: 0, CLIP: 1, TRANSITION: 2 },
  ExportType: { QUEUE_TO_AME: 0, QUEUE_TO_APP: 1, IMMEDIATELY: 2 },
  MediaType: { ANY: 0, VIDEO: 1, AUDIO: 2 },
};

class PointF { constructor(x, y) { this.x = x; this.y = y; } }

class MarkerList {
  constructor() { this.list = []; }
  getMarkers() { return [...this.list]; }
  createAddMarkerAction(name, type, start, dur, comments) {
    return () => this.list.push(new MockMarker(name, type, start.seconds, dur.seconds, comments));
  }
  createRemoveMarkerAction(m) { return () => { this.list = this.list.filter((x) => x !== m); }; }
}
class MockMarker {
  constructor(n, t, s, d, c) { Object.assign(this, { n, t, s, d, c, color: 0 }); }
  getName() { return this.n; } getType() { return this.t; } getStart() { return new TickTime(this.s); }
  getDuration() { return new TickTime(this.d); } getComments() { return this.c; } getColorIndex() { return this.color; }
  createSetColorByIndexAction(i) { return () => { this.color = i; }; }
}

class Folder {
  constructor(name, parent) { this.name = name; this.parent = parent; this.items = []; }
  async getItems() { return [...this.items]; }
  getParentBin() { return this.parent; }
  createBinAction(name) { return () => this.items.push(new Folder(name, this)); }
  createMoveItemAction(item, dest) {
    return () => { this.items = this.items.filter((x) => x !== item); item.parent = dest; dest.items.push(item); };
  }
  createSetNameAction(n) { return () => { this.name = n; }; }
}

// media: "av" | "v" | "a" (subclips made video-only / audio-only)
class Clip {
  constructor(name, mediaPath, duration, parent, seq, media = "av") {
    Object.assign(this, { name, mediaPath, duration, parent, seq, media, markers: new MarkerList(), inP: null, outP: null, label: 0 });
  }
  async getContentType() { return this.seq ? Constants.ContentType.SEQUENCE : Constants.ContentType.MEDIA; }
  async getMediaFilePath() { return this.mediaPath; }
  getParentBin() { return this.parent; }
  async getInPoint() { return new TickTime(this.inP ?? 0); }
  async getOutPoint() { return new TickTime(this.outP ?? this.duration); }
  async getColorLabelIndex() { return this.label; }
  createSetNameAction(n) { return () => { this.name = n; }; }
  createSetColorLabelAction(i) { return () => { this.label = i; }; }
  createSetInOutPointsAction(a, b) { return () => { this.inP = a.seconds; this.outP = b.seconds; }; }
  createClearInOutPointsAction() { return () => { this.inP = null; this.outP = null; }; }
  createSubClipAction(name, s, e) {
    return () => this.parent.items.push(new Clip(name, this.mediaPath, e.seconds - s.seconds, this.parent));
  }
}

class Param {
  constructor(displayName, value) { this.displayName = displayName; this.value = value; this.tv = false; this.kfs = []; }
  createKeyframe(v) { return { value: { value: v }, position: TickTime.TIME_ZERO }; }
  createSetValueAction(kf) { return () => { this.value = kf.value.value; }; }
  createSetTimeVaryingAction(b) { return () => { this.tv = b; }; }
  createAddKeyframeAction(kf) { return () => this.kfs.push(kf); }
  async isTimeVarying() { return this.tv; }
  async getStartValue() { return { value: { value: this.value } }; }
  async getKeyframeListAsTickTimes() { return this.kfs.map((k) => k.position); }
  async getKeyframePtr(t) { return this.kfs.find((k) => k.position.ticks === t.ticks); }
}
const PARAMS = {
  "AE.ADBE Opacity": [["Opacity", 100]],
  "AE.ADBE Motion": [["Position", new PointF(0.5, 0.5)], ["Scale", 100], ["Crop Left", 0], ["Crop Right", 0]],
  "AE.ADBE Geometry2": [["Anchor Point", new PointF(0.5, 0.5)], ["Position", new PointF(0.5, 0.5)], ["Uniform Scale", true], ["Scale Height", 100], ["Scale Width", 100]],
};
class Component {
  constructor(match) { this.match = match; this.params = (PARAMS[match] || []).map(([n, v]) => new Param(n, v)); }
  async getMatchName() { return this.match; }
  async getDisplayName() { return this.match.split(" ").pop(); }
  getParamCount() { return this.params.length; }
  getParam(i) { return this.params[i]; }
}
class Chain {
  constructor() { this.comps = [new Component("AE.ADBE Opacity"), new Component("AE.ADBE Motion")]; }
  getComponentCount() { return this.comps.length; }
  getComponentAtIndex(i) { return this.comps[i]; }
  createAppendComponentAction(c) { return () => this.comps.push(c); }
}

class TrackItem {
  constructor(clip, start, inP, dur, track) { Object.assign(this, { clip, start, inP, dur, track, disabled: false, chain: new Chain() }); }
  async getName() { return this.clip.name; }
  async getStartTime() { return new TickTime(this.start); }
  async getEndTime() { return new TickTime(this.start + this.dur); }
  async getInPoint() { return new TickTime(this.inP); }
  async getOutPoint() { return new TickTime(this.inP + this.dur); }
  async isDisabled() { return this.disabled; }
  async getProjectItem() { return this.clip; }
  async getComponentChain() { return this.chain; }
  createSetDisabledAction(b) { return () => { this.disabled = b; }; }
  createAddVideoTransitionAction(tr, o) { return () => this.track.transitions.push({ match: tr.match, at: this.start + this.dur, dur: o.dur }); }
}
class Track {
  constructor(name) { this.name = name; this.items = []; this.transitions = []; }
  // like Premiere: transitions can't be read through UXP (nulls)
  getTrackItems(type) { return type === Constants.TrackItemType.CLIP || type === undefined ? [...this.items].sort((a, b) => a.start - b.start) : this.transitions.map(() => null); }
  isMuted() { return false; }
  // overwrite: everything under [s, e) goes, partly covered items get trimmed
  overwrite(item) {
    const s = item.start, e = item.start + item.dur, eps = 1e-6;
    const keep = [];
    for (const t of this.items) {
      const ts = t.start, te = t.start + t.dur;
      if (te <= s + eps || ts >= e - eps) { keep.push(t); continue; }
      if (ts < s) keep.push(new TrackItem(t.clip, ts, t.inP, s - ts, this));
      if (te > e) keep.push(new TrackItem(t.clip, e, t.inP + (e - ts), te - e, this));
    }
    keep.push(item);
    this.items = keep;
  }
}

let seqCounter = 0;
class Sequence {
  constructor(name) {
    this.name = name; this.guid = { toString: () => `guid-${++seqCounter}` };
    this.v = Array.from({ length: 14 }, (_, i) => new Track("V" + (i + 1)));
    this.a = Array.from({ length: 4 }, (_, i) => new Track("A" + (i + 1)));
    this.markers = new MarkerList(); this.inP = 0; this.outP = 0; this.captions = 0;
  }
  async getEndTime() { const all = this.v.flatMap((t) => t.items); return new TickTime(all.reduce((m, t) => Math.max(m, t.start + t.dur), 0)); }
  async getInPoint() { return new TickTime(this.inP); }
  async getOutPoint() { return new TickTime(this.outP); }
  async getFrameSize() { return { width: 1920, height: 1080 }; }
  async getTimebase() { return "8475667200"; }
  async getPlayerPosition() { return new TickTime(0); }
  async getVideoTrackCount() { return this.v.length; }
  async getVideoTrack(i) { return this.v[i]; }
  async getAudioTrackCount() { return this.a.length; }
  async getAudioTrack(i) { return this.a[i]; }
  async getCaptionTrackCount() { return this.captions; }
  createSetInPointAction(t) { return () => { this.inP = t.seconds; }; }
  createSetOutPointAction(t) { return () => { this.outP = t.seconds; }; }
}

class Selection {
  constructor() { this.items = []; }
  addItem(t) { this.items.push(t); return true; }
}

export function createMockPpro(mediaPath, mediaDuration) {
  const root = new Folder("root", null);
  const footage = new Folder("Footage", root);
  root.items.push(footage);
  footage.items.push(new Clip("talk_test.mp4", mediaPath, mediaDuration, footage));
  const sequences = [];
  const project = {
    name: "Mock Project", path: "/mock/project.prproj", active: null,
    async getRootItem() { return root; },
    async getSequences() { return sequences; },
    async getActiveSequence() { return this.active; },
    async setActiveSequence(s) { this.active = s; },
    async openSequence(s) { this.active = s; },
    lockedAccess(cb) { cb(); },
    executeTransaction(cb) { const acts = []; cb({ addAction: (a) => acts.push(a) }); acts.forEach((a) => a()); return true; },
    async importFiles(paths, _s, bin) {
      for (const p of paths) (bin || root).items.push(new Clip(p.split(/[\\/]/).pop(), p, 10, bin || root));
      return true;
    },
    async createSequenceFromMedia(name, clips, bin) {
      const s = new Sequence(name);
      // deliberately leave out the last clip so the server's append fallback is exercised
      let t = 0;
      for (const c of clips.slice(0, Math.max(1, clips.length - 1))) { s.v[0].items.push(new TrackItem(c, t, 0, c.duration, s.v[0])); t += c.duration; }
      sequences.push(s);
      (bin || root).items.push(new Clip(name, null, 0, bin || root, s));
      this.active = s;
      return s;
    },
    async save() { return true; },
    // test helpers (not Premiere API)
    _addSequence(name, bin) { const s = new Sequence(name); sequences.push(s); (bin || root).items.push(new Clip(name, null, 3600, bin || root, s)); return s; },
    _addClip(name, duration, bin, media) { const c = new Clip(name, "/mock/" + name, duration, bin || root, null, media); (bin || root).items.push(c); return c; },
    _addBin(name) { const f = new Folder(name, root); root.items.push(f); return f; },
  };
  return {
    Constants, TickTime, PointF,
    Project: { getActiveProject: async () => project },
    FolderItem: { cast: (x) => (x instanceof Folder ? x : null) },
    ClipProjectItem: { cast: (x) => (x instanceof Clip ? x : null) },
    Markers: { getMarkers: async (owner) => owner.markers },
    Marker: { MARKER_TYPE_COMMENT: "Comment", MARKER_TYPE_CHAPTER: "Chapter" },
    TrackItemSelection: { createEmptySelection: (cb) => { cb(new Selection()); return true; } },
    VideoFilterFactory: { createComponent: async (m) => new Component(m) },
    TransitionFactory: { createVideoTransition: async (m) => ({ match: m }) },
    AddTransitionOptions: class { setApplyToStart() {} setDuration(d) { this.dur = d.seconds; } setForceSingleSided() {} setTransitionAlignment() {} },
    SequenceEditor: {
      getEditor: (seq) => ({
        // in/out are read when the action RUNS (like Premiere 26.5)
        createOverwriteItemAction: (item, time, v, a = 0) => () => {
          if (item.mediaPath && item.mediaPath.endsWith(".srt")) { seq.captions += 1; return; }
          const inP = item.inP ?? 0, dur = (item.outP ?? item.duration) - inP;
          if (item.media.includes("v")) seq.v[v].overwrite(new TrackItem(item, time.seconds, inP, dur, seq.v[v]));
          if (item.media === "a" || (item.seq && item.media.includes("a"))) seq.a[a].overwrite(new TrackItem(item, time.seconds, inP, dur, seq.a[a]));
        },
        createRemoveItemsAction: (sel) => {
          if (!sel.items.length) throw new Error("The script object is no longer valid.");
          return () => { for (const t of sel.items) t.track.items = t.track.items.filter((x) => x !== t); };
        },
      }),
    },
    Exporter: { exportSequenceFrame: async () => true },
    EncoderManager: { getManager: async () => ({ isAMEInstalled: true, exportSequence: async () => true, startBatchEncode: async () => true }) },
    _project: project,
  };
}

// Connect to the server like the UXP panel does.
export function connectMockPanel(port, ppro) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const replacer = (_k, v) => (v && typeof v === "object" && "seconds" in v && "ticks" in v ? v.seconds : v);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", plugin: "mock", token: "", host: { name: "mock", version: "0" } })));
    ws.on("error", reject);
    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "welcome") resolve(ws);
      if (msg.type !== "run") return;
      const logs = [];
      try {
        const fn = new AsyncFunction("ppro", "uxp", "log", msg.code);
        const result = await fn(ppro, {}, (...a) => logs.push(a.join(" ")));
        ws.send(`{"type":"result","id":"${msg.id}","ok":true,"result":${JSON.stringify(result ?? null, replacer)},"logs":${JSON.stringify(logs)}}`);
      } catch (e) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: e.stack || String(e), logs }));
      }
    });
  });
}

// Stand-in for the CEP "MCP QE Helper": answers every ExtendScript call with ok and an empty list.
// There is no QE here: it checks the jsx side of a tool is wired, not what it does in Premiere.
export function connectMockCep(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "cep", plugin: "mock" })));
    ws.on("error", reject);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "welcome") resolve(ws);
      if (msg.type === "runjsx") ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: '{"ok":true,"result":[]}' }));
    });
  });
}
