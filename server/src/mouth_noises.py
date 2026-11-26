#!/usr/bin/env python3
"""Find mouth noises (tongue clicks, lip smacks) just before speech at the start of each segment,
and optionally just after speech at the end.

Input : --input media, --segments JSON file: [[start, end], ...] in source seconds.
Output: JSON on stdout: {"segments": [{index, start, end, speech_onset, clicks: [[s, e, peak_db]],
         clean_start, head_fixable, speech_offset, tail_clicks, clean_end, tail_fixable}], ...}

How: 48 kHz mono; RMS in 5 ms hops. Speech onset = first point where level stays >= floor+18 dB for
60 ms. A mouth noise = short (< 120 ms) burst of high-frequency energy above the floor before the
onset. clean_start = just after the last such burst, if that still leaves >= 15 ms before the speech.
Pure numpy; decodes with ffmpeg.
"""
import argparse
import json
import subprocess
import sys

import numpy as np

SR = 48000
HOP = 240  # 5 ms


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-7))


def frames_rms(x):
    n = len(x) // HOP
    if n == 0:
        return np.zeros(0)
    return np.sqrt((x[: n * HOP].reshape(n, HOP) ** 2).mean(1))


def events(mask, max_gap):
    """Group True hops into [first, last] events, merging gaps of <= max_gap hops."""
    idx = np.flatnonzero(mask)
    out = []
    for i in idx:
        if out and i - out[-1][1] <= max_gap + 1:
            out[-1][1] = i
        else:
            out.append([i, i])
    return out


def analyse(sig, hp, t0, t1, floor_db, floor_hp_db, a, direction):
    """direction 'head': look from t0 forward; 'tail': from t1 backward."""
    i0, i1 = int(t0 * SR), int(t1 * SR)
    seg, seg_hp = sig[i0:i1], hp[i0:i1]
    lv, lv_hp = db(frames_rms(seg)), db(frames_rms(seg_hp))
    n = len(lv)
    if n < 20:
        return None
    speech = lv >= floor_db + a.speech_db
    need = int(a.speech_ms / 5)
    run = np.convolve(speech.astype(int), np.ones(need, int), "valid") >= need
    if direction == "head":
        hits = np.flatnonzero(run)
        if not len(hits):
            return {"speech": None, "clicks": [], "clean": None, "fixable": False}
        k = int(hits[0])  # first hop of sustained speech
        # walk back to where the level first rose clearly above the floor (soft onsets like "h", "s")
        while k > 0 and lv[k - 1] >= floor_db + a.speech_db * 0.5:
            k -= 1
        onset = t0 + k * 0.005
        zone = slice(0, max(0, k - int(a.guard_ms / 5)))
    else:
        hits = np.flatnonzero(run)
        if not len(hits):
            return {"speech": None, "clicks": [], "clean": None, "fixable": False}
        k = int(hits[-1]) + need  # hop after sustained speech ends
        while k < n and lv[k] >= floor_db + a.speech_db * 0.5:
            k += 1
        onset = t0 + k * 0.005
        zone = slice(min(n, k + int(a.guard_ms / 5)), n)
    z_hp = lv_hp[zone]
    base = zone.start
    loud = z_hp >= floor_hp_db + a.click_db
    clicks = []
    for s, e in events(loud, 3):
        dur = (e - s + 1) * 5
        if dur <= a.max_click_ms:
            clicks.append([round(t0 + (base + s) * 0.005, 3), round(t0 + (base + e + 1) * 0.005, 3),
                           round(float(z_hp[s:e + 1].max() - floor_hp_db), 1)])
    if direction == "head":
        clean = (clicks[-1][1] + 0.012) if clicks else None
        fixable = bool(clicks) and bool(clean <= onset - 0.015)
    else:
        clean = (clicks[0][0] - 0.012) if clicks else None
        fixable = bool(clicks) and bool(clean >= onset + 0.015)
    return {"speech": round(onset, 3), "clicks": clicks, "clean": round(float(clean), 3) if clean else None, "fixable": fixable}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--segments", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--audio-stream", default="0")
    ap.add_argument("--speech-db", type=float, default=18.0, help="speech = this many dB over the noise floor")
    ap.add_argument("--speech-ms", type=float, default=60.0)
    ap.add_argument("--click-db", type=float, default=14.0, help="noise burst = this many dB of >2 kHz energy over floor")
    ap.add_argument("--max-click-ms", type=float, default=120.0)
    ap.add_argument("--guard-ms", type=float, default=25.0, help="ignore bursts this close to speech (it is the word itself)")
    ap.add_argument("--tails", type=int, default=1)
    a = ap.parse_args()

    segs = json.load(open(a.segments, encoding="utf-8"))
    segs = [s if isinstance(s, list) else [s["start"], s["end"]] for s in segs]
    t_lo = max(0.0, min(s[0] for s in segs) - 1.0)
    t_hi = max(s[1] for s in segs) + 1.0
    p = subprocess.run([a.ffmpeg, "-nostdin", "-v", "error", "-ss", f"{t_lo:.3f}", "-t", f"{t_hi - t_lo:.3f}",
                        "-i", a.input, "-map", f"0:a:{a.audio_stream}", "-ac", "1", "-ar", str(SR),
                        "-f", "f32le", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        print("ERROR ffmpeg: " + p.stderr.decode(errors="replace")[-500:], file=sys.stderr)
        sys.exit(2)
    raw = np.frombuffer(p.stdout, np.float32)
    # pad so absolute times index directly
    sig = np.concatenate([np.zeros(int(t_lo * SR), np.float32), raw])
    # crude 2 kHz high-pass: subtract a ~1 ms moving average (clicks are broadband/high, voice is mostly low)
    k = 24
    hp = sig - np.convolve(sig, np.ones(k, np.float32) / k, "same")

    # noise floors from the quietest 10% of 5 ms hops inside all segments
    lv_all, hp_all = [], []
    for s, e in segs:
        lv_all.append(db(frames_rms(sig[int(s * SR):int(e * SR)])))
        hp_all.append(db(frames_rms(hp[int(s * SR):int(e * SR)])))
    floor_db = float(np.percentile(np.concatenate(lv_all), 10))
    floor_hp_db = float(np.percentile(np.concatenate(hp_all), 10))

    out = []
    for i, (s, e) in enumerate(segs):
        h = analyse(sig, hp, s, min(e, s + 1.2), floor_db, floor_hp_db, a, "head")
        rec = {"index": i, "start": s, "end": e}
        if h:
            rec.update({"speech_onset": h["speech"], "clicks": h["clicks"], "clean_start": h["clean"], "head_fixable": h["fixable"]})
        if a.tails:
            t = analyse(sig, hp, max(s, e - 1.2), e, floor_db, floor_hp_db, a, "tail")
            if t:
                rec.update({"speech_offset": t["speech"], "tail_clicks": t["clicks"], "clean_end": t["clean"], "tail_fixable": t["fixable"]})
        out.append(rec)
    print(json.dumps({"noise_floor_db": round(floor_db, 1), "hf_floor_db": round(floor_hp_db, 1), "segments": out}))


if __name__ == "__main__":
    main()
