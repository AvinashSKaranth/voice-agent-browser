// Wake-word worker: openWakeWord ONNX pipeline (melspectrogram -> embedding -> phrase head) via onnxruntime-web.
import * as ort from 'onnxruntime-web';
import type { WorkerProgress } from '../core/types';

// Local protocol (not in core/types.ts: wake-word has no shared contract there).
export type WakeIn =
  | { type: 'load'; phrase: string; baseHref: string }
  | { type: 'frame'; frame: Float32Array }
  | { type: 'threshold'; value: number };
export type WakeOut = WorkerProgress | { type: 'detect'; score: number };

const MEL_FRAME_LEN = 1280;
const MEL_WINDOW = 76;
const EMB_WINDOW = 16;
const EMB_STEP_MELS = 8;
const DEBOUNCE_MS = 2000;

let melSession: ort.InferenceSession | null = null;
let embSession: ort.InferenceSession | null = null;
let phraseSession: ort.InferenceSession | null = null;
let threshold = 0.5;
let lastDetectTs = 0;

const melBuffer: Float32Array[] = []; // each length 32
let melSinceEmbedding = 0;
const embBuffer: Float32Array[] = []; // each length 96

let frameBusy = false;
const frameQueue: Float32Array[] = [];

function post(msg: WakeOut): void {
  (self as unknown as { postMessage(m: WakeOut): void }).postMessage(msg);
}

async function loadSession(url: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
}

async function load(phrase: string, baseHref: string): Promise<void> {
  try {
    ort.env.wasm.wasmPaths = new URL('./ort/', baseHref).href;
    ort.env.wasm.numThreads = 1;
    const modelsBase = new URL('./models/oww/', baseHref).href;
    const phraseFile = phrase.endsWith('.onnx') ? phrase : `${phrase}_v0.1.onnx`;
    post({ type: 'progress', loaded: 0, total: 3, status: 'downloading' });
    melSession = await loadSession(new URL('melspectrogram.onnx', modelsBase).href);
    post({ type: 'progress', loaded: 1, total: 3, status: 'downloading' });
    embSession = await loadSession(new URL('embedding_model.onnx', modelsBase).href);
    post({ type: 'progress', loaded: 2, total: 3, status: 'downloading' });
    phraseSession = await loadSession(new URL(phraseFile, modelsBase).href);
    melBuffer.length = 0;
    embBuffer.length = 0;
    melSinceEmbedding = 0;
    post({ type: 'progress', loaded: 3, total: 3, status: 'ready' });
  } catch (e) {
    melSession = embSession = phraseSession = null;
    post({ type: 'progress', loaded: 0, total: 0, status: 'error', error: (e as Error).message });
  }
}

async function processFrame(frame: Float32Array): Promise<void> {
  if (!melSession || !embSession || !phraseSession) return;
  const scaled = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) scaled[i] = frame[i] * 32767;

  const melInputName = melSession.inputNames[0];
  const melOut = await melSession.run({ [melInputName]: new ort.Tensor('float32', scaled, [1, MEL_FRAME_LEN]) });
  const melData = melOut[melSession.outputNames[0]].data as Float32Array; // [1,1,5,32]
  for (let row = 0; row < 5; row++) {
    const mel = new Float32Array(32);
    for (let c = 0; c < 32; c++) mel[c] = melData[row * 32 + c] / 10 + 2;
    melBuffer.push(mel);
  }
  if (melBuffer.length > 200) melBuffer.splice(0, melBuffer.length - 200);
  melSinceEmbedding += 5;

  while (melSinceEmbedding >= EMB_STEP_MELS && melBuffer.length >= MEL_WINDOW) {
    const window = melBuffer.slice(melBuffer.length - MEL_WINDOW);
    const embInput = new Float32Array(MEL_WINDOW * 32);
    for (let r = 0; r < MEL_WINDOW; r++) embInput.set(window[r], r * 32);
    const embInputName = embSession.inputNames[0];
    const embOut = await embSession.run({ [embInputName]: new ort.Tensor('float32', embInput, [1, MEL_WINDOW, 32, 1]) });
    const embData = embOut[embSession.outputNames[0]].data as Float32Array; // [1,1,1,96]
    embBuffer.push(new Float32Array(embData));
    if (embBuffer.length > EMB_WINDOW) embBuffer.splice(0, embBuffer.length - EMB_WINDOW);
    melSinceEmbedding -= EMB_STEP_MELS;

    if (embBuffer.length >= EMB_WINDOW) {
      const phraseInput = new Float32Array(EMB_WINDOW * 96);
      for (let r = 0; r < EMB_WINDOW; r++) phraseInput.set(embBuffer[r], r * 96);
      const phraseInputName = phraseSession.inputNames[0];
      const phraseOut = await phraseSession.run({ [phraseInputName]: new ort.Tensor('float32', phraseInput, [1, EMB_WINDOW, 96]) });
      const score = (phraseOut[phraseSession.outputNames[0]].data as Float32Array)[0];
      const now = Date.now();
      if (score >= threshold && now - lastDetectTs > DEBOUNCE_MS) {
        lastDetectTs = now;
        post({ type: 'detect', score });
      }
    }
  }
}

// Serialises processFrame: the rolling mel/embedding buffers are shared mutable state, so two
// frames must never be processed concurrently. Frames beyond a 2-deep queue are dropped.
// ponytail: drops frames under load rather than back-pressuring the mic; fine for a debounced
// wake trigger, revisit if frame drops start hurting detection recall.
async function handleFrame(frame: Float32Array): Promise<void> {
  if (frameBusy) {
    if (frameQueue.length < 2) frameQueue.push(frame);
    return;
  }
  frameBusy = true;
  try {
    await processFrame(frame);
    while (frameQueue.length) {
      await processFrame(frameQueue.shift()!);
    }
  } finally {
    frameBusy = false;
  }
}

self.onmessage = (ev: MessageEvent<WakeIn>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    void load(msg.phrase, msg.baseHref);
  } else if (msg.type === 'frame') {
    void handleFrame(msg.frame);
  } else if (msg.type === 'threshold') {
    threshold = msg.value;
  }
};
