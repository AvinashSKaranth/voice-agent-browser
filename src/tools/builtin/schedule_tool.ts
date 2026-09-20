import type { Tool } from '../../core/types';
import { scheduler } from '../schedule';

const schedule_tool: Tool = {
  spec: {
    name: 'schedule',
    description:
      'Create, list, or cancel a scheduled job. A job fires a tool (usually "alert") once at a time ("at": ISO datetime, "in 10 minutes", "at 5pm") or repeatedly ("everySec").',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'cancel'] },
        name: { type: 'string' },
        at: { type: 'string', description: 'ISO datetime, "in N minutes/hours", or "at Hpm"' },
        everySec: { type: 'number' },
        tool: { type: 'string', description: 'Tool to run when the job fires, e.g. "alert"' },
        toolArgs: { type: 'object', properties: {} },
        id: { type: 'string', description: 'Job id (for "cancel")' },
      },
      required: ['action'],
    },
  },
  spoken: 'Scheduling that',
  async run(args) {
    const action = String(args.action ?? 'list');
    if (action === 'add') {
      const name = String(args.name ?? 'job');
      const tool = String(args.tool ?? 'alert');
      const toolArgs = (args.toolArgs as Record<string, unknown>) ?? {};
      try {
        const id = await scheduler.add({
          name,
          at: args.at ? String(args.at) : undefined,
          everySec: args.everySec ? Number(args.everySec) : undefined,
          action: { tool, args: toolArgs },
        });
        return { ok: true, content: `Scheduled "${name}" (${id})` };
      } catch (e) {
        return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (action === 'list') {
      const jobs = await scheduler.list();
      if (!jobs.length) return { ok: true, content: 'No scheduled jobs.' };
      return { ok: true, content: jobs.map((j) => `${j.id}: ${j.name} (${j.at ?? `every ${j.every_sec}s`})`).join('\n') };
    }
    if (action === 'cancel') {
      await scheduler.cancel(String(args.id ?? ''));
      return { ok: true, content: `Cancelled job ${args.id}` };
    }
    return { ok: false, content: '', error: `Unknown action: ${action}` };
  },
};

export default schedule_tool;
