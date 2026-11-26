// Helper library prepended to every script that runs inside Premiere Pro.
// It runs as the body of an async function with (ppro, uxp, log) in scope.
export const PRELUDE = String.raw`
const C = ppro.Constants;
const T = (s) => ppro.TickTime.createWithSeconds(Number(s) || 0);
const secs = (t) => (t && typeof t.seconds === "number" ? Math.round(t.seconds * 1000) / 1000 : null);

async function getProject() {
  const p = await ppro.Project.getActiveProject();
  if (!p) throw new Error("No project is open in Premiere Pro.");
  return p;
}

// Build actions and commit them as one undoable step.
function tx(project, label, build) {
  let ok = false;
  project.lockedAccess(() => {
    const actions = [].concat(build() || []).filter(Boolean);
    if (!actions.length) { ok = true; return; }
    ok = project.executeTransaction((ca) => { for (const a of actions) ca.addAction(a); }, label);
  });
  if (!ok) throw new Error("Premiere rejected the edit: " + label);
  return ok;
}

async function kindOf(item) {
  if (ppro.FolderItem.cast(item)) return "bin";
  const clip = ppro.ClipProjectItem.cast(item);
  if (clip) {
    try {
      const ct = await clip.getContentType();
      if (ct === C.ContentType.SEQUENCE) return "sequence";
    } catch (e) { /* ignore */ }
    return "clip";
  }
  return "other";
}

// Flat list of every project item with its bin path.
async function walk(project) {
  const root = await project.getRootItem();
  const out = [];
  async function rec(folder, prefix) {
    const items = await folder.getItems();
    for (const item of items) {
      const kind = await kindOf(item);
      const p = prefix ? prefix + "/" + item.name : item.name;
      const entry = { item, name: item.name, path: p, kind };
      if (kind === "clip") {
        try { entry.mediaPath = await ppro.ClipProjectItem.cast(item).getMediaFilePath(); } catch (e) { /* ignore */ }
      }
      out.push(entry);
      if (kind === "bin") await rec(ppro.FolderItem.cast(item), p);
    }
  }
  await rec(root, "");
  return { root, items: out };
}

const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();

// ref may be a bin path ("Footage/A-cam/clip.mp4"), a plain item name, or a media file path.
async function findItem(project, ref, kinds) {
  const { items } = await walk(project);
  const pool = kinds ? items.filter((e) => kinds.includes(e.kind)) : items;
  const r = norm(ref);
  let hit = pool.find((e) => norm(e.path) === r)
    || pool.find((e) => e.mediaPath && norm(e.mediaPath) === r)
    || pool.find((e) => norm(e.name) === r);
  if (!hit) {
    const base = r.split("/").pop();
    hit = pool.find((e) => e.mediaPath && norm(e.mediaPath).split("/").pop() === base);
  }
  if (!hit) throw new Error("Project item not found: " + ref);
  return hit;
}

// Find a bin by path, creating missing levels when create=true. Empty path = root.
async function findBin(project, binPath, create) {
  const root = await project.getRootItem();
  if (!binPath) return root;
  const parts = String(binPath).split("/").map((s) => s.trim()).filter(Boolean);
  let current = root;
  for (const part of parts) {
    const children = await current.getItems();
    let next = children.map((c) => ppro.FolderItem.cast(c)).find((f) => f && f.name === part);
    if (!next) {
      if (!create) throw new Error("Bin not found: " + binPath);
      tx(project, "Create bin " + part, () => current.createBinAction(part, false));
      const again = await current.getItems();
      next = again.map((c) => ppro.FolderItem.cast(c)).find((f) => f && f.name === part);
      if (!next) throw new Error("Could not create bin: " + part);
    }
    current = next;
  }
  return current;
}

async function getSeq(project, name) {
  if (!name) {
    const s = await project.getActiveSequence();
    if (!s) throw new Error("No active sequence. Open a sequence or pass a sequence name.");
    return s;
  }
  const all = await project.getSequences();
  const s = all.find((x) => x.name === name) || all.find((x) => norm(x.name) === norm(name));
  if (!s) throw new Error("Sequence not found: " + name + ". Available: " + all.map((x) => x.name).join(", "));
  return s;
}

const MARKER_TYPES = { comment: "Comment", chapter: "Chapter", segmentation: "Segmentation", weblink: "WebLink" };
function markerType(t) {
  const key = String(t || "comment").toLowerCase();
  const constName = "MARKER_TYPE_" + key.toUpperCase();
  return (ppro.Marker && ppro.Marker[constName]) || MARKER_TYPES[key] || "Comment";
}

async function trackItemInfo(ti) {
  const o = {};
  try { o.name = await ti.getName(); } catch (e) { /* ignore */ }
  try { o.start = secs(await ti.getStartTime()); } catch (e) { /* ignore */ }
  try { o.end = secs(await ti.getEndTime()); } catch (e) { /* ignore */ }
  try { o.sourceIn = secs(await ti.getInPoint()); } catch (e) { /* ignore */ }
  try { o.sourceOut = secs(await ti.getOutPoint()); } catch (e) { /* ignore */ }
  try { o.disabled = await ti.isDisabled(); } catch (e) { /* ignore */ }
  try {
    const pi = await ti.getProjectItem();
    const clip = pi && ppro.ClipProjectItem.cast(pi);
    if (clip) o.mediaPath = await clip.getMediaFilePath();
  } catch (e) { /* ignore */ }
  return o;
}

async function listMarkers(owner) {
  const m = await ppro.Markers.getMarkers(owner);
  return m.getMarkers().map((mk) => ({
    name: mk.getName(),
    type: mk.getType(),
    start: secs(mk.getStart()),
    duration: secs(mk.getDuration()),
    comments: mk.getComments(),
    colorIndex: mk.getColorIndex(),
  }));
}

async function sequenceInfo(seq, opts) {
  opts = opts || {};
  const info = { name: seq.name, guid: String(seq.guid) };
  try { info.end = secs(await seq.getEndTime()); } catch (e) { /* ignore */ }
  try { info.inPoint = secs(await seq.getInPoint()); info.outPoint = secs(await seq.getOutPoint()); } catch (e) { /* ignore */ }
  try { const r = await seq.getFrameSize(); info.frameSize = { width: r.width, height: r.height }; } catch (e) { /* ignore */ }
  try { info.timebase = await seq.getTimebase(); } catch (e) { /* ignore */ }
  try { info.playhead = secs(await seq.getPlayerPosition()); } catch (e) { /* ignore */ }
  if (opts.tracks !== false) {
    info.videoTracks = [];
    info.audioTracks = [];
    const vc = await seq.getVideoTrackCount();
    for (let i = 0; i < vc; i++) {
      const tr = await seq.getVideoTrack(i);
      const items = tr.getTrackItems(C.TrackItemType.CLIP, false);
      const list = [];
      for (const ti of items.slice(0, opts.maxItems || 500)) list.push(await trackItemInfo(ti));
      info.videoTracks.push({ index: i, name: tr.name, muted: tr.isMuted(), clipCount: items.length, clips: list });
    }
    const ac = await seq.getAudioTrackCount();
    for (let i = 0; i < ac; i++) {
      const tr = await seq.getAudioTrack(i);
      const items = tr.getTrackItems(C.TrackItemType.CLIP, false);
      const list = [];
      for (const ti of items.slice(0, opts.maxItems || 500)) list.push(await trackItemInfo(ti));
      info.audioTracks.push({ index: i, name: tr.name, muted: tr.isMuted(), clipCount: items.length, clips: list });
    }
    try { info.captionTrackCount = await seq.getCaptionTrackCount(); } catch (e) { /* ignore */ }
  }
  if (opts.markers !== false) {
    try { info.markers = await listMarkers(seq); } catch (e) { info.markers = "unavailable: " + e.message; }
  }
  return info;
}
`;

export function script(args, body) {
  return `${PRELUDE}\nconst args = ${JSON.stringify(args ?? {})};\n${body}`;
}
