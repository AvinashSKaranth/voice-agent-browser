"""Native benchmark: each model on CPU and CUDA, offline speed + word-by-word streaming.

Usage: .venv/Scripts/python run_native.py [model[/device] ...]   (default: everything)
Results merge into results/native.json so one config can be re-run alone.
"""
import io
import json
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

from common import RESULTS, load_audio, seg_audio, stream_segment, wer


# ---------- adapters: load(device) -> (transcribe(pcm) -> str, info, close) ----------

def load_whisper(device):
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
    dtype = torch.float16 if device == "cuda" else torch.float32
    proc = WhisperProcessor.from_pretrained("openai/whisper-base")
    model = WhisperForConditionalGeneration.from_pretrained("openai/whisper-base", torch_dtype=dtype).to(device).eval()

    @torch.inference_mode()
    def transcribe(pcm):
        feats = proc(pcm, sampling_rate=16000, return_tensors="pt").input_features.to(device, dtype)
        ids = model.generate(feats, language="en", task="transcribe", max_new_tokens=128)
        return proc.batch_decode(ids, skip_special_tokens=True)[0].strip()

    return transcribe, f"transformers {__import__('transformers').__version__}, torch {torch.__version__}, {dtype}".replace("torch.", ""), None


def _onnx_asr(repo, device, note):
    import onnxruntime
    import onnx_asr
    if device == "cuda":
        import torch  # noqa: F401  torch's wheel carries the cuDNN 9 DLLs ORT's CUDA EP needs
        onnxruntime.preload_dlls()
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
    model = onnx_asr.load_model(repo, providers=providers)
    return (lambda pcm: model.recognize(pcm, sample_rate=16000).strip()), f"onnx-asr {onnx_asr.__version__} / ORT {onnxruntime.__version__}, {note}", None


def load_canary(device):
    return _onnx_asr("istupakov/canary-180m-flash-onnx", device, "fp32")


def load_parakeet_redux_onnx(device):
    # Photon's Windows wheel only has the scalar CPU kernel and refuses to run ternary weights on it,
    # so CPU uses the community ONNX export (same graph the browser bench loads).
    return _onnx_asr("eschmidbauer/parakeet-redux-onnx", device, "ternary as 4-bit MatMulNBits")


def load_parakeet_redux(device):
    if device == "cpu":
        raise RuntimeError("Photon on Windows ships only a scalar CPU kernel and refuses ternary weights on it")
    import moondream as md
    ctx = md.photon("moondream/parakeet-redux", device=device)
    speech = ctx.__enter__()
    transcribe = lambda pcm: speech.transcribe(audio=pcm, sample_rate=16000)["text"].strip()
    return transcribe, f"moondream {md.__version__} Photon (official runtime), ternary", lambda: ctx.__exit__(None, None, None)


def load_phonon2(device):
    """Phonon-2 only ships an engine behind its CLI/server: fermion serve (CPU, Windows) or the CUDA container."""
    port = 8011 if device == "cuda" else 8010
    key = uuid.uuid4().hex  # the container refuses a 0.0.0.0 bind without one
    if device == "cuda":
        name = f"phonon-bench-{uuid.uuid4().hex[:6]}"
        cmd = ["docker", "run", "--rm", "--name", name, "--gpus", "all", "-p", f"127.0.0.1:{port}:8000",
               "-v", "phonon-cache:/home/phonon/.cache", "ghcr.io/fermionresearch/phonon-cuda:1.0.8",
               "serve", "--model", "phonon-2", "--host", "0.0.0.0", "--port", "8000", "--api-key", key]
        stop = lambda: subprocess.run(["docker", "stop", name], capture_output=True)
        info = "phonon-cuda:1.0.8 container, HTTP"
    else:
        cmd = [str(Path(sys.executable).parent / "fermion.exe"), "serve", "phonon-2", "--port", str(port)]
        stop = None
        info = "fermion-research CPU engine, HTTP"
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(600):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
            break
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError(f"phonon server exited ({proc.returncode})")
            time.sleep(1)
    else:
        raise RuntimeError("phonon server did not come up")

    def transcribe(pcm):
        buf = io.BytesIO()
        sf.write(buf, pcm, 16000, format="WAV", subtype="PCM_16")
        boundary = uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n"
                "Content-Type: audio/wav\r\n\r\n").encode() + buf.getvalue() + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/audio/transcriptions", data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Authorization": f"Bearer {key}"})
        return json.load(urllib.request.urlopen(req))["text"].strip()

    def close():
        if stop:
            stop()
        proc.terminate()

    return transcribe, info, close


MODELS = {"whisper-base": load_whisper, "canary-180m-flash": load_canary, "parakeet-redux": load_parakeet_redux, "parakeet-redux-onnx": load_parakeet_redux_onnx, "phonon-2": load_phonon2}
DEVICES = ["cuda", "cpu"]


def run(model, device):
    audio, truth = load_audio()
    segs = truth["segments"]
    t = time.perf_counter()
    transcribe, info, close = MODELS[model](device)
    load_s = time.perf_counter() - t
    try:
        t = time.perf_counter()
        warm = transcribe(seg_audio(audio, segs[0]))
        warmup_s = time.perf_counter() - t
        print(f"  {model}/{device}: load {load_s:.1f}s warm-up {warmup_s:.2f}s -> {warm}")
        offline = []
        for seg in segs:
            x = seg_audio(audio, seg)
            times, text = [], ""
            for _ in range(3):
                t = time.perf_counter()
                text = transcribe(x)
                times.append(time.perf_counter() - t)
            dt = sorted(times)[1]
            offline.append({"segment": seg["id"], "audio_s": len(x) / 16000, "time_s": dt, "rtfx": len(x) / 16000 / dt,
                            "text": text, "wer": wer(seg["text"], text)})
            print(f"    offline {seg['id']:22s} {dt * 1000:7.1f} ms  RTFx {len(x) / 16000 / dt:6.1f}  WER {offline[-1]['wer']:.2f}  {text}")
        streaming = []
        for seg in segs:
            r = stream_segment(transcribe, audio, seg)
            streaming.append(r)
            print(f"    stream  {seg['id']:22s} steps {r['steps_run']}/{r['words']}  step {r['step_ms_mean']} ms  "
                  f"word lat {r['word_latency_mean_s']}s  rewrites {r['rewrite_ratio']}  final +{r['end_to_final_s']}s")
    finally:
        if close:
            close()
    return {"model": model, "device": device, "runtime": info, "load_s": load_s, "warmup_s": warmup_s,
            "offline": offline, "streaming": streaming}


def main():
    wanted = sys.argv[1:]
    out = RESULTS / "native.json"
    RESULTS.mkdir(exist_ok=True)
    results = json.loads(out.read_text()) if out.exists() else {}
    for model in MODELS:
        for device in DEVICES:
            key = f"{model}/{device}"
            if wanted and not any(key.startswith(w) for w in wanted):
                continue
            try:
                results[key] = run(model, device)
            except Exception as e:  # keep going; the report shows the failure
                print(f"  {key} FAILED: {e!r}")
                results[key] = {"model": model, "device": device, "error": repr(e)}
            out.write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
