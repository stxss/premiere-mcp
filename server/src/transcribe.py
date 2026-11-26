#!/usr/bin/env python3
"""Local Whisper transcription with word timestamps (faster-whisper).

Writes JSON: {"source", "language", "duration", "model", "segments": [{"start","end","text","words":[{"start","end","word","prob"}]}]}
Progress is printed to stderr as lines: PROGRESS <seconds_done> <total_seconds>
"""
import argparse
import json
import os
import subprocess
import sys
import time


def add_nvidia_dll_dirs():
    """Make pip-installed NVIDIA libraries (nvidia-cublas-cu12, nvidia-cudnn-cu12) loadable on Windows,
    so the GPU works without installing the full CUDA toolkit."""
    if os.name != "nt":
        return
    import site
    bases = list(getattr(site, "getsitepackages", lambda: [])()) + [site.getusersitepackages()]
    for base in bases:
        for sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
            d = os.path.join(base, "nvidia", sub, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default=None)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute-type", default="default")
    ap.add_argument("--vad", default="1")
    ap.add_argument("--initial-prompt", default=None)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--audio-stream", default="0")
    a = ap.parse_args()

    add_nvidia_dll_dirs()
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError:
        print("ERROR faster-whisper is not installed. Run: pip install faster-whisper", file=sys.stderr)
        sys.exit(3)

    t0 = time.time()
    # Decode with ffmpeg ourselves (16 kHz mono float) instead of faster-whisper's PyAV
    # decoder, which breaks with some PyAV versions and some camera codecs.
    print("STATUS decoding audio", file=sys.stderr, flush=True)
    proc = subprocess.run(
        [a.ffmpeg, "-nostdin", "-v", "error", "-i", a.input, "-map", f"0:a:{a.audio_stream}",
         "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0 or not proc.stdout:
        print("ERROR ffmpeg could not decode audio: " + proc.stderr.decode(errors="ignore")[-400:], file=sys.stderr)
        sys.exit(4)
    audio = np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768.0

    def run(device, compute_type):
        print(f"STATUS loading model {a.model} on {device} ({compute_type}); first run downloads it", file=sys.stderr, flush=True)
        model = WhisperModel(a.model, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            audio,
            language=a.language or None,
            word_timestamps=True,
            vad_filter=a.vad == "1",
            initial_prompt=a.initial_prompt or None,
            condition_on_previous_text=False,
        )
        total = float(info.duration or 0)
        out = []
        for seg in segments:  # decoding happens lazily here, so GPU library errors surface in this loop
            words = [
                {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip(), "prob": round(w.probability, 3)}
                for w in (seg.words or [])
            ]
            out.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(), "words": words})
            print(f"PROGRESS {seg.end:.2f} {total:.2f}", file=sys.stderr, flush=True)
        return out, info

    device = a.device
    compute = a.compute_type
    if device == "cpu" and compute == "default":
        compute = "int8"
    try:
        out, info = run(device, compute)
    except RuntimeError as e:
        msg = str(e)
        if device != "cpu" and ("cublas" in msg or "cudnn" in msg or "CUDA" in msg or "cuda" in msg):
            # NVIDIA GPU present but CUDA 12 / cuDNN 9 DLLs missing: fall back to CPU.
            print(f"STATUS GPU unavailable ({msg.splitlines()[0]}); falling back to CPU", file=sys.stderr, flush=True)
            device, compute = "cpu", "int8"
            out, info = run(device, compute)
        else:
            raise
    total = float(info.duration or 0)

    result = {
        "source": os.path.abspath(a.input),
        "language": info.language,
        "language_probability": round(info.language_probability or 0, 3),
        "duration": round(total, 3),
        "model": a.model,
        "device": device,
        "elapsed_seconds": round(time.time() - t0, 1),
        "segments": out,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.output)), exist_ok=True)
    tmp = a.output + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, a.output)
    print("DONE", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
