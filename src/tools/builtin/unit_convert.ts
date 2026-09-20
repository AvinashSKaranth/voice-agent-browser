import { evaluate } from 'mathjs';
import type { Tool } from '../../core/types';

const unit_convert: Tool = {
  spec: {
    name: 'unit_convert',
    description: 'Convert a value between units of length, mass, volume, temperature, etc. (not currency).',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number' },
        from: { type: 'string', description: 'Source unit, e.g. "km", "lb", "celsius"' },
        to: { type: 'string', description: 'Target unit, e.g. "mi", "kg", "fahrenheit"' },
      },
      required: ['value', 'from', 'to'],
    },
  },
  spoken: 'Let me work that out',
  async run(args) {
    const value = Number(args.value);
    const from = String(args.from ?? '');
    const to = String(args.to ?? '');
    try {
      const result = evaluate(`${value} ${from} to ${to}`);
      return { ok: true, content: result.toString() };
    } catch (e) {
      return { ok: false, content: '', error: `Could not convert ${value} ${from} to ${to}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

export default unit_convert;
