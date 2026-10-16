"""Shared scoring + the word-by-word real-time streaming simulation (used by run_native.py)."""
import difflib
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf

DATA = Path(__file__).parent / "data"
RESULTS = Path(__file__).parent / "results"
TAIL_S = 0.4  # audio kept after the last word so the final pass sees the whole utterance

_norm = None


def normalize(text: str) -> list[str]:
    """Open ASR Leaderboard-style normalizer (Whisper's EnglishTextNormalizer: numbers, spelling, fillers)."""
    global _norm
    if _norm is None:
        from transformers.models.whisper.english_normalizer import EnglishTextNormalizer
        from transformers import WhisperTokenizer
        _norm = EnglishTextNormalizer(WhisperTokenizer.from_pretrained("openai/whisper-base").english_spelling_normalizer)
    return _norm(text).split()


def wer(ref: str, hyp: str) -> float:
    import jiwer
    r, h = " ".join(normalize(ref)), " ".join(normalize(hyp))
    return jiwer.wer(r, h) if r else 0.0


def load_audio():
    audio, sr = sf.read(DATA / "test.wav", dtype="float32")
    assert sr == 16000
    truth = json.loads((DATA / "truth.json").read_text())
    return audio, truth


def seg_audio(audio, seg):
    s = int(seg["start"] * 16000)
    return audio[s: int((seg["end"] + TAIL_S) * 16000)]


def emitted_ref_words(ref_tokens: list[str], hyp_tokens: list[str]) -> set[int]:
    """Indices of reference words the hypothesis got right (in-order alignment)."""
    sm = difflib.SequenceMatcher(a=ref_tokens, b=hyp_tokens, autojunk=False)
    return {b.a + k for b in sm.get_matching_blocks() for k in range(b.size)}


def common_prefix(a: list[str], b: list[str]) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def stream_segment(transcribe, audio, seg):
    """Feed one utterance word by word in real time.

    Audio for word i becomes available at its end timestamp; we sleep until then (so the wait is the
    word's own duration), transcribe everything heard so far, and repeat. If a transcription takes
    longer than the words it covers, the next step jumps to the newest available word, exactly like
    a live mic buffer would - so a slow model shows up as skipped steps and growing lag.
    """
    x = seg_audio(audio, seg)
    words = seg["words"]
    t_end = [w["end"] - seg["start"] for w in words]
    steps, i, t0 = [], 0, time.perf_counter()
    while i < len(words):
        now = time.perf_counter() - t0
        if now < t_end[i]:
            time.sleep(t_end[i] - now)
        now = time.perf_counter() - t0
        while i + 1 < len(words) and t_end[i + 1] <= now:  # lagging: catch up to newest audio
            i += 1
        a = time.perf_counter() - t0
        text = transcribe(x[: int(t_end[i] * 16000)])
        b = time.perf_counter() - t0
        steps.append({"word": i, "audio_s": round(t_end[i], 3), "start": round(a, 3), "done": round(b, 3), "text": text})
        i += 1
    # end of speech: wait for the tail, then the final pass on the full utterance
    now = time.perf_counter() - t0
    speech_end = len(x) / 16000
    if now < speech_end:
        time.sleep(speech_end - now)
    a = time.perf_counter() - t0
    final = transcribe(x)
    b = time.perf_counter() - t0
    return score_stream(seg, steps, final, a, b, t_end[-1])


def score_stream(seg, steps, final, final_start, final_done, last_word_end):
    ref = normalize(seg["text"])
    ref_end = {}  # ref token idx -> end time; normalized tokens don't map 1:1 to TTS words, so spread
    for k in range(len(ref)):
        w = seg["words"][min(len(seg["words"]) - 1, round(k * len(seg["words"]) / max(1, len(ref))))]
        ref_end[k] = w["end"] - seg["start"]
    first_seen = {}
    prev, rewrites, shown = [], 0, 0
    for s in steps:
        hyp = normalize(s["text"])
        for k in emitted_ref_words(ref, hyp):
            first_seen.setdefault(k, s["done"])
        rewrites += len(prev) - common_prefix(prev, hyp)
        shown += max(0, len(hyp) - common_prefix(prev, hyp))
        prev = hyp
    for k in emitted_ref_words(ref, normalize(final)):
        first_seen.setdefault(k, final_done)
    lat = [first_seen[k] - ref_end[k] for k in first_seen]
    compute = [s["done"] - s["start"] for s in steps]
    first_nonempty = next((s["done"] for s in steps if s["text"].strip()), final_done)
    return {
        "segment": seg["id"],
        "steps": steps,
        "final": final,
        "wer": wer(seg["text"], final),
        "words": len(seg["words"]),
        "steps_run": len(steps),
        "words_skipped": len(seg["words"]) - len(steps),
        "step_ms_mean": round(1000 * float(np.mean(compute)), 1),
        "step_ms_p95": round(1000 * float(np.percentile(compute, 95)), 1),
        "first_text_s": round(first_nonempty - (seg["words"][0]["end"] - seg["start"]), 3),
        "word_latency_mean_s": round(float(np.mean(lat)), 3) if lat else None,
        "word_latency_p90_s": round(float(np.percentile(lat, 90)), 3) if lat else None,
        "rewrite_ratio": round(rewrites / max(1, shown), 3),
        "final_latency_s": round(final_done - final_start, 3),
        "end_to_final_s": round(final_done - last_word_end, 3),
    }


if __name__ == "__main__":
    # self-check for the alignment/scoring helpers
    assert emitted_ref_words("a b c d".split(), "a x c d".split()) == {0, 2, 3}
    assert common_prefix("a b c".split(), "a b d".split()) == 2
    print("ok")
