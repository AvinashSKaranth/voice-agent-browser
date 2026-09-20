// Voice pipeline state machine: wake -> listening -> thinking -> speaking (BRD VP-1..VP-11).
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import { mic } from './mic';
import { player } from './player';
import { stt } from './stt';
import { tts } from './tts';
import { wake } from './wake';

type State = 'idle' | 'wake' | 'listening' | 'thinking' | 'speaking';

let state: State = 'idle';
let started = false;
let thinking = false;
let wakeModeActive = false; // wake.enabled && !pushToTalk, fixed for the session at start()
let wakeUsable = false; // true once the ML wake model loaded; false => transcript-prefix fallback
let followupTimer: ReturnType<typeof setTimeout> | null = null;
let pushToTalkActive = false;
let ptFrames: Float32Array[] = [];

const MIN_PTT_SAMPLES = 16000 * 0.4;
// Whisper hallucinates a handful of stock phrases (and "You") on near-silent/empty audio; a VAD or
// frame-tap failure that lets an empty buffer through must not surface these as real utterances.
const HALLUCINATION_PHRASES = new Set(['you', 'thank you', 'thanks for watching', 'bye', '', 'blank audio', 'subtitles by the amara org community']);
const HALLUCINATION_RMS = 0.005;

function rms(audio: Float32Array): number {
  if (audio.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / audio.length);
}

function looksLikeHallucination(text: string, audio: Float32Array): boolean {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  return HALLUCINATION_PHRASES.has(normalized) || rms(audio) < HALLUCINATION_RMS;
}

const utteranceHandlers: Array<(text: string) => void> = [];
const bargeInHandlers: Array<() => void> = [];

function setState(next: State): void {
  state = next;
  bus.emit({ type: 'audio:state', state: next });
}

function clearFollowup(): void {
  if (followupTimer) {
    clearTimeout(followupTimer);
    followupTimer = null;
  }
}

function armFollowup(): void {
  clearFollowup();
  followupTimer = setTimeout(() => {
    if (state === 'listening' && !thinking && !tts.speaking()) setState('wake');
  }, 8000);
}

function beep(): void {
  const sampleRate = 24000;
  const n = Math.floor(sampleRate * 0.1);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) audio[i] = Math.sin((2 * Math.PI * 880 * i) / sampleRate) * 0.2;
  void player.enqueue(audio, sampleRate);
}

