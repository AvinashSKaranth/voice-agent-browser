import { describe, expect, it } from 'vitest';
import calculator, { evalExpression } from '../src/tools/builtin/calculator';
import type { ToolContext } from '../src/core/types';

const ctx = {} as ToolContext;

describe('calculator', () => {
  it('evaluates "18% of 4250" to 765', () => {
    expect(evalExpression('18% of 4250')).toBe('765');
  });

  it('evaluates operator precedence: 2 + 2 * 3 = 8', () => {
    expect(evalExpression('2 + 2 * 3')).toBe('8');
  });

  it('evaluates unit conversion: 5 km to miles is about 3.1', () => {
    expect(evalExpression('5 km to miles')).toContain('3.1');
  });

  it('returns ok:false for an invalid expression', async () => {
    const result = await calculator.run({ expression: 'this is not math (' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
