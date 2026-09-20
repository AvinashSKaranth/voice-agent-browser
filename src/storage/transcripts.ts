// Sessions + messages, backed by the `sessions` and `messages` tables.
import { db } from './db';
import type { ChatMessage, ContentPart } from '../core/types';

function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(' ');
}

export const transcripts = {
  async newSession(title = ''): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.exec('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, title, now, now]);
    return id;
  },

  async append(sessionId: string, m: ChatMessage): Promise<void> {
    const now = new Date().toISOString();
    await db.exec(
      'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sessionId, m.role, JSON.stringify(m.content), m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.toolCallId ?? null, m.name ?? null, now]
    );
    await db.exec('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);

    if (m.role === 'user') {
      const rows = await db.query<{ title: string }>('SELECT title FROM sessions WHERE id = ?', [sessionId]);
      if (rows[0] && !rows[0].title) {
        const title = textOf(m.content).slice(0, 60);
        if (title) await db.exec('UPDATE sessions SET title = ? WHERE id = ?', [title, sessionId]);
      }
    }
  },

  async load(sessionId: string): Promise<ChatMessage[]> {
    const rows = await db.query<{
      role: ChatMessage['role'];
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
      name: string | null;
    }>('SELECT role, content, tool_calls, tool_call_id, name FROM messages WHERE session_id = ? ORDER BY id ASC', [sessionId]);
    return rows.map((r) => ({
      role: r.role,
      content: JSON.parse(r.content),
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
      toolCallId: r.tool_call_id ?? undefined,
      name: r.name ?? undefined,
    }));
  },

  async sessions(): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
    const rows = await db.query<{ id: string; title: string; updated_at: string }>(
      'SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC'
    );
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
  },

  async exportMarkdown(sessionId: string): Promise<string> {
    const messages = await this.load(sessionId);
    return messages
      .map((m) => {
        let block = `## ${m.role}\n\n${textOf(m.content)}`;
        if (m.toolCalls?.length) block += `\n\n\`\`\`json\n${JSON.stringify(m.toolCalls, null, 2)}\n\`\`\``;
        return block;
      })
      .join('\n\n');
  },
};
