// Main-thread wrapper around wake.worker.ts (openWakeWord ONNX pipeline).
import { bus } from '../core/bus';
import { createProgressAggregator } from './progress';
import type { WakeIn, WakeOut } from '../workers/wake.worker';

let worker: Worker | null = null;
let isReady = false;
const detectHandlers: Array<(score: number) => void> = [];
const emitProgress = createProgressAggregator('wake');

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/wake.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WakeOut>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      isReady = msg.status === 'ready';
      emitProgress(msg);
    } else if (msg.type === 'detect') {
      bus.emit({ type: 'wake:detected', score: msg.score });
      detectHandlers.forEach((h) => h(msg.score));
    }
  };
  return worker;
}

// Resolves once loading finishes either way (ready or error) — never rejects. Callers check ready()
// and fall back to transcript-prefix wake detection (see pipeline.ts) when it stayed false.
function load(phrase: string): Promise<void> {
  const w = ensureWorker();
  isReady = false;
  return new Promise<void>((resolve) => {
    const off = bus.on('model:progress', (e) => {
      if (e.model !== 'wake') return;
      if (e.status === 'ready' || e.status === 'error') {
        off();
        resolve();
      }
    });
    w.postMessage({ type: 'load', phrase, baseHref: document.baseURI } satisfies WakeIn);
  });
}

function feed(frame16k: Float32Array): void {
  if (!isReady) return;
  ensureWorker().postMessage({ type: 'frame', frame: frame16k } satisfies WakeIn, [frame16k.buffer]);
}

function onDetect(cb: (score: number) => void): void {
  detectHandlers.push(cb);
}

function setThreshold(t: number): void {
  ensureWorker().postMessage({ type: 'threshold', value: t } satisfies WakeIn);
}

export const wake = {
  load,
  feed,
  onDetect,
  setThreshold,
  ready: (): boolean => isReady,
};
