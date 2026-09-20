// Main-thread wrapper around stt.worker.ts (whisper-base).
import { bus } from '../core/bus';
import { metrics } from '../core/metrics';
import { createProgressAggregator } from './progress';
import type { SttIn, SttOut } from '../core/types';

let worker: Worker | null = null;
let isReady = false;
let loadPromise: Promise<void> | null = null;
let seq = 0;
const pending = new Map<string, { resolve(text: string): void; reject(e: Error): void }>();
const emitProgress = createProgressAggregator('stt');

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/stt.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<SttOut>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      if (msg.status === 'ready') isReady = true;
      emitProgress(msg);
    } else if (msg.type === 'result') {
      pending.get(msg.id)?.resolve(msg.text);
      pending.delete(msg.id);
    } else if (msg.type === 'error') {
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!.reject(new Error(msg.error));
        pending.delete(msg.id);
      } else {
        bus.emit({ type: 'toast', level: 'error', text: `STT: ${msg.error}` });
      }
    }
  };
  return worker;
}

async function load(device?: 'wasm' | 'webgpu'): Promise<void> {
  if (isReady) return;
  if (loadPromise) return loadPromise;
  const w = ensureWorker();
  const end = metrics.start('model.load.stt');
  loadPromise = new Promise<void>((resolve, reject) => {
    const off = bus.on('model:progress', (e) => {
      if (e.model !== 'stt') return;
      if (e.status === 'ready') {
        off();
        end(device);
        resolve();
      } else if (e.status === 'error') {
        off();
        loadPromise = null;
        reject(new Error(e.error ?? 'STT load failed'));
      }
    });
    w.postMessage({ type: 'load', device } satisfies SttIn);
  });
  return loadPromise;
}

/** Terminates the worker and reloads whisper fresh on `device` - used by the Bench page. */
async function reloadWith(device: 'wasm' | 'webgpu'): Promise<void> {
  worker?.terminate();
  worker = null;
  isReady = false;
  loadPromise = null;
  await load(device);
}

async function transcribe(audio: Float32Array): Promise<string> {
  await load();
  const w = ensureWorker();
  const id = String(++seq);
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: 'transcribe', id, audio } satisfies SttIn, [audio.buffer]);
  });
}

export const stt = {
  load,
  transcribe,
  reloadWith,
  ready: (): boolean => isReady,
};
