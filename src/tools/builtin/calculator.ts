import { evaluate } from 'mathjs';
import type { Tool } from '../../core/types';

const PERCENT_OF_RE = /(\d+(?:\.\d+)?)\s*%\s*of\s*/gi;

export function evalExpression(expr: string): string {
  const rewritten = expr.replace(PERCENT_OF_RE, '$1/100*');
  const result = evaluate(rewritten);
  return typeof result === 'object' && result !== null && 'toString' in result ? result.toString() : String(result);
}

const calculator: Tool = {
  spec: {
    name: 'calculator',
    description: 'Evaluate an arithmetic expression: basic math, percentages ("18% of 4250"), and unit-aware expressions (e.g. "5 km + 2 mi"). Use for any calculation instead of guessing.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'The expression to evaluate, e.g. "18% of 4250" or "(3+4)*2"' } },
      required: ['expression'],
    },
  },
  spoken: 'Let me work that out',
  async run(args) {
    const expression = String(args.expression ?? '');
    try {
      return { ok: true, content: evalExpression(expression) };
    } catch (e) {
      return { ok: false, content: '', error: `Could not evaluate "${expression}": ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

export default calculator;

if (import.meta.env.DEV) {
  console.assert(evalExpression('18% of 4250') === '765', `calculator: expected 765, got ${evalExpression('18% of 4250')}`);
}
