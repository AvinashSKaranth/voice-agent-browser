// Browser side of the ASR bench. Same protocol as common.py's stream_segment(): feed each utterance
// word by word in real time, re-transcribe the growing buffer, then one final pass. Returns raw
// timings only; scoring happens in Python (score_browser.py) so both sides use the same normalizer.
//
// Whisper runs through transformers.js exactly like the app (src/audio/stt-models.ts dtypes).
// Canary and Parakeet Redux run on onnxruntime-web with a port of onnx-asr's NeMo decoding
// (same ONNX files and preprocessor graph as the native onnx-asr runs). Phonon-2 uses a community ONNX export.
// The /webgpu entry is ORT's native WebGPU EP (asyncify build, same as transformers.js uses); the default
// entry's JSEP WebGPU kernels fail on Parakeet's encoder (Conv FILTER_IN_CHANNEL != DATA_CHANNEL).
import * as ort from 'onnxruntime-web/webgpu';
import { pipeline } from '@huggingface/transformers';
import { STT_MODELS } from '../../src/audio/stt-models';
import { loadTdt as loadAppTdt } from '../../src/audio/parakeet';

type Device = 'wasm' | 'webgpu';
type Transcribe = (pcm: Float32Array) => Promise<string>;
interface Word { w: string; start: number; end: number }
interface Segment { id: string; text: string; start: number; end: number; words: Word[] }

const TAIL_S = 0.4;
const HF = 'https://huggingface.co';
const log = (s: string) => { document.getElementById('log')!.textContent += '\n' + s; console.log(s); };
const now = () => performance.now() / 1000;
const sleep = (s: number) => new Promise((r) => setTimeout(r, Math.max(0, s * 1000)));

function parseWav(buf: ArrayBuffer): Float32Array {
  const v = new DataView(buf);
  let p = 12;
  while (p < v.byteLength) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    const size = v.getUint32(p + 4, true);
    if (id === 'data') {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = v.getInt16(p + 8 + i * 2, true) / 32768;
      return out;
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('wav has no data chunk');
}

// ---------- NeMo (onnx-asr port) ----------

async function session(url: string, device: Device) {
  const s = await ort.InferenceSession.create(url, { executionProviders: device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'] });
  return s;
}
let epDropped = false;
const origWarn = console.warn;
console.warn = (...a: unknown[]) => { if (String(a[0]).includes('removing requested execution provider')) epDropped = true; origWarn(...a); };

async function loadVocab(url: string): Promise<string[]> {
  const vocab: string[] = [];
  for (const line of (await (await fetch(url)).text()).split('\n')) {
    if (!line) continue;
    const i = line.lastIndexOf(' ');
    vocab[Number(line.slice(i + 1))] = line.slice(0, i).replaceAll('▁', ' ');
  }
  return vocab;
}

// onnx-asr's DECODE_SPACE_PATTERN: drop the leading space and spaces not followed by a word char.
const detok = (vocab: string[], ids: number[]) => ids.map((i) => vocab[i]).join('').replace(/^\s|\s\B|(\s)\b/g, (_m, g1) => (g1 ? ' ' : ''));

const argmax = (a: Float32Array | number[], from = 0, to = a.length) => {
  let best = from;
  for (let i = from + 1; i < to; i++) if (a[i] > a[best]) best = i;
  return best;
};

async function nemoFeatures(pre: ort.InferenceSession, pcm: Float32Array) {
  const out = await pre.run({
    waveforms: new ort.Tensor('float32', pcm, [1, pcm.length]),
    waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(pcm.length)]), [1]),
  });
  return { audio_signal: out.features, length: out.features_lens };
}

// Greedy TDT decoding: the app's own implementation (src/audio/parakeet.ts), shared by Parakeet Redux and Phonon-2.
async function loadTdt(device: Device, repo: string, encFile: string, preUrl: string): Promise<Transcribe> {
  const vocab = await (await fetch(`${repo}/vocab.txt`)).text();
  return loadAppTdt({ encoder: `${repo}/${encFile}`, decoder: `${repo}/decoder_joint-model.onnx`, preprocessor: preUrl, vocab }, device);
}

const loadParakeetRedux = (device: Device) =>
  loadTdt(device, `${HF}/eschmidbauer/parakeet-redux-onnx/resolve/main`, 'encoder-model.onnx', './models/nemo128.onnx');

