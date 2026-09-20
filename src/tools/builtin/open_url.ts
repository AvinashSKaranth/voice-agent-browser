import type { Tool } from '../../core/types';

const open_url: Tool = {
  spec: {
    name: 'open_url',
    description: 'Open a URL in a new browser tab.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  flags: { confirm: true },
  spoken: 'Opening that',
  async run(args) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) return { ok: false, content: '', error: `Not a valid URL: ${url}` };
    window.open(url, '_blank', 'noopener');
    return { ok: true, content: `Opened ${url}` };
  },
};

export default open_url;
