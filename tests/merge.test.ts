import { describe, expect, it } from 'vitest';
import { mergePartialAndTail } from '../src/audio/merge';

describe('mergePartialAndTail', () => {
  it('joins on a multi-word overlap, case/punctuation-insensitive', () => {
    expect(mergePartialAndTail('what is the weather like', 'Weather like, today?')).toBe('what is the Weather like, today?');
  });

  it('joins on a single-word overlap', () => {
    expect(mergePartialAndTail('turn on the', 'the lights please')).toBe('turn on the lights please');
  });

  it('concatenates when there is no overlap', () => {
    expect(mergePartialAndTail('hello there', 'general kenobi')).toBe('hello there general kenobi');
  });

  it('returns the tail alone when the partial is empty', () => {
    expect(mergePartialAndTail('', 'hello world')).toBe('hello world');
  });

  it('returns the partial alone when the tail is empty', () => {
    expect(mergePartialAndTail('hello world', '')).toBe('hello world');
  });

  it('caps the overlap search at 6 words', () => {
    const partial = 'one two three four five six seven';
    const tail = 'two three four five six seven eight';
    // only the last 6 words of `partial` are checked, and they equal the first 6 of `tail`
    expect(mergePartialAndTail(partial, tail)).toBe('one two three four five six seven eight');
  });
});
