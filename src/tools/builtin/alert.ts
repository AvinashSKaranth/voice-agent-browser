import type { Tool } from '../../core/types';

const alert: Tool = {
  spec: {
    name: 'alert',
    description: 'Speak a message right now and show a system notification. Used directly or as a schedule action.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' }, title: { type: 'string' } },
      required: ['message'],
    },
  },
  spoken: 'Here is an alert',
  async run(args, ctx) {
    const message = String(args.message ?? '');
    const title = args.title ? String(args.title) : 'Alert';
    ctx.speak(message);
    ctx.notify(title, message);
    return { ok: true, content: message };
  },
};

export default alert;
