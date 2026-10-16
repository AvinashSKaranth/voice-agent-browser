"""Scores browser results with the same code as native, then fills report_template.html -> report.html."""
import base64
import json
import platform
import subprocess

import numpy as np

from common import DATA, RESULTS, load_audio, score_stream, wer

ROOT = RESULTS.parent


def score_browser(raw, truth):
    segs = {s["id"]: s for s in truth["segments"]}
    out = {}
    for key, r in raw.items():
        if "error" in r:
            out[key] = r
            continue
        offline = [{**o, "rtfx": o["audio_s"] / o["time_s"], "wer": wer(segs[o["segment"]]["text"], o["text"])} for o in r["offline"]]
        streaming = [score_stream(segs[s["segment"]], s["steps"], s["final"], s["final_start"], s["final_done"], s["last_word_end"])
                     for s in r["streaming"]]
        runtime = {"whisper-base": "transformers.js (app config)",
                   "phonon-2": "tiyuvta ONNX export (exact4x2, 662 MB), onnxruntime-web",
                   "phonon-2-c": "phonon-2-c engine (187 MB) compiled to WASM SIMD"}.get(r["model"], "onnxruntime-web, onnx-asr decoding port")
        out[key] = {**r, "offline": offline, "streaming": streaming, "runtime": runtime if r["model"] == "phonon-2-c" else f"{runtime}, {r['device']}"}
    return out


def machine():
    gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
    cpu = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"], capture_output=True, text=True).stdout.strip()
    return {"cpu": cpu, "gpu": gpu, "os": platform.platform()}


def main():
    audio_pcm, truth = load_audio()
    native = json.loads((RESULTS / "native.json").read_text())
    browser_raw = json.loads((RESULTS / "browser.json").read_text()) if (RESULTS / "browser.json").exists() else {}
    browser = score_browser(browser_raw, truth)
    for r in list(native.values()) + list(browser.values()):  # steps are kept for the replay, trimmed to what it needs
        for s in r.get("streaming", []):
            s["steps"] = [{"done": st["done"], "text": st["text"]} for st in s["steps"]]
    data = {"truth": truth, "native": native, "browser": browser, "machine": machine(),
            "peaks": [round(float(abs(b).max()) / float(abs(audio_pcm).max()), 3) for b in np.array_split(audio_pcm, 600)]}
    audio = base64.b64encode((DATA / "test.wav").read_bytes()).decode()
    html = (ROOT / "report_template.html").read_text(encoding="utf-8")
    html = html.replace("/*DATA*/null", json.dumps(data)).replace("AUDIO_DATA_URI", f"data:audio/wav;base64,{audio}")
    (ROOT / "report.html").write_text(html, encoding="utf-8")
    print(f"wrote {ROOT / 'report.html'} ({len(html) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