function wakePhraseWords(): string {
  return getSettings()
    .wake.phrase.replace(/\.onnx$/i, '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

async function transcribeAndEmit(audio: Float32Array): Promise<void> {
  try {
    // stt.transcribe() transfers its argument's buffer to the worker (detaching it here), so hand
    // it a copy and keep `audio` intact for the hallucination RMS check below.
    const text = await stt.transcribe(audio.slice());
    if (looksLikeHallucination(text, audio)) return; // drop silently, e.g. empty/near-silent audio
    bus.emit({ type: 'stt:final', text });
    if (text.trim()) utteranceHandlers.forEach((h) => h(text));
  } catch (e) {
    bus.emit({ type: 'toast', level: 'error', text: `STT failed: ${(e as Error).message}` });
  }
}

function onSpeechStart(): void {
  if (tts.speaking()) {
    tts.stop();
    bargeInHandlers.forEach((h) => h());
  }
}

async function onWakeAttempt(audio: Float32Array): Promise<void> {
  // No usable ML wake model: fall back to requiring the phrase as a spoken prefix (VP-9 fallback).
  let text: string;
  try {
    text = await stt.transcribe(audio.slice());
  } catch (e) {
    bus.emit({ type: 'toast', level: 'error', text: `STT failed: ${(e as Error).message}` });
    return;
  }
  if (looksLikeHallucination(text, audio)) return; // drop silently, keep waiting for the wake phrase
  const phrase = wakePhraseWords();
  const normalized = text.trim().toLowerCase();
  if (!phrase || !normalized.startsWith(phrase)) return; // not the wake phrase; keep waiting
  bus.emit({ type: 'wake:detected', score: 1 });
  beep();
  setState('listening');
  armFollowup();
  const rest = text.trim().slice(phrase.length).trim();
  if (rest) {
    bus.emit({ type: 'stt:final', text: rest });
    utteranceHandlers.forEach((h) => h(rest));
  }
}

function onSpeechEnd(audio: Float32Array): void {
  if (pushToTalkActive) return; // push-to-talk owns its own recording
  if (state === 'wake') {
    if (!wakeUsable) void onWakeAttempt(audio);
    return; // ML path: VAD is ignored, wake.worker decides via wake.feed frames instead
  }
  if (state !== 'listening') return;
  clearFollowup();
  void transcribeAndEmit(audio);
}

function onFrame(frame: Float32Array): void {
  if (pushToTalkActive) {
    ptFrames.push(frame);
    return;
  }
  if (state === 'wake' && wakeUsable) wake.feed(frame);
}

function onWakeDetect(): void {
  if (state !== 'wake') return;
  beep();
  setState('listening');
  armFollowup();
}

// tts.ts only emits tts:start/tts:end; this pipeline owns every audio:state transition.
function onTtsStart(): void {
  clearFollowup();
  setState('speaking');
}

function onTtsEnd(): void {
  if (state !== 'speaking') return;
  if (thinking) {
    setState('thinking');
  } else {
    setState('listening');
    if (wakeModeActive) armFollowup();
  }
}

bus.on('tts:start', onTtsStart);
bus.on('tts:end', onTtsEnd);

// Shared by start() and pushToTalkStart() so both go through the same handlers. On failure (e.g.
// permission denied) this toasts and resets pipeline state itself, then rethrows: start()'s callers
// already surface their own toast on rejection, and pushToTalkStart() is called fire-and-forget by
// the UI so it must catch this itself rather than leave an unhandled rejection.
async function ensureMicStarted(): Promise<void> {
  if (mic.active()) return;
  try {
    await mic.start({ onSpeechStart, onSpeechEnd, onFrame });
  } catch (e) {
    started = false;
    setState('idle');
    bus.emit({ type: 'toast', level: 'error', text: `Could not start microphone: ${(e as Error).message}` });
    throw e;
  }
}

export const pipeline = {
  async start(): Promise<void> {
    if (started) return;
    started = true;
    player.init();
    const settings = getSettings();
    wakeModeActive = settings.wake.enabled && !settings.wake.pushToTalk;
    wake.onDetect(onWakeDetect);

    await ensureMicStarted();

    if (wakeModeActive) {
      wake.setThreshold(settings.wake.threshold);
      await wake.load(settings.wake.phrase);
      wakeUsable = wake.ready();
      setState('wake');
    } else {
      setState('listening');
    }
  },

  stop(): void {
    started = false;
    pushToTalkActive = false;
    ptFrames = [];
    clearFollowup();
    mic.stop();
    tts.stop();
    setState('idle');
  },

  async pushToTalkStart(): Promise<void> {
    player.init();
    try {
      await ensureMicStarted();
    } catch {
      return; // ensureMicStarted already toasted and reset state
    }
    pushToTalkActive = true;
    ptFrames = [];
    clearFollowup();
    onSpeechStart();
    setState('listening');
  },

  pushToTalkStop(): void {
    if (!pushToTalkActive) return;
    pushToTalkActive = false;
    const frames = ptFrames;
    ptFrames = [];
    const total = frames.reduce((n, f) => n + f.length, 0);
    if (total < MIN_PTT_SAMPLES) {
      bus.emit({ type: 'toast', level: 'warn', text: 'Too short, hold the button while you speak' });
      return;
    }
    const audio = new Float32Array(total);
    let offset = 0;
    for (const f of frames) {
      audio.set(f, offset);
      offset += f.length;
    }
    void transcribeAndEmit(audio);
  },

  onUtterance(cb: (text: string) => void): void {
    utteranceHandlers.push(cb);
  },

  onBargeIn(cb: () => void): void {
    bargeInHandlers.push(cb);
  },

  setThinking(on: boolean): void {
    thinking = on;
    if (on) {
      clearFollowup();
      setState('thinking');
    } else if (state === 'thinking') {
      setState('listening');
      if (wakeModeActive) armFollowup();
    }
  },
};
