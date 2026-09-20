import { describe, expect, it, vi } from 'vitest';

// pipeline.ts imports these audio modules directly; mock them so importing it in jsdom never
// touches a real Worker/AudioContext/getUserMedia. The vad/onnx/transformers/kokoro packages are
// not imported by pipeline.ts itself but are mocked too per the module-ownership rule, in case a
// transitive import chain changes later.
vi.mock('../src/audio/mic', () => ({ mic: { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), active: () => false, vadReady: () => false } }));
vi.mock('../src/audio/stt', () => ({ stt: { load: vi.fn(), transcribe: vi.fn(), ready: () => false } }));
vi.mock('../src/audio/tts', () => ({ tts: { load: vi.fn(), say: vi.fn(), stop: vi.fn(), voices: vi.fn(), ready: () => false, speaking: () => false } }));
vi.mock('../src/audio/wake', () => ({ wake: { load: vi.fn(), feed: vi.fn(), onDetect: vi.fn(), setThreshold: vi.fn(), ready: () => false, lastScore: () => 0 } }));
vi.mock('../src/audio/player', () => ({ player: { init: vi.fn(), enqueue: vi.fn(() => Promise.resolve()), stop: vi.fn(), playing: () => false } }));
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: vi.fn() } }));
vi.mock('onnxruntime-web', () => ({}));
vi.mock('@huggingface/transformers', () => ({}));
vi.mock('kokoro-js', () => ({}));

const { looksLikeHallucination } = await import('../src/audio/pipeline');

describe('looksLikeHallucination', () => {
  it('flags the bare word "You" as a hallucination', () => {
    expect(looksLikeHallucination('You', new Float32Array(16000).fill(0.5))).toBe(true);
  });

  it('flags "Thank you." as a hallucination', () => {
    expect(looksLikeHallucination('Thank you.', new Float32Array(16000).fill(0.5))).toBe(true);
  });

  it('flags near-silent audio (low RMS) regardless of text', () => {
    const silence = new Float32Array(16000); // all zeros
    expect(looksLikeHallucination('a completely normal sentence', silence)).toBe(true);
  });

  it('does not flag a real sentence spoken over real audio', () => {
    const loud = new Float32Array(16000).fill(0.5);
    expect(looksLikeHallucination('What is the weather like today', loud)).toBe(false);
  });
});
