#!/usr/bin/env python3
"""GPU subject matte for static-camera talking-head footage, written as ProRes 4444 with alpha.

Modes
  hybrid (default, for green/blue screens): alpha = max(AI matte, clean-plate difference key)
      * clean plate = the empty screen, estimated from ~40 frames spread over the range (per-pixel
        median of screen-coloured pixels, holes filled smoothly). Because every pixel is compared with
        what the screen looks like *there*, uneven lighting, dark corners and compression blocks key
        out cleanly, and non-person foreground (chair, desk, mic) is kept.
      * AI matte = Robust Video Matting (vendored in ./rvm, GPL-3.0): temporally stable, keeps people
        solid even where a dark shirt or dark hair is close to the screen colour.
      * colour = unmixed against the plate in soft edges, plus green/blue despill near edges.
  rvm: AI matte only (any background, but it drops non-person objects like chairs).

Video mode   : frames [start_frame, end_frame) -> .mov ProRes 4444, straight alpha, output frame 0 = input start_frame.
Preview mode : --preview-times 12.5,40 -> RGBA PNGs at those input times (+ plate.png) for a quick look.
Progress on stderr: PROGRESS <frames_done> <frames_total>
"""
import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = {
    "resnet50": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50.pth",
    "mobilenetv3": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth",
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def load_model(variant, models_dir, device, dtype):
    import torch
    sys.path.insert(0, HERE)
    from rvm.model import MattingNetwork
    m = MattingNetwork(variant)
    os.makedirs(models_dir, exist_ok=True)
    sd = torch.hub.load_state_dict_from_url(WEIGHTS[variant], model_dir=models_dir, map_location="cpu",
                                            progress=False, weights_only=True)
    m.load_state_dict(sd)
    return m.eval().to(device, dtype)


# ---------------------------------------------------------------- decoding
def ffmpeg_reader(ffmpeg, src, w, h, start_frame, n_frames, out_q, fps=None, t_offset=None):
    """Decode exactly frames [start_frame, start_frame+n_frames) as rgb24 into out_q (None = end).
    With fps/t_offset (stream start_time) it seeks close first, then trims by exact timestamps;
    otherwise it trims by frame index from the start of the file (slower for late ranges)."""
    import numpy as np
    if fps and t_offset is not None and start_frame > 0:
        s = t_offset + (start_frame - 0.5) / fps
        e = t_offset + (start_frame + n_frames - 0.5) / fps
        pre = ["-ss", f"{max(0.0, s - 3.0):.6f}", "-copyts"]
        vf = f"trim=start={s:.6f}:end={e:.6f},setpts=PTS-STARTPTS"
    else:
        pre = []
        vf = f"trim=start_frame={start_frame}:end_frame={start_frame + n_frames},setpts=PTS-STARTPTS"
    cmd = [ffmpeg, "-nostdin", "-v", "error"] + pre + ["-i", src, "-map", "0:v:0", "-vf", vf,
           "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    # stderr must not be a pipe nobody reads: seeking into long-GOP HEVC prints reference errors,
    # the pipe fills up and ffmpeg (and this job) would hang.
    size = w * h * 3
    p = None
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=size * 2)
        got = 0
        while got < n_frames:
            buf = p.stdout.read(size)
            if not buf or len(buf) < size:
                break
            out_q.put(np.frombuffer(buf, np.uint8).reshape(h, w, 3))
            got += 1
        if got < n_frames:
            log(f"WARNING decoder returned {got} of {n_frames} frames from frame {start_frame}")
    finally:
        out_q.put(None)
        if p:
            p.stdout.close()
            p.kill()
            p.wait()


def stream_start(ffprobe, src):
    r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=start_time",
                        "-of", "default=nw=1:nk=1", src], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def grab_frame(ffmpeg, src, t, w, h):
    import numpy as np
    out = subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", src, "-map", "0:v:0",
                          "-frames:v", "1", "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    if len(out) < w * h * 3:
        return None
    return np.frombuffer(out[: w * h * 3], np.uint8).reshape(h, w, 3)


# ---------------------------------------------------------------- clean plate
def screen_mask(x, screen):
    """x: [3,H,W] 0..1. True where the pixel looks like the screen colour."""
    r, g, b = x[0], x[1], x[2]
    if screen == "blue":
        r, g, b = r, b, g  # treat blue as the dominant channel
    return (g > r * 1.15) & (g > b * 1.5 + 0.01) & (g - r.maximum(b) > 0.03)


