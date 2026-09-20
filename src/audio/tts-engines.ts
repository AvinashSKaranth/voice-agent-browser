// TTS engine registry: id -> label + capabilities. Kokoro-82M (kokoro-js) gives the best quality
// but takes ~3s to produce first audio on an integrated GPU. KittenTTS (StyleTTS2, 'kitten-nano' /
// 'kitten-mini') trades quality for speed.
//
// KittenTTS goes through the kitten-tts-js npm package, not @huggingface/transformers's
// text-to-speech pipeline: transformers.js 4.3's generic pipeline for the 'style_text_to_speech_2'
// architecture (_call_text_to_waveform) only ever forwards tokenizer output to the model with no
// speaker-embedding hook, and KittenTTS's per-voice style vectors live in a separate voices.npz
// the pipeline never touches. kitten-tts-js already does the npz parsing + eSpeak phonemization +
// ONNX inference this needs.
// ponytail: kitten-tts-js hardcodes the 'wasm' execution provider (never passes 'webgpu' to
// onnxruntime-web), so both Kitten engines run on WASM only here even though Nano's ONNX export
// can do WebGPU in principle - upgrade path is a custom pipeline call if that's ever worth it.
import type { TtsEngine } from '../core/types';

export interface TtsEngineDef {
  id: TtsEngine;
  label: string;
  note: string;
  webgpu: boolean; // whether this integration supports WebGPU
  defaultVoice: string; // settings.voice.id value to fall back to when switching into this engine
}

export const TTS_ENGINES: Record<TtsEngine, TtsEngineDef> = {
  kokoro: { id: 'kokoro', label: 'Kokoro 82M', note: 'Best quality, ~3s first audio on an integrated GPU.', webgpu: true, defaultVoice: 'af_heart' },
  'kitten-nano': { id: 'kitten-nano', label: 'KittenTTS Nano 15M', note: 'Fastest.', webgpu: false, defaultVoice: 'kitten:Leo' },
  'kitten-mini': { id: 'kitten-mini', label: 'KittenTTS Mini 80M', note: 'Better quality than Nano, WASM only.', webgpu: false, defaultVoice: 'kitten:Leo' },
};

// kitten-tts-js's downloadModel() only recognizes these HF repo ids (the original KittenML repos -
// it fetches config.json/onnx/voices.npz straight from the hub itself, no onnx-community mirror).
export const KITTEN_REPO: Record<'kitten-nano' | 'kitten-mini', string> = {
  'kitten-nano': 'KittenML/kitten-tts-nano-0.8',
  'kitten-mini': 'KittenML/kitten-tts-mini-0.8',
};

export const KITTEN_VOICES = ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'];

export function isKittenEngine(engine: TtsEngine): engine is 'kitten-nano' | 'kitten-mini' {
  return engine !== 'kokoro';
}
