// Main-thread wrapper around stt.worker.ts (whisper-base).
import { bus } from '../core/bus';
import type { SttIn, SttOut } from '../core/types';

let worker: Worker | null = null;
let isReady = false;
let loadPromise: Promise<void> | null = null;
let seq = 0;
const pending = new Map<string, { resolve(text: string): void; reject(e: Error): void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/stt.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<SttOut>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      if (msg.status === 'ready') isReady = true;
      bus.emit({ type: 'model:progress', model: 'stt', file: msg.file, loaded: msg.loaded, total: msg.total, status: msg.status, error: msg.error });
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

async function load(): Promise<void> {
  if (isReady) return;
  if (loadPromise) return loadPromise;
  const w = ensureWorker();
  loadPromise = new Promise<void>((resolve, reject) => {
    const off = bus.on('model:progress', (e) => {
      if (e.model !== 'stt') return;
      if (e.status === 'ready') {
        off();
        resolve();
      } else if (e.status === 'error') {
        off();
        loadPromise = null;
        reject(new Error(e.error ?? 'STT load failed'));
      }
    });
    w.postMessage({ type: 'load' } satisfies SttIn);
  });
  return loadPromise;
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
  ready: (): boolean => isReady,
};
