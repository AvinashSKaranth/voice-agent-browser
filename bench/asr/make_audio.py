"""Builds data/test.wav (16 kHz mono) + data/truth.json with per-word timings.

Four utterances: two clear voices, then two degraded ("unclear") ones. Kokoro gives word
timestamps, degradations are applied per segment afterwards so timings stay valid
(reverb tails just spill into the following silence).
"""
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

SR_TTS, SR = 24000, 16000
GAP_S = 1.2
OUT = Path(__file__).parent / "data"
rng = np.random.default_rng(7)

SEGMENTS = [
    dict(id="clear-1", label="Clear, female voice", voice="af_heart", speed=1.0, fx=None,
         text="Hey Jarvis, set a timer for ten minutes and remind me to call the dentist tomorrow morning."),
    dict(id="clear-2", label="Clear, male voice", voice="am_michael", speed=1.0, fx=None,
         text="What is the weather going to be like in San Francisco this weekend? I want to plan a long hike."),
    dict(id="unclear-fast-babble", label="Unclear: fast speech + background chatter (3 dB SNR)", voice="bf_emma", speed=1.35, fx="babble",
         text="Could you email Siobhan the quarterly numbers, roughly four point seven million, before the Kubernetes sync on Thursday?"),
    dict(id="unclear-muffled", label="Unclear: quiet, muffled, echoey room + hiss", voice="am_adam", speed=1.1, fx="muffled",
         text="Turn off the living room lights, lock the front door and play some quiet jazz in the bedroom."),
]
BABBLE_TEXT = [
    ("af_sky", "So I told him the meeting was moved to next week and he just laughed about it."),
    ("am_eric", "The train was late again this morning, I think they are fixing the tracks near the station."),
    ("bf_isabella", "Did you see the match last night? It went to penalties and nobody could believe it."),
]

pipe_a, pipe_b = KPipeline(lang_code="a"), KPipeline(lang_code="b")


def tts(text: str, voice: str, speed: float):
    """Returns (audio@24k, [(word, start_s, end_s)])."""
    pipe = pipe_b if voice.startswith("b") else pipe_a
    audio, words, offset = [], [], 0.0
    for r in pipe(text, voice=voice, speed=speed):
        a = r.audio.numpy()
        for t in r.tokens or []:
            if t.start_ts is not None and t.text.strip() and any(c.isalnum() for c in t.text):
                words.append((t.text, offset + t.start_ts, offset + t.end_ts))
        audio.append(a)
        offset += len(a) / SR_TTS
    return np.concatenate(audio), words


def rms(x):
    return float(np.sqrt(np.mean(x ** 2)) + 1e-9)


def mix_at_snr(sig, noise, snr_db):
    noise = np.resize(noise, len(sig))
    return sig + noise * (rms(sig) / rms(noise)) / (10 ** (snr_db / 20))


def pink(n):
    spec = np.fft.rfft(rng.standard_normal(n))
    spec /= np.sqrt(np.arange(1, len(spec) + 1))
    return np.fft.irfft(spec, n)


def reverb(x, rt60=0.8):
    n = int(rt60 * SR)
    ir = rng.standard_normal(n) * np.exp(-6.9 * np.arange(n) / n)  # -60 dB at rt60
    ir[0] = 1.0
    y = fftconvolve(x, ir)[: len(x) + n // 2]
    return y * (rms(x) / rms(y))


def apply_fx(x, fx):
    if fx == "babble":
        babble = sum(np.resize(to16k(tts(t, v, 1.0)[0]), len(x)) for v, t in BABBLE_TEXT)
        return mix_at_snr(x, babble, 3.0)
    if fx == "muffled":
        y = sosfilt(butter(4, 1200, "low", fs=SR, output="sos"), reverb(x, 0.8))
        y = y * (rms(x) / rms(y)) * 10 ** (-20 / 20)  # ~20 dB quieter
        return mix_at_snr(y, pink(len(y)), 12.0)
    return x


def to16k(a):
    return resample_poly(a, 2, 3).astype(np.float32)


def main():
    OUT.mkdir(exist_ok=True)
    out, truth, t = [np.zeros(int(0.5 * SR), np.float32)], [], 0.5
    for seg in SEGMENTS:
        a24, words = tts(seg["text"], seg["voice"], seg["speed"])
        a = apply_fx(to16k(a24), seg["fx"]).astype(np.float32)
        truth.append({**{k: seg[k] for k in ("id", "label", "voice", "speed", "fx", "text")},
                      "start": round(t, 3), "end": round(t + len(a) / SR, 3),
                      "words": [{"w": w, "start": round(t + s, 3), "end": round(t + e, 3)} for w, s, e in words]})
        out += [a, np.zeros(int(GAP_S * SR), np.float32)]
        t += len(a) / SR + GAP_S
    audio = np.concatenate(out)
    audio *= 0.9 / max(1e-6, float(np.abs(audio).max()))
    sf.write(OUT / "test.wav", audio, SR, subtype="PCM_16")
    (OUT / "truth.json").write_text(json.dumps({"sample_rate": SR, "duration": round(len(audio) / SR, 3), "segments": truth}, indent=1))
    for s in truth:
        assert s["words"], f"no word timings for {s['id']}"
        print(f"{s['id']:22s} {s['start']:6.2f}-{s['end']:6.2f}s  {len(s['words'])} words")
    print(f"wrote {OUT / 'test.wav'} ({len(audio) / SR:.1f}s)")


if __name__ == "__main__":
    main()
