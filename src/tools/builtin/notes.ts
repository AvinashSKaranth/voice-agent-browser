import type { Tool } from '../../core/types';

const TABLE_SQL = 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, done INTEGER DEFAULT 0, created_at TEXT)';

const notes: Tool = {
  spec: {
    name: 'notes',
    description: 'Add a note or to-do item, list them, or mark one complete.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'complete'] },
        text: { type: 'string', description: 'Note text (for "add")' },
        id: { type: 'number', description: 'Note id (for "complete")' },
      },
      required: ['action'],
    },
  },
  spoken: 'On it',
  async run(args, ctx) {
    await ctx.db.exec(TABLE_SQL);
    const action = String(args.action ?? 'list');

    if (action === 'add') {
      const text = String(args.text ?? '');
      await ctx.db.exec('INSERT INTO notes (text, done, created_at) VALUES (?, 0, ?)', [text, new Date().toISOString()]);
      return { ok: true, content: `Added: ${text}` };
    }
    if (action === 'list') {
      const rows = await ctx.db.query('SELECT id, text, done FROM notes ORDER BY id DESC');
      if (!rows.length) return { ok: true, content: 'No notes.' };
      return { ok: true, content: rows.map((r) => `${r.done ? '[x]' : '[ ]'} ${r.id}: ${r.text}`).join('\n') };
    }
    if (action === 'complete') {
      const id = Number(args.id);
      await ctx.db.exec('UPDATE notes SET done = 1 WHERE id = ?', [id]);
      return { ok: true, content: `Marked note ${id} complete` };
    }
    return { ok: false, content: '', error: `Unknown action: ${action}` };
  },
};

export default notes;
