import type { Tool } from '../../core/types';
import { transcripts } from '../../storage/transcripts';
import { orchestrator, resumeSession } from '../../core/orchestrator';

export const session_new: Tool = {
  spec: {
    name: 'session_new',
    description: 'Start a brand new conversation session, clearing the active context.',
    parameters: { type: 'object', properties: {} },
  },
  spoken: 'Starting a new conversation',
  async run() {
    const id = await orchestrator.newSession();
    return { ok: true, content: `Started new session ${id}` };
  },
};

export const session_resume: Tool = {
  spec: {
    name: 'session_resume',
    description: 'Switch the active conversation to a previous session by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  spoken: 'Switching conversations',
  async run(args) {
    const id = String(args.id ?? '');
    const sessions = await transcripts.sessions();
    if (!sessions.some((s) => s.id === id)) return { ok: false, content: '', error: `No session with id ${id}` };
    resumeSession(id);
    return { ok: true, content: `Resumed session ${id}` };
  },
};

export const transcript_export: Tool = {
  spec: {
    name: 'transcript_export',
    description: 'Export the current (or a given) conversation as Markdown.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Session id; defaults to the current session' } } },
  },
  spoken: 'Exporting the transcript',
  async run(args) {
    const id = args.id ? String(args.id) : orchestrator.sessionId();
    if (!id) return { ok: false, content: '', error: 'No active session' };
    return { ok: true, content: await transcripts.exportMarkdown(id) };
  },
};
