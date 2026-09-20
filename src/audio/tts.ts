// Main-thread wrapper around tts.worker.ts (Kokoro) + player.ts (Web Audio playback queue).
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import { player } from './player';
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

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/tts.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<TtsOut>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      if (msg.status === 'ready') isReady = true;
      bus.emit({ type: 'model:progress', model: 'tts', file: msg.file, loaded: msg.loaded, total: msg.total, status: msg.status, error: msg.error });
    } else if (msg.type === 'chunk') {
      if (msg.id !== currentId) return;
      activeChunks.push(player.enqueue(msg.audio, msg.sampleRate));
    } else if (msg.type === 'done') {
      if (msg.id !== currentId) return;
      void Promise.all(activeChunks).then(() => activeResolve?.());
    } else if (msg.type === 'voices') {
      voicesResolve?.(msg.voices);
      voicesResolve = null;
    } else if (msg.type === 'error') {
      if (msg.id && msg.id === currentId) {
        activeResolve?.(); // don't hang the turn on a TTS failure; surface it as a toast instead
      }
      bus.emit({ type: 'toast', level: 'error', text: `TTS: ${msg.error}` });
    }
  };
  return worker;
}

async function load(): Promise<void> {
  const device = getSettings().local.ttsDevice;
  if (isReady && loadedDevice === device) return;
  if (loadPromise && loadedDevice === device) return loadPromise;
  loadedDevice = device;
  const w = ensureWorker();
  loadPromise = new Promise<void>((resolve, reject) => {
    const off = bus.on('model:progress', (e) => {
      if (e.model !== 'tts') return;
      if (e.status === 'ready') {
        off();
        resolve();
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

async function runSay(text: string): Promise<void> {
  await load();
  const w = ensureWorker();
  const id = String(++seq);
  currentId = id;
  activeChunks = [];
  isSpeaking = true;
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
  ready: (): boolean => isReady,
  speaking: (): boolean => isSpeaking,
};
