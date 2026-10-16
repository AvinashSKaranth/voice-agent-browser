import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { DEFAULT_STT_MODEL, activeSttModel } from '../src/audio/stt-models';

vi.mock('onnxruntime-web/webgpu', () => ({})); // only the pure text helpers are under test
const { detokenize, parseVocab } = await import('../src/audio/parakeet');

describe('activeSttModel', () => {
  it('uses the current default until the user picks a model, then their pick', () => {
    const local = { ...DEFAULT_SETTINGS.local, sttModel: 'moonshine-base' as const }; // saved under the old default
    expect(activeSttModel(local)).toBe(DEFAULT_STT_MODEL);
    expect(activeSttModel({ ...local, sttModelExplicit: true })).toBe('moonshine-base');
  });
});

describe('parakeet detokenize', () => {
  const vocab = parseVocab('<unk> 0\n▁hey 1\n▁jar 2\nvis 3\n, 4\n▁ten 5\n<|nospeech|> 6\n<blk> 7\n');
  it('joins SentencePiece pieces and drops special tokens like onnx-asr', () => {
    expect(vocab[7]).toBe('<blk>');
    expect(detokenize(vocab, [1, 2, 3, 4, 6, 5, 0])).toBe('hey jarvis, ten');
    expect(detokenize(vocab, [])).toBe('');
  });
});
