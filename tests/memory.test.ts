import { describe, expect, it } from 'vitest';
import { scoreText } from '../src/storage/memory';

describe('scoreText', () => {
  it('counts how many of the query words appear in the text', () => {
    const words = ['coffee', 'morning'];
    expect(scoreText('the user likes dark roast coffee in the morning', words)).toBe(2);
    expect(scoreText('user prefers tea over coffee at night', words)).toBe(1);
    expect(scoreText('unrelated fact about cars', words)).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(scoreText('COFFEE time', ['coffee'])).toBe(1);
  });
});
