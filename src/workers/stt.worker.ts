// STT worker: whisper-base via transformers.js. WebGPU q4 decoder, WASM q8 fallback.
import { pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from '@huggingface/transformers';
import type { SttIn, SttOut } from '../core/types';

let pipe: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;

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

async function load(): Promise<void> {
  if (pipe) return;
  if (loading) return loading;
  loading = (async () => {
    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
    try {
      if (!hasWebGPU) throw new Error('WebGPU not available');
      pipe = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback: onProgress,
      });
    } catch {
      pipe = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
        device: 'wasm',
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        progress_callback: onProgress,
      });
    }
    post({ type: 'progress', loaded: 1, total: 1, status: 'ready' });
  })();
  try {
    await loading;
  } catch (e) {
    loading = null;
    post({ type: 'progress', loaded: 0, total: 0, status: 'error', error: (e as Error).message });
    throw e;
  }
}

self.onmessage = async (ev: MessageEvent<SttIn>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    try {
      await load();
    } catch {
      /* error already posted by load() */
    }
    return;
  }
  if (msg.type === 'transcribe') {
    try {
      await load();
      const out = await pipe!(msg.audio, { language: 'en', task: 'transcribe', return_timestamps: false });
      const text = Array.isArray(out) ? String(out[0]?.text ?? '') : String((out as { text: string }).text ?? '');
      post({ type: 'result', id: msg.id, text: text.trim() });
    } catch (e) {
      post({ type: 'error', id: msg.id, error: (e as Error).message });
    }
  }
};
