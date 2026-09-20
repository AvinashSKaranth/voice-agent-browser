import type { Tool } from '../../core/types';

const clipboard: Tool = {
  spec: {
    name: 'clipboard',
    description: 'Read the current clipboard text, or write text to the clipboard.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'] },
        text: { type: 'string', description: 'Text to write (required when action is "write")' },
      },
      required: ['action'],
    },
  },
  spoken: 'Checking the clipboard',
  async run(args, ctx) {
    const action = String(args.action ?? 'read');
    try {
      if (action === 'read') {
        const text = await navigator.clipboard.readText();
        return { ok: true, content: text };
      }
      if (action === 'write') {
        const text = String(args.text ?? '');
        const ok = await ctx.confirm(`Write "${text.slice(0, 80)}" to the clipboard?`);
        if (!ok) return { ok: false, content: '', error: 'Cancelled by user' };
        await navigator.clipboard.writeText(text);
        return { ok: true, content: 'Copied to clipboard' };
      }
      return { ok: false, content: '', error: `Unknown action: ${action}` };
    } catch (e) {
      return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export default clipboard;
