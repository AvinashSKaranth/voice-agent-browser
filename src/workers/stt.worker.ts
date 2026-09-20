// STT worker: transformers.js ASR pipeline, model/device selectable (see src/audio/stt-models.ts).
// Job queue: finals always run before any queued partial, and a new partial replaces an older
// queued one - a partial must never delay a final, and only the latest partial is worth keeping.
// ponytail: a job already in flight can't be preempted (ONNX inference isn't abortable here), so a
// final can still wait behind an in-flight partial; acceptable since partials are short/infrequent.
import { pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from '@huggingface/transformers';
import type { SttIn, SttOut, SttModelId } from '../core/types';
import { STT_MODELS, DEFAULT_STT_MODEL } from '../audio/stt-models';

let pipe: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;
let loadedModel: SttModelId | null = null;
let loadedDevice: 'wasm' | 'webgpu' | 'hybrid' | null = null;
let englishOnly = false;

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

async function load(explicitDevice?: 'wasm' | 'webgpu' | 'hybrid', explicitModel?: SttModelId): Promise<void> {
  // A bare load() means "make sure something is loaded" and must never swap the model that an
  // explicit load/reloadWith picked (that silently reloaded whisper-base on every transcribe).
  if (pipe && !explicitDevice && !explicitModel) return;
  const modelId: SttModelId = explicitModel ?? loadedModel ?? DEFAULT_STT_MODEL;
  if (pipe && loadedModel === modelId && (!explicitDevice || explicitDevice === loadedDevice)) return;
  if (loading) return loading;
  const def = STT_MODELS[modelId];
  loading = (async () => {
    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const device = explicitDevice ?? (hasWebGPU ? 'webgpu' : 'wasm');
    try {
      if (device === 'webgpu' && !hasWebGPU) throw new Error('WebGPU not available');
      if (device === 'hybrid' && !hasWebGPU) throw new Error('WebGPU not available');
      if (device === 'hybrid' && !def.hybridDevice) throw new Error(`${def.label} does not support hybrid execution`);
      // Hybrid: per-component device/dtype maps (see stt-models.ts header comment) - encoder on
      // webgpu, decoder on wasm - instead of a single device string for the whole pipeline.
      pipe = await pipeline('automatic-speech-recognition', def.repo, {
        device: device === 'hybrid' ? def.hybridDevice! : device,
        dtype: device === 'hybrid' ? def.dtype.hybrid! : def.dtype[device],
        progress_callback: onProgress,
      });
      loadedDevice = device;
    } catch (e) {
      if (explicitDevice) throw e; // caller asked for a specific device: don't silently swap it
      pipe = await pipeline('automatic-speech-recognition', def.repo, {
        device: 'wasm',
        dtype: def.dtype.wasm,
        progress_callback: onProgress,
      });
      loadedDevice = 'wasm';
    }
    loadedModel = modelId;
    englishOnly = def.englishOnly;
    // Warm-up: the first WebGPU run compiles shaders (seconds); do it on silence, not on the user.
    try {
      post({ type: 'progress', loaded: 1, total: 1, status: 'loading' });
      await pipe!(new Float32Array(16000), englishOnly ? {} : { language: 'en', task: 'transcribe' });
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
    const opts = englishOnly ? {} : { language: 'en', task: 'transcribe' };
    const out = await pipe!(job.audio, { ...opts, return_timestamps: false });
    const text = Array.isArray(out) ? String(out[0]?.text ?? '') : String((out as { text: string }).text ?? '');
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
