// Main-thread wrapper around tts.worker.ts (Kokoro) + player.ts (Web Audio playback queue).
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import { metrics } from '../core/metrics';
import { player } from './player';
import { ackCache } from './ackcache';
import { createProgressAggregator } from './progress';
import type { TtsIn, TtsOut } from '../core/types';

let worker: Worker | null = null;
let isReady = false;
let loadPromise: Promise<void> | null = null;
let loadedDevice: 'wasm' | 'webgpu' | null = null;
let seq = 0;
let isSpeaking = false;
let currentId: string | null = null;
let activeResolve: (() => void) | null = null;
let activeChunks: Promise<void>[] = [];
let voicesResolve: ((v: string[]) => void) | null = null;
let sayChain: Promise<void> = Promise.resolve();
let sayT0 = 0;
let sayTextLen = 0;
let gotFirstChunk = false;
const emitProgress = createProgressAggregator('tts');

// Synth-only requests (ackcache.ts warming, Bench.tsx): collected into one buffer, never played.
interface SynthPending {
  chunks: Array<{ audio: Float32Array; sampleRate: number }>;
  resolve: (r: { audio: Float32Array; sampleRate: number }) => void;
  reject: (e: Error) => void;
  t0: number;
  onFirstChunk?: (ms: number) => void;
}
const synthPending = new Map<string, SynthPending>();

/** True once the user explicitly picked a device in Settings; otherwise auto-resolve to webgpu when available. */
function resolveDevice(): 'wasm' | 'webgpu' {
  const local = getSettings().local;
  if (local.ttsDeviceExplicit) return local.ttsDevice;
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/tts.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<TtsOut>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      if (msg.status === 'ready') isReady = true;
      emitProgress(msg);
    } else if (msg.type === 'chunk') {
      const sp = synthPending.get(msg.id);
      if (sp) {
        if (sp.chunks.length === 0) sp.onFirstChunk?.(performance.now() - sp.t0);
        sp.chunks.push({ audio: msg.audio, sampleRate: msg.sampleRate });
        return;
      }
      if (msg.id !== currentId) return;
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        metrics.event('tts.first_audio', performance.now() - sayT0);
      }
      activeChunks.push(player.enqueue(msg.audio, msg.sampleRate));
    } else if (msg.type === 'done') {
      const sp = synthPending.get(msg.id);
      if (sp) {
        synthPending.delete(msg.id);
        const total = sp.chunks.reduce((n, c) => n + c.audio.length, 0);
        const sampleRate = sp.chunks[0]?.sampleRate ?? 24000;
        const merged = new Float32Array(total);
        let off = 0;
        for (const c of sp.chunks) {
          merged.set(c.audio, off);
          off += c.audio.length;
        }
        sp.resolve({ audio: merged, sampleRate });
        return;
      }
      if (msg.id !== currentId) return;
      metrics.event('tts.synth', performance.now() - sayT0, String(sayTextLen));
      void Promise.all(activeChunks).then(() => activeResolve?.());
    } else if (msg.type === 'voices') {
      voicesResolve?.(msg.voices);
      voicesResolve = null;
    } else if (msg.type === 'error') {
      const sp = msg.id ? synthPending.get(msg.id) : undefined;
      if (sp) {
        synthPending.delete(msg.id!);
        sp.reject(new Error(msg.error));
        return;
      }
      if (msg.id && msg.id === currentId) {
        activeResolve?.(); // don't hang the turn on a TTS failure; surface it as a toast instead
      }
      bus.emit({ type: 'toast', level: 'error', text: `TTS: ${msg.error}` });
    }
  };
  return worker;
}

