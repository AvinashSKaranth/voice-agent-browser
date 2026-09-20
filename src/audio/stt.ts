// Main-thread wrapper around stt.worker.ts. Model is selectable (src/audio/stt-models.ts),
// default whisper-base.
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import { metrics } from '../core/metrics';
import { createProgressAggregator } from './progress';
import { autoDevice } from './stt-models';
import type { SttIn, SttOut, SttModelId } from '../core/types';

let worker: Worker | null = null;
let isReady = false;
let loadedModel: SttModelId | null = null;
let loadedDevice: 'wasm' | 'webgpu' | 'hybrid' | undefined;
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

/** Resolves the user's Settings choice ('auto' => let the worker pick webgpu when available) into
 * a concrete device for a default (no explicit device passed) load - mirrors tts.ts's resolveDevice. */
function resolveDevice(modelId: SttModelId): 'wasm' | 'webgpu' | 'hybrid' {
  const configured = getSettings().local.sttDevice;
  return configured === 'auto' ? autoDevice(modelId, typeof navigator !== 'undefined' && 'gpu' in navigator) : configured;
}

async function load(device?: 'wasm' | 'webgpu' | 'hybrid', modelId?: SttModelId): Promise<void> {
  // Bare load() = "ensure loaded"; it must not replace whatever reloadWith() selected (Bench, Settings).
  if (isReady && !device && !modelId) return;
  if (loadPromise && !device && !modelId) return loadPromise;
  const model = modelId ?? getSettings().local.sttModel;
  const resolvedDevice = device ?? resolveDevice(model);
  if (isReady && loadedModel === model && (!resolvedDevice || resolvedDevice === loadedDevice)) return;
  if (loadPromise) return loadPromise;
  const w = ensureWorker();
  const end = metrics.start('model.load.stt');
  loadPromise = new Promise<void>((resolve, reject) => {
    const off = bus.on('model:progress', (e) => {
      if (e.model !== 'stt') return;
      if (e.status === 'ready') {
        off();
        isReady = true;
        loadedModel = model;
        loadedDevice = resolvedDevice;
        loadPromise = null;
        end(`${model}/${resolvedDevice ?? 'auto'}`);
        resolve();
      } else if (e.status === 'error') {
        off();
        loadPromise = null;
        reject(new Error(e.error ?? 'STT load failed'));
      }
    });
    w.postMessage({ type: 'load', device: resolvedDevice, model } satisfies SttIn);
  });
  return loadPromise;
}

/** Terminates the worker and reloads fresh on `device` (and optionally a different model) -
 * used by Settings (model/device switch) and the Bench page. */
async function reloadWith(device?: 'wasm' | 'webgpu' | 'hybrid', modelId?: SttModelId): Promise<void> {
  worker?.terminate();
  worker = null;
  isReady = false;
  loadedModel = null;
  loadedDevice = undefined;
  loadPromise = null;
  await load(device, modelId);
}

async function transcribe(audio: Float32Array, opts?: { partial?: boolean }): Promise<string> {
  await load();
  const w = ensureWorker();
  const id = String(++seq);
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: 'transcribe', id, audio, partial: opts?.partial } satisfies SttIn, [audio.buffer]);
  });
}

export const stt = {
  load,
  transcribe,
  reloadWith,
  ready: (): boolean => isReady,
};
