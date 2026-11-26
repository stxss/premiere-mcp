// ExtendScript side of the MCP QE Helper. Loaded once by the CEP panel (ScriptPath in the manifest).
// Everything the MCP server calls must return a string; use tqJSON().

function tqJSON(v) {
  var t = typeof v;
  if (v === null || v === undefined) return "null";
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return String(v);
  if (t === "string") {
    return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
  }
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(tqJSON(v[i]));
    return "[" + a.join(",") + "]";
  }
  var o = [];
  for (var k in v) if (v.hasOwnProperty(k) && typeof v[k] !== "function") o.push(tqJSON(String(k)) + ":" + tqJSON(v[k]));
  return "{" + o.join(",") + "}";
}

function tqRun(fn) {
  try { return tqJSON({ ok: true, result: fn() }); }
  catch (e) { return tqJSON({ ok: false, error: String(e) + (e.line ? " (line " + e.line + ")" : "") }); }
}

function tqSecs(t) {
  // QE times come back as objects (secs/ticks) or strings depending on version.
  if (t === undefined || t === null) return null;
  if (typeof t === "number") return t;
  if (t.secs !== undefined) return Number(t.secs);
  if (t.ticks !== undefined) return Number(t.ticks) / 254016000000;
  return String(t);
}

function tqActiveQESeq(expectName) {
  app.enableQE();
  var seq = app.project.activeSequence;
  if (!seq) throw new Error("No active sequence");
  if (expectName && seq.name !== expectName) throw new Error("Active sequence is '" + seq.name + "', expected '" + expectName + "'");
  var q = qe.project.getActiveSequence();
  if (!q) throw new Error("QE has no active sequence");
  return q;
}

// List audio items on a track (for checks): [{i, type, name, start, end}]
function tqListAudio(expectName, trackIndex) {
  return tqRun(function () {
    var q = tqActiveQESeq(expectName);
    var tr = q.getAudioTrackAt(trackIndex);
    var out = [];
    for (var j = 0; j < tr.numItems; j++) {
      var it = tr.getItemAt(j);
      out.push({ i: j, type: String(it.type), name: String(it.name), start: tqSecs(it.start), end: tqSecs(it.end) });
    }
    return out;
  });
}

// Put an audio transition on every edit of the given tracks.
// opts: {sequence, tracks:[0,1], transition:"Constant Power", frames:2, alignment:0.5, from:secs, to:secs, dryRun:bool, replaceExisting:bool}
// Edges that already carry a transition (e.g. hand-placed Custom Fades) are skipped unless replaceExisting.
// Each clip gets one at its end (a crossfade if the next clip touches it, else a fade out),
// and one at its start when nothing touches it on the left (fade in after a gap).
function tqAudioTransitions(opts) {
  return tqRun(function () {
    var t0 = new Date().getTime();
    var q = tqActiveQESeq(opts.sequence);
    var trans = qe.project.getAudioTransitionByName(opts.transition || "Constant Power");
    if (!trans) throw new Error("No audio transition named '" + opts.transition + "'");
    var frames = opts.frames || 2;
    var dur = "00:00:00:" + (frames < 10 ? "0" : "") + frames;
    var align = opts.alignment === undefined ? 0.5 : opts.alignment;
    var from = opts.from === undefined ? -1 : opts.from, to = opts.to === undefined ? 1e9 : opts.to;
    var report = [];
    var keep = opts.replaceExisting !== true; // addTransition REPLACES a transition already on that edge
    var tol = 0.5 / 30; // half a frame
    for (var k = 0; k < opts.tracks.length; k++) {
      var ti = opts.tracks[k];
      var tr = q.getAudioTrackAt(ti);
      var added = 0, failed = [], seen = 0, skipped = [];
      var prevType = null;
      // Existing transitions on this track (QE lists transitions and the gaps between them; gaps have no name).
      var existing = [];
      for (var x = 0; x < tr.numTransitions; x++) {
        var tx = tr.getTransitionAt(x);
        if (String(tx.name) !== "") existing.push({ s: tqSecs(tx.start), e: tqSecs(tx.end), name: String(tx.name) });
      }
      var covered = function (t) {
        for (var y = 0; y < existing.length; y++) if (t >= existing[y].s - tol && t <= existing[y].e + tol) return existing[y];
        return null;
      };
      for (var j = 0; j < tr.numItems; j++) {
        var it = tr.getItemAt(j);
        var type = String(it.type);
        if (type !== "Clip") { prevType = type; continue; }
        var s = tqSecs(it.start), e = tqSecs(it.end);
        var inRange = typeof s === "number" ? (s >= from && s <= to) : true;
        var leftOpen = prevType !== "Clip";
        prevType = type;
        if (!inRange) continue;
        seen++;
        var doStart = leftOpen, doEnd = true, c;
        if (keep && doStart && (c = covered(s))) { doStart = false; skipped.push({ at: s, edge: "start", existing: c.name }); }
        if (keep && (c = covered(e))) { doEnd = false; skipped.push({ at: e, edge: "end", existing: c.name }); }
        if (opts.dryRun) { added += (doStart ? 1 : 0) + (doEnd ? 1 : 0); continue; }
        if (doStart) {
          try { it.addTransition(trans, true, dur, "00:00:00:00", align, false, true); added++; }
          catch (err) { failed.push({ at: s, edge: "start", error: String(err) }); }
        }
        if (doEnd) {
          try { it.addTransition(trans, false, dur, "00:00:00:00", align, false, true); added++; }
          catch (err2) { failed.push({ at: e, edge: "end", error: String(err2) }); }
        }
      }
      report.push({ track: ti, clips: seen, added: added, skippedExisting: skipped, failed: failed.slice(0, 20), failedCount: failed.length });
    }
    return { sequence: opts.sequence, transition: opts.transition || "Constant Power", frames: frames, tracks: report, ms: new Date().getTime() - t0 };
  });
}