// Community ONNX export of Phonon-2 (Parakeet TDT 0.6B v3 derivative). exact4x2 = Fermion's weights bit for bit
// as two ternary planes in 4-bit MatMulNBits (662 MB); the fp32 encoder is 2.4 GB, too big for a tab.
const PHONON = `${HF}/tiyuvta/Phonon-2-ONNX/resolve/main`;
const loadPhonon2 = (device: Device) => loadTdt(device, PHONON, 'encoder-model.exact4x2.onnx', `${PHONON}/preprocessor-model.onnx`);

async function loadCanary(device: Device): Promise<Transcribe> {
  const repo = `${HF}/istupakov/canary-180m-flash-onnx/resolve/main`;
  // WASM: int8 (what you would ship to a CPU browser). WebGPU: fp32 - int8 MatMulInteger has no WebGPU kernel.
  const q = device === 'wasm' ? '.int8' : '';
  const enc = await session(`${repo}/encoder-model${q}.onnx`, device);
  const dec = await session(`${repo}/decoder-model${q}.onnx`, device);
  const pre = await session('./models/nemo128.onnx', 'wasm');
  const vocab = await loadVocab(`${repo}/vocab.txt`);
  // lastIndexOf: the aggregate vocab repeats '▁' per language; onnx-asr's token->id dict keeps the last (English) one.
  const id = (t: string) => vocab.lastIndexOf(t);
  const prefix = [' ', '<|startofcontext|>', '<|startoftranscript|>', '<|emo:undefined|>', '<|en|>', '<|en|>', '<|pnc|>', '<|noitn|>', '<|notimestamp|>', '<|nodiarize|>'].map(id);
  const eos = id('<|endoftext|>');
  const memShape = (dec.inputMetadata[dec.inputNames.indexOf('decoder_mems')] as { shape: (number | string)[] }).shape;
  return async (pcm) => {
    const { encoder_embeddings, encoder_mask } = await enc.run(await nemoFeatures(pre, pcm));
    const tokens = [...prefix];
    let mems = new ort.Tensor('float32', new Float32Array(0), [Number(memShape[0]), 1, 0, Number(memShape[3])]);
    while (tokens.length < 1024) {
      const ids = mems.dims[2] === 0 ? tokens : tokens.slice(-1);
      const r = await dec.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        encoder_embeddings, encoder_mask, decoder_mems: mems,
      });
      const [, L, V] = r.logits.dims;
      const logits = r.logits.data as Float32Array;
      const next = argmax(logits, (L - 1) * V, L * V) - (L - 1) * V;
      mems = r.decoder_hidden_states;
      if (next === eos) break;
      tokens.push(next);
    }
    return detok(vocab, tokens.slice(prefix.length).filter((t) => !vocab[t].startsWith('<|'))).trim();
  };
}

// phonon-2-c (eschmidbauer): pure-C engine on Phonon-2's packed five-value weights (187 MB download, ~255 MB in
// memory, exact), compiled to single-threaded WASM SIMD by wasm/build.sh. CPU only.
interface P2Module {
  HEAPU8: Uint8Array; HEAPF32: Float32Array; _malloc(n: number): number; _free(p: number): void; UTF8ToString(p: number): string;
  _p2_engine_open_mem(bin: number, binLen: number, json: number, jsonLen: number, tok: number, tokLen: number): number;
  _p2w_transcribe(e: number, audio: number, n: number): number;
}
async function loadPhonon2C(device: Device): Promise<Transcribe> {
  if (device !== 'wasm') throw new Error('phonon-2-c is a CPU engine; it has no WebGPU path');
  const init = (await import(/* @vite-ignore */ new URL('./wasm/phonon2.mjs', import.meta.url).href)).default as () => Promise<P2Module>;
  const M = await init();
  const get = async (f: string) => new Uint8Array(await (await fetch(`./models/phonon-2-c/${f}`)).arrayBuffer());
  const [bin, json, tok] = [await get('weights.bin'), await get('weights.json'), await get('tokens.txt')];
  const put = (b: Uint8Array) => { const p = M._malloc(b.length + 1); M.HEAPU8.set(b, p); M.HEAPU8[p + b.length] = 0; return p; };
  const pj = put(json), pt = put(tok);
  const engine = M._p2_engine_open_mem(put(bin), bin.length, pj, json.length, pt, tok.length); // bin stays: the model reads from it
  M._free(pj); M._free(pt);
  if (!engine) throw new Error('phonon-2-c failed to load its weights');
  let cap = 0, pa = 0;
  return async (pcm) => {
    if (pcm.length > cap) { if (pa) M._free(pa); cap = pcm.length; pa = M._malloc(cap * 4); }
    M.HEAPF32.set(pcm, pa >> 2);
    const pr = M._p2w_transcribe(engine, pa, pcm.length);
    if (!pr) throw new Error('phonon-2-c transcription failed');
    const text = M.UTF8ToString(pr);
    M._free(pr);
    return text.trim();
  };
}

