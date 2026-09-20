// TTS worker: Kokoro-82M via kokoro-js (own nested transformers.js copy), or KittenTTS (StyleTTS2)
// via the kitten-tts-js npm package - see src/audio/tts-engines.ts for why that package instead of
// @huggingface/transformers's own text-to-speech pipeline.
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import type { GenerateOptions as KokoroVoiceOptions } from 'kokoro-js';
import type { TtsIn, TtsOut, TtsEngine } from '../core/types';
import { KITTEN_REPO, KITTEN_VOICES, isKittenEngine } from '../audio/tts-engines';

// Type-only: kitten-tts-js is loaded with a dynamic import() below (see loadKitten) so Kokoro-only
// sessions never pull in its phonemizer/jszip/onnxruntime-web bundle.
type KittenTTSInstance = Awaited<ReturnType<(typeof import('kitten-tts-js'))['KittenTTS']['from_pretrained']>>;

let kokoro: KokoroTTS | null = null;
let kitten: KittenTTSInstance | null = null;
let loadedEngine: TtsEngine | null = null;
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

async function loadKokoro(device: 'wasm' | 'webgpu'): Promise<void> {
  kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
    device,
    progress_callback: onProgress,
  });
}

async function loadKitten(engine: 'kitten-nano' | 'kitten-mini'): Promise<void> {
  // ponytail: kitten-tts-js's downloadModel() has no progress callback, so this is a plain
  // start/ready pair instead of real byte progress - upgrade path is forking fetchCached there
  // to stream through a reader if the download bar needs to move for this engine too.
  post({ type: 'progress', loaded: 0, total: 1, status: 'downloading' });
  const { KittenTTS } = await import('kitten-tts-js');
  // kitten-tts-js resolves onnxruntime-web's wasm binaries relative to its own bundled script URL,
  // which is wrong once Vite bundles it into our worker chunk, and its jsDelivr fallback is pinned
  // to onnxruntime-web@1.20 while this repo installs 1.30 - version-mismatched wasm/JS pairs throw
  // at session creation. Both entry points share the same cached module instance in this worker, so
  // setting wasmPaths here (before kitten-tts-js's own `import('onnxruntime-web')`) sticks.
  const ort = await import('onnxruntime-web');
  if (!ort.env.wasm.wasmPaths) ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
  kitten = await KittenTTS.from_pretrained(KITTEN_REPO[engine]);
}

async function load(device: 'wasm' | 'webgpu', engine: TtsEngine = 'kokoro'): Promise<void> {
  if ((kokoro || kitten) && loadedEngine === engine && loadedDevice === device) return;
  if (loading) return loading;
  loading = (async () => {
    kokoro = null;
    kitten = null;
    if (isKittenEngine(engine)) {
      await loadKitten(engine);
    } else {
      await loadKokoro(device);
    }
    loadedEngine = engine;
    loadedDevice = device;
    post({ type: 'progress', loaded: 1, total: 1, status: 'ready' });
  })();
  try {
    await loading;
  } catch (e) {
    kokoro = null;
    kitten = null;
    loadedEngine = null;
    loadedDevice = null;
    post({ type: 'progress', loaded: 0, total: 0, status: 'error', error: (e as Error).message });
    throw e;
  } finally {
    loading = null;
  }
}

async function speakKokoro(msg: Extract<TtsIn, { type: 'speak' }>): Promise<void> {
  const splitter = new TextSplitterStream();
  const stream = kokoro!.stream(splitter, { voice: msg.voice as KokoroVoiceOptions['voice'], speed: msg.speed });
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
}

async function speakKitten(msg: Extract<TtsIn, { type: 'speak' }>): Promise<void> {
  // settings.voice.id namespaces Kitten voices as 'kitten:Bella' so it never collides with a
  // Kokoro voice id; strip the prefix before handing it to kitten-tts-js.
  const voice = msg.voice.replace(/^kitten:/, '');
  // tts.stream() already synthesises sentence-by-sentence internally, which is exactly the
  // "post chunks as they're ready" behaviour Kokoro's stream() gives us above.
  for await (const { audio } of kitten!.stream(msg.text, { voice, speed: msg.speed })) {
    if (aborted.has(msg.id)) {
      aborted.delete(msg.id);
      return;
    }
    const buf = audio.data;
    post({ type: 'chunk', id: msg.id, audio: buf, sampleRate: audio.sampling_rate }, [buf.buffer]);
  }
  if (aborted.has(msg.id)) {
    aborted.delete(msg.id);
    return;
  }
  post({ type: 'done', id: msg.id });
}

self.onmessage = async (ev: MessageEvent<TtsIn>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    try {
      await load(msg.device, msg.engine);
    } catch {
      /* error already posted */
    }
    return;
  }
  if (msg.type === 'voices') {
    try {
      await load(loadedDevice ?? 'wasm', loadedEngine ?? 'kokoro');
      post({ type: 'voices', voices: kitten ? KITTEN_VOICES.map((v) => `kitten:${v}`) : Object.keys(kokoro!.voices) });
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
      await load(loadedDevice ?? 'wasm', loadedEngine ?? 'kokoro');
      if (kitten) await speakKitten(msg);
      else await speakKokoro(msg);
    } catch (e) {
      post({ type: 'error', id: msg.id, error: (e as Error).message });
    }
  }
};
