// STT worker: transformers.js ASR pipeline, or src/audio/parakeet.ts for NeMo models (def.engine); model/device
// selectable (see src/audio/stt-models.ts).
// Job queue: finals always run before any queued partial, and a new partial replaces an older
// queued one - a partial must never delay a final, and only the latest partial is worth keeping.
// ponytail: a job already in flight can't be preempted (ONNX inference isn't abortable here), so a
// final can still wait behind an in-flight partial; acceptable since partials are short/infrequent.
import { pipeline, type ProgressInfo } from '@huggingface/transformers';
import type { SttIn, SttOut, SttModelId } from '../core/types';
import { STT_MODELS, DEFAULT_STT_MODEL, type SttModelDef } from '../audio/stt-models';

type Asr = (audio: Float32Array) => Promise<string>;
let asr: Asr | null = null;
let loading: Promise<void> | null = null;
let loadedModel: SttModelId | null = null;
let loadedDevice: 'wasm' | 'webgpu' | 'hybrid' | null = null;

type TranscribeJob = Extract<SttIn, { type: 'transcribe' }>;
const finalQueue: TranscribeJob[] = [];
let partialJob: TranscribeJob | null = null;
let draining = false;

function post(msg: SttOut): void {
  (self as unknown as { postMessage(m: SttOut): void }).postMessage(msg);
}

function onProgress(p: ProgressInfo): void {
  const info = p as unknown as { status: string; file?: string; loaded?: number; total?: number };
  if (info.status === 'progress') {
    post({ type: 'progress', file: info.file, loaded: info.loaded ?? 0, total: info.total ?? 0, status: 'downloading' });
  } else if (info.status === 'initiate' || info.status === 'download') {
    post({ type: 'progress', file: info.file, loaded: 0, total: info.total ?? 0, status: 'downloading' });
  } else if (info.status === 'done') {
    // Carry the real total (not a fake 1/1) so a multi-file aggregator sums bytes correctly.
    post({ type: 'progress', file: info.file, loaded: info.total ?? 0, total: info.total ?? 0, status: 'downloading' });
  }
}