async function load(explicitDevice?: 'wasm' | 'webgpu'): Promise<void> {
  const device = explicitDevice ?? resolveDevice();
  if (isReady && loadedDevice === device) return;
  if (loadPromise && loadedDevice === device) return loadPromise;
  loadedDevice = device;
  const w = ensureWorker();
  const end = metrics.start('model.load.tts');
  loadPromise = new Promise<void>((resolve, reject) => {
    const off = bus.on('model:progress', (e) => {
      if (e.model !== 'tts') return;
      if (e.status === 'ready') {
        off();
        end(device);
        resolve();
        void ackCache.warm(); // background: pre-synthesise fixed phrases now that Kokoro is loaded
      } else if (e.status === 'error') {
        off();
        loadPromise = null;
        reject(new Error(e.error ?? 'TTS load failed'));
      }
    });
    w.postMessage({ type: 'load', device } satisfies TtsIn);
  });
  return loadPromise;
}

/** Terminates the worker and reloads Kokoro fresh on `device` - used by the Bench page to measure cold load time. */
async function reloadWith(device: 'wasm' | 'webgpu'): Promise<void> {
  worker?.terminate();
  worker = null;
  isReady = false;
  loadPromise = null;
  loadedDevice = null;
  await load(device);
}

/** Synthesises `text` and returns the raw PCM without playing it (ackcache.ts warming, Bench.tsx).
 * `onFirstChunk` (Bench.tsx only) reports ms from call to the first audio chunk arriving. */
async function synthToPCM(text: string, voice: string, speed: number, onFirstChunk?: (ms: number) => void): Promise<{ audio: Float32Array; sampleRate: number }> {
  await load();
  const w = ensureWorker();
  const id = `synth_${++seq}`;
  return new Promise((resolve, reject) => {
    synthPending.set(id, { chunks: [], resolve, reject, t0: performance.now(), onFirstChunk });
    w.postMessage({ type: 'speak', id, text, voice, speed } satisfies TtsIn);
  });
}

async function runSay(text: string): Promise<void> {
  await load();
  const w = ensureWorker();
  const id = String(++seq);
  currentId = id;
  activeChunks = [];
  isSpeaking = true;
  sayT0 = performance.now();
  sayTextLen = text.length;
  gotFirstChunk = false;
  const { id: voice, speed } = getSettings().voice;
  bus.emit({ type: 'tts:start', text }); // pipeline.ts owns audio:state transitions, not this module
  try {
    await new Promise<void>((resolve) => {
      activeResolve = resolve;
      w.postMessage({ type: 'speak', id, text, voice, speed } satisfies TtsIn);
    });
  } finally {
    if (currentId === id) {
      currentId = null;
      isSpeaking = false;
    }
    activeResolve = null;
    bus.emit({ type: 'tts:end' });
  }
}

async function say(text: string): Promise<void> {
  // Cached fixed phrases (acks/heartbeat/retry/giveup) play instantly and never touch the worker
  // queue, so they can't block a real answer sentence queued right behind them.
  const cached = ackCache.playAndWait(text);
  if (cached) return cached;
  const next = sayChain.then(() => runSay(text));
  sayChain = next.catch(() => {});
  return next;
}

function stop(): void {
  if (currentId) {
    const w = ensureWorker();
    w.postMessage({ type: 'abort', id: currentId } satisfies TtsIn);
  }
  player.stop();
  ackCache.stop();
  activeResolve?.();
  activeResolve = null;
  currentId = null;
  isSpeaking = false;
}

async function voices(): Promise<string[]> {
  await load();
  const w = ensureWorker();
  return new Promise<string[]>((resolve) => {
    voicesResolve = resolve;
    w.postMessage({ type: 'voices' } satisfies TtsIn);
  });
}

export const tts = {
  load,
  say,
  stop,
  voices,
  reloadWith,
  synthToPCM,
  ready: (): boolean => isReady,
  speaking: (): boolean => isSpeaking || player.playing(),
  // ackcache.ts's warm() polls this so its background synthesis backs off while a real say() is
  // in flight - both hit the same worker and there is no separate priority queue for them.
  isSynthesizing: (): boolean => currentId !== null,
};
