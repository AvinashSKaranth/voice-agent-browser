import type { Tool } from '../../core/types';

const datetime: Tool = {
  spec: {
    name: 'datetime',
    description: 'Get the current date/time (optionally in a timezone), convert a datetime to another timezone, or add/subtract days from a date.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['now', 'convert', 'add', 'subtract'], description: 'Which operation to perform' },
        date: { type: 'string', description: 'ISO datetime to convert or offset; defaults to now' },
        timezone: { type: 'string', description: 'IANA timezone, e.g. "America/New_York"' },
        days: { type: 'number', description: 'Number of days to add or subtract' },
      },
      required: ['action'],
    },
  },
  spoken: "Let me check that",
  async run(args) {
    const action = String(args.action ?? 'now');
    const timezone = args.timezone ? String(args.timezone) : undefined;
    const base = args.date ? new Date(String(args.date)) : new Date();
    if (Number.isNaN(base.getTime())) return { ok: false, content: '', error: `Invalid date: ${args.date}` };

    try {
      if (action === 'now' || action === 'convert') {
        const formatted = timezone
          ? new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone }).format(base)
          : base.toString();
        return { ok: true, content: formatted };
      }
      if (action === 'add' || action === 'subtract') {
        const days = Number(args.days ?? 0) * (action === 'subtract' ? -1 : 1);
        const result = new Date(base.getTime() + days * 86400000);
        return { ok: true, content: result.toISOString() };
      }
      return { ok: false, content: '', error: `Unknown action: ${action}` };
    } catch (e) {
      return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export default datetime;
