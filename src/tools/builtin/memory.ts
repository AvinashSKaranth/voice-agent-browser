import type { Tool } from '../../core/types';
import { memory } from '../../storage/memory';

export const remember: Tool = {
  spec: {
    name: 'remember',
    description: 'Save a fact for later, e.g. a preference or piece of personal information the user shares.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['text'],
    },
  },
  spoken: 'Got it, remembering that',
  async run(args) {
    const text = String(args.text ?? '');
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
    await memory.remember(text, tags);
    return { ok: true, content: `Remembered: ${text}` };
  },
};

export const recall: Tool = {
  spec: {
    name: 'recall',
    description: 'Search remembered facts for ones relevant to a query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  spoken: 'Let me recall that',
  async run(args) {
    const query = String(args.query ?? '');
    const limit = args.limit ? Number(args.limit) : 5;
    const hits = await memory.recall(query, limit);
    return { ok: true, content: hits.length ? hits.join('\n') : 'Nothing remembered about that.' };
  },
};

export const forget: Tool = {
  spec: {
    name: 'forget',
    description: 'Delete remembered facts matching a query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  flags: { confirm: true },
  spoken: 'Forgetting that',
  async run(args) {
    const query = String(args.query ?? '');
    const n = await memory.forget(query);
    return { ok: true, content: `Forgot ${n} fact${n === 1 ? '' : 's'}.` };
  },
};
