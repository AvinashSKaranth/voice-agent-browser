// STT model registry: id -> repo + per-device dtype. Verified against each repo's onnx/ file
// listing (huggingface.co/api/models/<repo>/tree/main/onnx) on 2026-09-20 - every whisper/distil
// repo ships encoder_model{,_quantized,_fp16} and decoder_model_merged{,_quantized,_fp16,_q4}, so
// webgpu can use fp32 encoder + q4 decoder and wasm the quantized (q8) pair. Moonshine ships the
// same file set; transformers.js 4.3's Moonshine pipeline (_call_moonshine) ignores whisper-only
// kwargs like language/task by simply spreading them into generate(), which throws for a model
// that has no such generation config entries - so callers must omit them for englishOnly models.
//
// Hybrid device (encoder on webgpu, decoder on wasm): every model here resolves to transformers.js's
// Seq2Seq session config (sessions = { model: "encoder_model", decoder_model_merged: "decoder_model_merged" }
// in dist/transformers.web.js's MODEL_SESSION_CONFIG / MODEL_FOR_SPEECH_SEQ_2_SEQ_MAPPING_NAMES), and
// getSession()/selectDevice() (dist/transformers.web.js ~L9835, ~L19544-19552) look up a per-file
// device from a device object keyed by that same onnx file name - the exact mechanism already used
// for per-component dtype below. So a `device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }`
// map is honoured out of the box for whisper/distil/moonshine alike; hybridDevice is only left
// undefined for a model whose session file names diverge from this pair.
import type { DataType } from '@huggingface/transformers';
import type { SttModelId } from '../core/types';

type Dtype = DataType | Record<string, DataType>;
type DeviceMap = Record<string, 'wasm' | 'webgpu'>;

export interface SttModelDef {
  id: SttModelId;
  repo: string;
  label: string;
  sizeMb: number; // approx download size for the webgpu dtype (encoder fp32 + decoder q4)
  note: string;
  englishOnly: boolean; // true => never pass language/task to the pipeline
  dtype: {
    webgpu: Dtype;
    wasm: Dtype;
    hybrid?: Dtype; // per-component dtype used only when hybridDevice is set
  };
  hybridDevice?: DeviceMap; // per-component device map; undefined => hybrid unsupported for this model
}

// Shared by every model below: all five repos expose the same encoder_model/decoder_model_merged
// onnx pair (see header comment), so the hybrid device/dtype maps are identical across models.
const HYBRID_DEVICE: DeviceMap = { encoder_model: 'webgpu', decoder_model_merged: 'wasm' };
const HYBRID_DTYPE: Record<string, DataType> = { encoder_model: 'fp32', decoder_model_merged: 'q8' };

const WHISPER_DTYPE: { webgpu: Record<string, DataType>; wasm: Record<string, DataType>; hybrid: Record<string, DataType> } = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  hybrid: HYBRID_DTYPE,
};

export const STT_MODELS: Record<SttModelId, SttModelDef> = {
  'whisper-tiny': {
    id: 'whisper-tiny',
    repo: 'onnx-community/whisper-tiny',
    label: 'Whisper tiny',
    sizeMb: 114,
    note: 'Fastest, least accurate. Multilingual.',
    englishOnly: false,
    dtype: WHISPER_DTYPE,
    hybridDevice: HYBRID_DEVICE,
  },
  'whisper-base': {
    id: 'whisper-base',
    repo: 'onnx-community/whisper-base',
    label: 'Whisper base',
    sizeMb: 197,
    note: 'Default. Balanced speed/accuracy. Multilingual.',
    englishOnly: false,
    dtype: WHISPER_DTYPE,
    hybridDevice: HYBRID_DEVICE,
  },
  'distil-small.en': {
    id: 'distil-small.en',
    repo: 'onnx-community/distil-small.en',
    label: 'Distil-Whisper small (English)',
    sizeMb: 513,
    note: 'English-only. Larger download, whisper-base-ish latency.',
    englishOnly: true,
    dtype: WHISPER_DTYPE,
    hybridDevice: HYBRID_DEVICE,
  },
  'moonshine-tiny': {
    id: 'moonshine-tiny',
    repo: 'onnx-community/moonshine-tiny-ONNX',
    label: 'Moonshine tiny',
    sizeMb: 72,
    note: 'English-only. No 30 s mel padding, so encoder cost scales with speech length.',
    englishOnly: true,
    dtype: { webgpu: 'fp32', wasm: 'q8', hybrid: HYBRID_DTYPE },
    hybridDevice: HYBRID_DEVICE,
  },
  'moonshine-base': {
    id: 'moonshine-base',
    repo: 'onnx-community/moonshine-base-ONNX',
    label: 'Moonshine base',
    sizeMb: 147,
    note: 'English-only. No 30 s mel padding, so encoder cost scales with speech length.',
    englishOnly: true,
    dtype: { webgpu: 'fp32', wasm: 'q8', hybrid: HYBRID_DTYPE },
    hybridDevice: HYBRID_DEVICE,
  },
};

export const DEFAULT_STT_MODEL: SttModelId = 'moonshine-base';

// Measured 2026-09-20 on an integrated GPU (8 s clip): whisper-tiny webgpu 2.3 s, whisper-base
// webgpu 4.5 s, moonshine-base webgpu 2.0 s / hybrid 1.4 s. Hybrid only helps Moonshine.
export function autoDevice(modelId: SttModelId, hasWebGPU: boolean): 'wasm' | 'webgpu' | 'hybrid' {
  if (!hasWebGPU) return 'wasm';
  return modelId.startsWith('moonshine') ? 'hybrid' : 'webgpu';
}