// Engine-model files live in the Cache API, as transformers.js keeps its own (Settings' "Clear model cache"
// deletes every cache, this one included).
async function fetchModelFile(url: string, file: string): Promise<Uint8Array> {
  const cache = await caches.open('va-stt-models').catch(() => null);
  const hit = await cache?.match(url);
  const res = hit ?? (await fetch(url));
  if (!res.ok) throw new Error(`Couldn't download the speech model file ${file} (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (performance.now() - last > 100) {
      last = performance.now();
      post({ type: 'progress', file, loaded, total: total || loaded, status: 'downloading' });
    }
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  post({ type: 'progress', file, loaded, total: loaded, status: 'downloading' });
  if (!hit) await cache?.put(url, new Response(bytes)).catch(() => {}); // over quota: re-download next time
  return bytes;
}

async function loadParakeet(def: SttModelDef, device: 'wasm' | 'webgpu'): Promise<Asr> {
  const { ort, loadTdt } = await import('../audio/parakeet');
  // The build bundles the /webgpu entry's asyncify wasm into assets/ via import.meta.url; dev prebundling
  // breaks that lookup, so dev points ORT at node_modules directly.
  if (import.meta.env.DEV) ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  ort.env.wasm.numThreads = 1; // no COOP/COEP on GitHub Pages
  ort.env.wasm.proxy = false;
  const url = (f: string) => `https://huggingface.co/${def.repo}/resolve/${def.revision ?? 'main'}/${f}`;
  const f = def.files!;
  const encoder = await fetchModelFile(url(f.encoder), f.encoder);
  const decoder = await fetchModelFile(url(f.decoder), f.decoder);
  const preprocessor = await fetchModelFile(url(f.preprocessor), f.preprocessor);
  const vocab = new TextDecoder().decode(await fetchModelFile(url(f.vocab), f.vocab));
  return loadTdt({ encoder, decoder, preprocessor, vocab }, device);
}

async function loadPipeline(def: SttModelDef, device: 'wasm' | 'webgpu' | 'hybrid'): Promise<Asr> {
  // Hybrid: per-component device/dtype maps (see stt-models.ts header comment) - encoder on
  // webgpu, decoder on wasm - instead of a single device string for the whole pipeline.
  const pipe = await pipeline('automatic-speech-recognition', def.repo, {
    device: device === 'hybrid' ? def.hybridDevice! : device,
    dtype: device === 'hybrid' ? def.dtype!.hybrid! : def.dtype![device],
    progress_callback: onProgress,
  });
  const opts = def.englishOnly ? {} : { language: 'en', task: 'transcribe' };
  return async (audio) => {
    const out = await pipe(audio, { ...opts, return_timestamps: false });
    return Array.isArray(out) ? String(out[0]?.text ?? '') : String((out as { text: string }).text ?? '');
  };
}

function loadOn(def: SttModelDef, device: 'wasm' | 'webgpu' | 'hybrid'): Promise<Asr> {
  if (def.engine !== 'parakeet') {
    if (device === 'hybrid' && !def.hybridDevice) throw new Error(`${def.label} does not support hybrid execution`);
    return loadPipeline(def, device);
  }
  // Parakeet's decoder always runs on WASM, so its "hybrid" is its WebGPU mode.
  return loadParakeet(def, device === 'wasm' ? 'wasm' : 'webgpu');
}

async function load(explicitDevice?: 'wasm' | 'webgpu' | 'hybrid', explicitModel?: SttModelId): Promise<void> {
  // A bare load() means "make sure something is loaded" and must never swap the model that an
  // explicit load/reloadWith picked (that silently reloaded whisper-base on every transcribe).
  if (asr && !explicitDevice && !explicitModel) return;
  const modelId: SttModelId = explicitModel ?? loadedModel ?? DEFAULT_STT_MODEL;
  if (asr && loadedModel === modelId && (!explicitDevice || explicitDevice === loadedDevice)) return;
  if (loading) return loading;
  const def = STT_MODELS[modelId];
  loading = (async () => {
    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const device = explicitDevice ?? (hasWebGPU ? 'webgpu' : 'wasm');
    try {
      if (device === 'webgpu' && !hasWebGPU) throw new Error('WebGPU not available');
      if (device === 'hybrid' && !hasWebGPU) throw new Error('WebGPU not available');
      asr = await loadOn(def, device);
      loadedDevice = device;
    } catch (e) {
      if (explicitDevice) throw e; // caller asked for a specific device: don't silently swap it
      asr = await loadOn(def, 'wasm');
      loadedDevice = 'wasm';
    }
    loadedModel = modelId;
    // Warm-up: the first WebGPU run compiles shaders (seconds); do it on silence, not on the user.
    try {
      post({ type: 'progress', loaded: 1, total: 1, status: 'loading' });
      await asr(new Float32Array(16000));
    } catch {
      /* warm-up failures are harmless */
    }
    post({ type: 'progress', loaded: 1, total: 1, status: 'ready' });
  })();
  try {
    await loading;
  } catch (e) {
    post({ type: 'progress', loaded: 0, total: 0, status: 'error', error: (e as Error).message });
    throw e;
  } finally {
    loading = null;
  }
}

async function runJob(job: TranscribeJob): Promise<void> {
  try {
    await load();
    const text = await asr!(job.audio);
    post({ type: 'result', id: job.id, text: text.trim(), partial: job.partial });
  } catch (e) {
    post({ type: 'error', id: job.id, error: (e as Error).message, partial: job.partial });
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      let job: TranscribeJob | undefined;
      if (finalQueue.length > 0) job = finalQueue.shift();
      else if (partialJob) {
        job = partialJob;
        partialJob = null;
      }
      if (!job) break;
      await runJob(job);
    }
  } finally {
    draining = false;
  }
}

self.onmessage = async (ev: MessageEvent<SttIn>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    try {
      await load(msg.device, msg.model);
    } catch {
      /* error already posted by load() */
    }
    return;
  }
  if (msg.type === 'transcribe') {
    if (msg.partial) partialJob = msg; // replaces any older queued partial
    else finalQueue.push(msg);
    void drain();
  }
};
