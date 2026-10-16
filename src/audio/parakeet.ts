// NeMo TDT (Parakeet) speech-to-text on onnxruntime-web: a port of onnx-asr's nemo-conformer-tdt model
// (preprocessor -> encoder -> greedy decoder_joint loop). transformers.js has no NeMo pipeline, so stt.worker.ts
// runs this directly. Also used by bench/asr/browser.ts.
// The /webgpu entry is ORT's native WebGPU EP (asyncify build); the default entry's JSEP WebGPU kernels fail on
// Parakeet's encoder ("FILTER_IN_CHANNEL should be equal to DATA_CHANNEL"). Callers set ort.env.wasm.wasmPaths.
import * as ort from 'onnxruntime-web/webgpu';

export { ort };

/** Model file as a URL or its bytes. */
type ModelSource = string | Uint8Array;
export interface TdtFiles {
  preprocessor: ModelSource; // waveforms f32 [1, N], waveforms_lens i64 [1] -> features, features_lens
  encoder: ModelSource; // audio_signal, length -> outputs f32 [1, D, T], encoded_lengths
  decoder: ModelSource; // decoder_joint: encoder_outputs, targets, target_length, input_states_1/2 -> outputs, output_states_1/2
  vocab: string; // vocab.txt contents: "<piece> <id>" per line, blank is "<blk>"
}

const MAX_TOKENS_PER_STEP = 10; // onnx-asr's default for TDT

function session(src: ModelSource, ep: 'webgpu' | 'wasm'): Promise<ort.InferenceSession> {
  const opts = { executionProviders: [ep] };
  return typeof src === 'string' ? ort.InferenceSession.create(src, opts) : ort.InferenceSession.create(src, opts);
}

export function parseVocab(text: string): string[] {
  const vocab: string[] = [];
  for (const line of text.split('\n')) {
    const i = line.lastIndexOf(' ');
    if (i > 0) vocab[Number(line.slice(i + 1))] = line.slice(0, i).replaceAll('▁', ' ');
  }
  return vocab;
}

/** Joins pieces the way onnx-asr does: special pieces (<unk>, <|...|>) dropped, the leading space and spaces
 * not followed by a word character removed. */
export function detokenize(vocab: string[], ids: number[]): string {
  return ids
    .map((i) => vocab[i])
    .filter((p) => !p.startsWith('<'))
    .join('')
    .replace(/^\s|\s\B|(\s)\b/g, (_m, g1) => (g1 ? ' ' : ''))
    .trim();
}

const argmax = (a: Float32Array, from: number, to: number): number => {
  let best = from;
  for (let i = from + 1; i < to; i++) if (a[i] > a[best]) best = i;
  return best;
};

export async function loadTdt(files: TdtFiles, device: 'webgpu' | 'wasm'): Promise<(pcm: Float32Array) => Promise<string>> {
  // Sequential with the GPU session first: parallel creation races ORT's one-time wasm init and drops WebGPU.
  const enc = await session(files.encoder, device);
  // The decoder (LSTM + joint) runs once per token on tiny tensors: GPU round trips would dominate, so WASM.
  const dec = await session(files.decoder, 'wasm');
  const pre = await session(files.preprocessor, 'wasm');
  const vocab = parseVocab(files.vocab);
  const blank = vocab.indexOf('<blk>');
  if (blank < 0) throw new Error('Parakeet vocabulary has no blank token.');
  const vocabSize = vocab.length;
  const stateShape = (name: string) => (dec.inputMetadata[dec.inputNames.indexOf(name)] as { shape: ReadonlyArray<number | string> }).shape;
  const zeros = (s: ReadonlyArray<number | string>): ort.Tensor => new ort.Tensor('float32', new Float32Array(Number(s[0]) * Number(s[2])), [Number(s[0]), 1, Number(s[2])]);
  const s1Shape = stateShape('input_states_1'), s2Shape = stateShape('input_states_2');

  return async (pcm) => {
    const feats = await pre.run({
      waveforms: new ort.Tensor('float32', pcm, [1, pcm.length]),
      waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(pcm.length)]), [1]),
    });
    const { outputs, encoded_lengths } = await enc.run({ audio_signal: feats.features, length: feats.features_lens });
    const [, D, T] = outputs.dims;
    const data = outputs.data as Float32Array; // [1, D, T]
    const len = Number((encoded_lengths.data as BigInt64Array)[0]);
    let s1 = zeros(s1Shape), s2 = zeros(s2Shape);
    const tokens: number[] = [];
    const frame = new Float32Array(D);
    let t = 0, emitted = 0;
    while (t < len) {
      for (let d = 0; d < D; d++) frame[d] = data[d * T + t];
      const r = await dec.run({
        encoder_outputs: new ort.Tensor('float32', frame, [1, D, 1]),
        targets: new ort.Tensor('int32', Int32Array.from([tokens.length ? tokens[tokens.length - 1] : blank]), [1, 1]),
        target_length: new ort.Tensor('int32', Int32Array.from([1]), [1]),
        input_states_1: s1,
        input_states_2: s2,
      });
      const o = r.outputs.data as Float32Array; // vocabSize token logits, then the duration logits
      const tok = argmax(o, 0, vocabSize);
      const step = argmax(o, vocabSize, o.length) - vocabSize;
      if (tok !== blank) {
        s1 = r.output_states_1;
        s2 = r.output_states_2;
        tokens.push(tok);
        emitted++;
      }
      if (step > 0) {
        t += step;
        emitted = 0;
      } else if (tok === blank || emitted === MAX_TOKENS_PER_STEP) {
        t += 1;
        emitted = 0;
      }
    }
    return detokenize(vocab, tokens);
  };
}