async function loadWhisper(device: Device): Promise<Transcribe> {
  const def = STT_MODELS['whisper-base'];
  const asr = await pipeline('automatic-speech-recognition', def.repo, { device, dtype: def.dtype[device] });
  return async (pcm) => {
    const out = (await asr(pcm, { language: 'en', task: 'transcribe' })) as { text: string };
    return out.text.trim();
  };
}

const LOADERS: Record<string, (d: Device) => Promise<Transcribe>> = {
  'whisper-base': loadWhisper,
  'canary-180m-flash': loadCanary,
  'parakeet-redux': loadParakeetRedux,
  'phonon-2': loadPhonon2,
  'phonon-2-c': loadPhonon2C,
};

// ---------- protocol (mirror of common.py) ----------

async function streamSegment(tr: Transcribe, x: Float32Array, seg: Segment) {
  const tEnd = seg.words.map((w) => w.end - seg.start);
  const steps: Array<{ word: number; audio_s: number; start: number; done: number; text: string }> = [];
  const t0 = now();
  let i = 0;
  while (i < tEnd.length) {
    await sleep(tEnd[i] - (now() - t0));
    while (i + 1 < tEnd.length && tEnd[i + 1] <= now() - t0) i++;
    const a = now() - t0;
    const text = await tr(x.subarray(0, Math.round(tEnd[i] * 16000)));
    steps.push({ word: i, audio_s: tEnd[i], start: a, done: now() - t0, text });
    i++;
  }
  await sleep(x.length / 16000 - (now() - t0));
  const finalStart = now() - t0;
  const final = await tr(x);
  return { segment: seg.id, steps, final, final_start: finalStart, final_done: now() - t0, last_word_end: tEnd[tEnd.length - 1] };
}

async function bench(model: string, device: Device) {
  if (device === 'webgpu' && !(navigator as { gpu?: unknown }).gpu) throw new Error('WebGPU not available in this browser');
  ort.env.wasm.numThreads = 1; // no COOP/COEP on GitHub Pages, same as the app
  ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/'; // Vite prebundling breaks ORT's import.meta.url lookup
  const [wav, truth] = await Promise.all([
    fetch('./data/test.wav').then((r) => r.arrayBuffer()),
    fetch('./data/truth.json').then((r) => r.json() as Promise<{ segments: Segment[] }>),
  ]);
  const audio = parseWav(wav);
  const segAudio = (s: Segment) => audio.subarray(Math.round(s.start * 16000), Math.round((s.end + TAIL_S) * 16000));
  log(`${model} / ${device}: loading`);
  let t = now();
  const tr = await LOADERS[model](device);
  const loadS = now() - t;
  if (device === 'webgpu' && epDropped) throw new Error('ORT dropped the WebGPU execution provider; result would be WASM');
  t = now();
  const warm = await tr(segAudio(truth.segments[0]));
  const warmupS = now() - t;
  log(`  loaded in ${loadS.toFixed(1)}s, warm-up ${warmupS.toFixed(2)}s: ${warm}`);
  const offline = [];
  for (const seg of truth.segments) {
    const x = segAudio(seg);
    const times: number[] = [];
    let text = '';
    for (let k = 0; k < 3; k++) { t = now(); text = await tr(x); times.push(now() - t); }
    times.sort((a, b) => a - b);
    offline.push({ segment: seg.id, audio_s: x.length / 16000, time_s: times[1], text });
    log(`  offline ${seg.id}: ${times[1].toFixed(3)}s  ${text}`);
  }
  const streaming = [];
  for (const seg of truth.segments) {
    const r = await streamSegment(tr, segAudio(seg), seg);
    streaming.push(r);
    log(`  stream ${seg.id}: ${r.steps.length}/${seg.words.length} steps, final +${(r.final_done - r.final_start).toFixed(2)}s`);
  }
  return { model, device, load_s: loadS, warmup_s: warmupS, offline, streaming, ua: navigator.userAgent };
}

(window as unknown as { bench: typeof bench }).bench = bench;
log('ready');
