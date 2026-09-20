// TTS worker: Kokoro-82M via kokoro-js (own nested transformers.js copy).
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import type { GenerateOptions as KokoroVoiceOptions } from 'kokoro-js';
import type { TtsIn, TtsOut } from '../core/types';

let tts: KokoroTTS | null = null;
let loadedDevice: 'wasm' | 'webgpu' | null = null;
let loading: Promise<void> | null = null;
const aborted = new Set<string>();

function post(msg: TtsOut, transfer?: Transferable[]): void {
  (self as unknown as { postMessage(m: TtsOut, t?: Transferable[]): void }).postMessage(msg, transfer);
}

function onProgress(p: unknown): void {
  const info = p as { status: string; file?: string; loaded?: number; total?: number };
  if (info.status === 'progress') {
    post({ type: 'progress', file: info.file, loaded: info.loaded ?? 0, total: info.total ?? 0, status: 'downloading' });
  } else if (info.status === 'initiate' || info.status === 'download') {
    post({ type: 'progress', file: info.file, loaded: 0, total: info.total ?? 0, status: 'downloading' });
  } else if (info.status === 'done') {
    // Carry the real total (not a fake 1/1) so a multi-file aggregator sums bytes correctly.
    post({ type: 'progress', file: info.file, loaded: info.total ?? 0, total: info.total ?? 0, status: 'downloading' });
  }
}

async function load(device: 'wasm' | 'webgpu'): Promise<void> {
  if (tts && loadedDevice === device) return;
  if (loading && loadedDevice === device) return loading;
  loadedDevice = device;
  loading = (async () => {
    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      device,
      progress_callback: onProgress,
    });
    post({ type: 'progress', loaded: 1, total: 1, status: 'ready' });
  })();
  try {
    await loading;
  } catch (e) {
    tts = null;
    loadedDevice = null;
    loading = null;
    post({ type: 'progress', loaded: 0, total: 0, status: 'error', error: (e as Error).message });
    throw e;
  }
}

self.onmessage = async (ev: MessageEvent<TtsIn>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    try {
      await load(msg.device);
    } catch {
      /* error already posted */
    }
    return;
  }
  if (msg.type === 'voices') {
    try {
      await load(loadedDevice ?? 'wasm');
      post({ type: 'voices', voices: Object.keys(tts!.voices) });
    } catch (e) {
      post({ type: 'error', error: (e as Error).message });
    }
    return;
  }
  if (msg.type === 'abort') {
    aborted.add(msg.id);
    return;
  }
  if (msg.type === 'speak') {
    try {
      await load(loadedDevice ?? 'wasm');
      const splitter = new TextSplitterStream();
      const stream = tts!.stream(splitter, { voice: msg.voice as KokoroVoiceOptions['voice'], speed: msg.speed });
      splitter.push(msg.text);
      splitter.close();
      for await (const { audio } of stream) {
        if (aborted.has(msg.id)) {
          aborted.delete(msg.id);
          return;
        }
        const buf = audio.audio;
        post({ type: 'chunk', id: msg.id, audio: buf, sampleRate: audio.sampling_rate }, [buf.buffer]);
      }
      if (aborted.has(msg.id)) {
        aborted.delete(msg.id);
        return;
      }
      post({ type: 'done', id: msg.id });
    } catch (e) {
      post({ type: 'error', id: msg.id, error: (e as Error).message });
    }
  }
};