// Put a transition on specific edit points, each with its own length (e.g. per-cut fades set in a review step).
// opts: {sequence, tracks:[0,1], edges:[{t:secs, frames:N, transition?}], transition:"Constant Power", alignment:0.5, replaceExisting:true, dryRun}
// An edge at t is: the END of a clip ending at t (crossfade if the next clip touches it, else fade out), or the START of a
// clip starting at t with nothing touching it on the left (fade in). Matched within half a frame.
function tqAudioEdges(opts) {
  return tqRun(function () {
    var t0 = new Date().getTime();
    var q = tqActiveQESeq(opts.sequence);
    var cache = {};
    var getTrans = function (name) {
      if (!cache[name]) { cache[name] = qe.project.getAudioTransitionByName(name); if (!cache[name]) throw new Error("No audio transition named '" + name + "'"); }
      return cache[name];
    };
    var align = opts.alignment === undefined ? 0.5 : opts.alignment;
    var replace = opts.replaceExisting !== false;
    var tol = 0.5 / 30;
    var durOf = function (f) { return "00:00:00:" + (f < 10 ? "0" : "") + f; };
    var unmatched = [], failed = [], skipped = [], applied = 0;
    var edges = [];
    for (var k = 0; k < opts.tracks.length; k++) {
      var tr = q.getAudioTrackAt(opts.tracks[k]);
      var existing = [];
      for (var x = 0; x < tr.numTransitions; x++) { var tx = tr.getTransitionAt(x); if (String(tx.name) !== "") existing.push({ s: tqSecs(tx.start), e: tqSecs(tx.end) }); }
      var prevType = null;
      for (var j = 0; j < tr.numItems; j++) {
        var it = tr.getItemAt(j); var type = String(it.type);
        if (type !== "Clip") { prevType = type; continue; }
        if (prevType !== "Clip") edges.push({ track: opts.tracks[k], t: tqSecs(it.start), item: it, atStart: true, existing: existing });
        edges.push({ track: opts.tracks[k], t: tqSecs(it.end), item: it, atStart: false, existing: existing });
        prevType = type;
      }
    }
    for (var n = 0; n < opts.edges.length; n++) {
      var want = opts.edges[n]; var hit = 0;
      for (var m = 0; m < edges.length; m++) {
        var ed = edges[m]; if (Math.abs(ed.t - want.t) > tol) continue;
        var cov = false;
        for (var y = 0; y < ed.existing.length; y++) if (ed.t >= ed.existing[y].s - tol && ed.t <= ed.existing[y].e + tol) cov = true;
        if (cov && !replace) { skipped.push({ t: want.t, track: ed.track }); continue; }
        if (opts.dryRun) { hit++; continue; }
        try { ed.item.addTransition(getTrans(want.transition || opts.transition || "Constant Power"), ed.atStart, durOf(want.frames || 2), "00:00:00:00", align, false, true); hit++; }
        catch (err) { failed.push({ t: want.t, track: ed.track, error: String(err) }); }
      }
      if (!hit) unmatched.push(want.t);
      applied += hit;
    }
    return { sequence: opts.sequence, edges: opts.edges.length, applied: applied, unmatched: unmatched, skippedExisting: skipped, failed: failed.slice(0, 20), ms: new Date().getTime() - t0 };
  });
}