def fill_holes(img, known, levels=8):
    """Fill unknown pixels smoothly from known ones (normalized-convolution pyramid). img [C,H,W], known [H,W] 0/1."""
    import torch
    import torch.nn.functional as F
    pyr = [(img * known, known[None])]
    for _ in range(levels):
        n, d = pyr[-1]
        pyr.append((F.avg_pool2d(n[None], 2, ceil_mode=True)[0], F.avg_pool2d(d[None], 2, ceil_mode=True)[0]))
    n, d = pyr[-1]
    est = n / d.clamp(min=1e-6)
    for n, d in reversed(pyr[:-1]):
        up = F.interpolate(est[None], size=n.shape[-2:], mode="bilinear", align_corners=False)[0]
        w = d.clamp(0, 1)
        est = (n / d.clamp(min=1e-6)) * w + up * (1 - w)
    return est


def build_plate(a, W, H, fps, start_frame, end_frame, dev, screen):
    import numpy as np
    import torch
    import torch.nn.functional as F
    sw, sh = W // 4, H // 4
    t0, t1 = start_frame / fps, end_frame / fps
    n = max(8, a.plate_samples)
    times = [t0 + (t1 - t0) * (i + 0.5) / n for i in range(n)]
    frames = []
    for i, t in enumerate(times):
        f = grab_frame(a.ffmpeg, a.input, t, sw, sh)
        if f is not None:
            frames.append(torch.from_numpy(f.copy()).permute(2, 0, 1).float().div(255))
        if i % 8 == 0:
            log(f"STATUS building clean plate {i + 1}/{n}")
    if not frames:
        raise RuntimeError("could not read frames for the clean plate")
    st = torch.stack(frames).to(dev)  # [N,3,h,w]
    m = torch.stack([screen_mask(f, screen) for f in st]).float()
    m = 1 - F.max_pool2d(1 - m[:, None], 9, 1, 4)[:, 0]  # erode: stay away from subject edges
    vals = st.clone()
    vals[m[:, None].expand_as(vals) < 0.5] = float("nan")
    plate = torch.nanmedian(vals, dim=0).values  # [3,h,w]
    known = (~torch.isnan(plate[0])).float()
    plate = torch.nan_to_num(plate, 0.0)
    k = 9  # smooth out compression blocks in the plate
    pad = lambda x: F.pad(x[None], (k // 2,) * 4, mode="replicate")
    num = F.avg_pool2d(pad(plate * known), k, 1)[0]
    den = F.avg_pool2d(pad(known[None]), k, 1)[0, 0]
    plate = num / den.clamp(min=1e-3)
    known = (den > 0.3).float()
    plate = fill_holes(plate, known)
    coverage = float(known.mean())
    full = F.interpolate(plate[None], size=(H, W), mode="bilinear", align_corners=False)[0].clamp(0, 1)
    return full, coverage


# ---------------------------------------------------------------- per-frame alpha + colour
def diff_alpha(src, plate, lo, hi, screen):
    """src [T,3,H,W], plate [3,H,W] -> [T,1,H,W]"""
    d = src - plate
    dist = (d * d).sum(1, keepdim=True).sqrt()
    gi, oi = (1, [0, 2]) if screen == "green" else (2, [0, 1])
    dom_p = plate[gi] - plate[oi].max(0).values
    dom_s = src[:, gi] - src[:, oi].max(1).values
    drop = (dom_p[None] - dom_s).clamp(min=0)[:, None]
    score = dist.maximum(drop * 1.5)
    return ((score - lo) / (hi - lo)).clamp(0, 1)


def despill(rgb, screen, amount):
    import torch
    r, g, b = rgb[:, 0:1], rgb[:, 1:2], rgb[:, 2:3]
    if screen == "green":
        g = g - (g - (r + b) / 2).clamp(min=0) * amount
    else:
        b = b - (b - (r + g) / 2).clamp(min=0) * amount
    return torch.cat([r, g, b], 1)


def compose(src, alpha, plate, fgr, a):
    import torch
    import torch.nn.functional as F
    if a.mode == "rvm" or plate is None:
        w = ((alpha - 0.85) / 0.15).clamp(0, 1)
        rgb = src * w + fgr * (1 - w)
    else:
        unmixed = ((src - (1 - alpha) * plate[None]) / alpha.clamp(min=0.05)).clamp(0, 1)
        rgb = torch.where(alpha > 0.98, src, unmixed)
    if a.despill > 0 and a.screen != "none":
        # despill only in a band around soft/edge pixels (keeps interior colours untouched)
        edge = (alpha < 0.995).to(alpha.dtype)
        band = F.max_pool2d(edge, a.edge_band * 2 + 1, 1, a.edge_band)
        rgb = rgb * (1 - band) + despill(rgb, a.screen, a.despill) * band
    return torch.cat([rgb, alpha], 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True, help=".mov (video mode) or a folder (preview mode)")
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--fps", required=True, help="rational, e.g. 30/1 or 30000/1001")
    ap.add_argument("--start-frame", type=int, default=0)
    ap.add_argument("--end-frame", type=int, required=True)
    ap.add_argument("--mode", default="hybrid", choices=["hybrid", "rvm"])
    ap.add_argument("--screen", default="green", choices=["green", "blue", "none"])
    ap.add_argument("--model", default="resnet50", choices=list(WEIGHTS))
    ap.add_argument("--downsample", type=float, default=0, help="AI matte working scale, 0 = auto")
    ap.add_argument("--diff-low", type=float, default=0.06, help="plate difference below this = background")
    ap.add_argument("--diff-high", type=float, default=0.16, help="plate difference above this = solid")
    ap.add_argument("--plate-samples", type=int, default=40)
    ap.add_argument("--despill", type=float, default=1.0)
    ap.add_argument("--edge-band", type=int, default=6, help="px around soft edges that get despilled")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--chunk", type=int, default=4, help="frames per GPU step")
    ap.add_argument("--prores-q", type=int, default=6, help="prores_ks qscale, lower = bigger/better")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--preview-times", default="")
    ap.add_argument("--warmup", type=float, default=1.5)
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--ranges", default="", help="only these source frame ranges 's:e,s:e' written back to back (see --map-out)")
    ap.add_argument("--map-out", default="", help="JSON file describing where each range sits in the output")
    ap.add_argument("--range-warmup", type=int, default=12, help="frames decoded before each range to settle the AI matte")
    a = ap.parse_args()

    try:
        import numpy as np
        import torch
    except ImportError as e:
        log(f"ERROR missing dependency ({e}). Run matte_setup.")
        sys.exit(3)
    if a.screen == "none" and a.mode == "hybrid":
        a.mode = "rvm"

    dev = ("cuda" if torch.cuda.is_available() else "cpu") if a.device == "auto" else a.device
    if dev == "cuda" and not torch.cuda.is_available():
        log("ERROR CUDA requested but this torch has no CUDA. Run matte_setup.")
        sys.exit(4)
    dtype = torch.float16 if dev == "cuda" else torch.float32
    W, H = a.width, a.height
    ds = a.downsample or min(1.0, 540 / min(W, H))
    num, den = (a.fps.split("/") + ["1"])[:2]
    fps = float(num) / float(den)
    log(f"STATUS device={dev} mode={a.mode} model={a.model} downsample={ds:.3f} size={W}x{H} fps={fps:.3f}")
    t_start = time.time()
    t_off = stream_start(a.ffprobe, a.input)
    model = load_model(a.model, a.models_dir, dev, dtype)

    plate, coverage = None, None
    if a.mode == "hybrid":
        plate32, coverage = build_plate(a, W, H, fps, a.start_frame, a.end_frame, dev, a.screen)
        plate = plate32.to(dtype)
        log(f"STATUS plate ready (screen visible in {coverage * 100:.0f}% of the frame)")

    def run_range(start_frame, n, on_frames):
        q = queue.Queue(maxsize=a.chunk * 3)
        th = threading.Thread(target=ffmpeg_reader, args=(a.ffmpeg, a.input, W, H, start_frame, n, q, fps, t_off), daemon=True)
        th.start()
        rec = [None] * 4
        done, ended = 0, False
        with torch.inference_mode():
            while not ended:
                frames = []
                while len(frames) < a.chunk:
                    try:
                        f = q.get(timeout=300)
                    except queue.Empty:
                        raise RuntimeError(f"decoder stalled at frame {start_frame + done + len(frames)}")
                    if f is None:
                        ended = True
                        break
                    frames.append(f)
                if not frames:
                    break
                src = torch.from_numpy(np.stack(frames)).to(dev, non_blocking=True)
                src = src.permute(0, 3, 1, 2).to(dtype).div_(255)  # [T,3,H,W]
                fgr, pha, *rec = model(src[None], *rec, downsample_ratio=ds)
                fgr, alpha = fgr[0], pha[0]
                if plate is not None:
                    alpha = alpha.maximum(diff_alpha(src, plate, a.diff_low, a.diff_high, a.screen))
                on_frames(done, compose(src, alpha, plate, fgr, a))
                done += len(frames)
        th.join()
        return done

    to_u8 = lambda x: x.float().clamp(0, 1).mul(255).round().byte()

    if a.preview_times:
        os.makedirs(a.output, exist_ok=True)
        from PIL import Image
        results = []
        if plate is not None:
            pp = os.path.join(a.output, "plate.png")
            Image.fromarray(to_u8(plate).permute(1, 2, 0).cpu().numpy(), "RGB").save(pp)
        for t in [float(x) for x in a.preview_times.split(",") if x.strip()]:
            target = int(round(t * fps))
            s = max(0, target - int(round(a.warmup * fps)))
            keep = {}

            def grab(i0, out, s=s, target=target, keep=keep):
                for k in range(out.shape[0]):
                    if s + i0 + k == target:
                        keep["img"] = to_u8(out[k]).permute(1, 2, 0).cpu().numpy()

            run_range(s, target - s + 1, grab)
            p = os.path.join(a.output, f"matte_{t:.3f}.png")
            Image.fromarray(keep["img"], "RGBA").save(p)
            results.append({"time": t, "path": p})
        print(json.dumps({"previews": results, "plate": os.path.join(a.output, "plate.png") if plate is not None else None,
                          "plate_coverage": coverage, "device": dev, "downsample": ds,
                          "elapsed_seconds": round(time.time() - t_start, 1)}))
        return

    ranges = [tuple(int(v) for v in r.split(":")) for r in a.ranges.split(",") if r.strip()] or [(a.start_frame, a.end_frame)]
    n_total = sum(e - s for s, e in ranges)
    os.makedirs(os.path.dirname(os.path.abspath(a.output)), exist_ok=True)
    import tempfile
    enc_log = tempfile.TemporaryFile()
    enc = subprocess.Popen(
        [a.ffmpeg, "-nostdin", "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-r", a.fps, "-i", "-",
         "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
         "-vendor", "apl0", "-qscale:v", str(a.prores_q), a.output],
        stdin=subprocess.PIPE, stderr=enc_log)
    wq = queue.Queue(maxsize=3)

    def writer():
        while True:
            item = wq.get()
            if item is None:
                break
            enc.stdin.write(item)

    wt = threading.Thread(target=writer, daemon=True)
    wt.start()
    last = [0.0]

    written = [0]

    def make_emit(skip):
        def emit(i0, out):
            k0 = max(0, skip - i0)
            if k0 >= out.shape[0]:
                return
            out = out[k0:]
            wq.put(to_u8(out).permute(0, 2, 3, 1).contiguous().cpu().numpy().tobytes())
            written[0] += out.shape[0]
            now = time.time()
            if now - last[0] > 2:
                last[0] = now
                log(f"PROGRESS {written[0]} {n_total}")
        return emit

    mapping = []
    for s_f, e_f in ranges:
        warm = min(a.range_warmup, s_f)
        at = written[0]
        run_range(s_f - warm, (e_f - s_f) + warm, make_emit(warm))
        mapping.append({"src_start_frame": s_f, "src_end_frame": e_f, "matte_start_frame": at,
                        "frames_written": written[0] - at})
    done = written[0]
    if a.map_out:
        with open(a.map_out, "w", encoding="utf-8") as fh:
            json.dump({"source": a.input, "matte": a.output, "fps": a.fps, "ranges": mapping}, fh, indent=1)
    wq.put(None)
    wt.join()
    enc.stdin.close()
    code = enc.wait()
    enc_log.seek(0)
    err = enc_log.read().decode(errors="replace")
    if code != 0:
        log("ERROR encoder failed: " + err[-800:])
        sys.exit(5)
    if done != n_total:
        log(f"WARNING decoded {done} of {n_total} frames")
    print(json.dumps({"output": a.output, "frames": done, "start_frame": ranges[0][0], "ranges": len(ranges),
                      "map": a.map_out or None, "device": dev,
                      "mode": a.mode, "downsample": ds, "plate_coverage": coverage,
                      "elapsed_seconds": round(time.time() - t_start, 1)}))


if __name__ == "__main__":
    main()
