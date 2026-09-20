// remember/recall/forget facts, backed by the `memories` table.
import { db } from './db';

function scoreText(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  return words.reduce((n, w) => n + (lower.includes(w.toLowerCase()) ? 1 : 0), 0);
}

export const memory = {
  async remember(text: string, tags: string[] = []): Promise<void> {
    await db.exec('INSERT INTO memories (text, tags, created_at) VALUES (?, ?, ?)', [text, tags.join(','), new Date().toISOString()]);
  },

  async recall(q: string, limit = 5): Promise<string[]> {
    const words = q
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 4);
    if (!words.length) return [];
    const clause = words.map(() => 'text LIKE ?').join(' OR ');
    const params = words.map((w) => `%${w}%`);
    const rows = await db.query<{ id: number; text: string; created_at: string }>(
      `SELECT id, text, created_at FROM memories WHERE ${clause}`,
      params
    );
    return rows
      .map((r) => ({ ...r, score: scoreText(r.text, words) }))
      .sort((a, b) => b.score - a.score || (b.created_at > a.created_at ? 1 : -1))
      .slice(0, limit)
      .map((r) => r.text);
  },

  async forget(q: string): Promise<number> {
    const rows = await db.query<{ id: number }>('SELECT id FROM memories WHERE text LIKE ?', [`%${q}%`]);
    if (!rows.length) return 0;
    await db.exec(`DELETE FROM memories WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id));
    return rows.length;
  },

  async all(): Promise<Array<{ id: number; text: string; createdAt: string }>> {
    const rows = await db.query<{ id: number; text: string; created_at: string }>(
      'SELECT id, text, created_at FROM memories ORDER BY created_at DESC'
    );
    return rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at }));
  },
};

if (import.meta.env.DEV) {
  const fake = [
    { text: 'the user likes dark roast coffee in the morning', created_at: '2024-01-01' },
    { text: 'user prefers tea over coffee at night', created_at: '2024-01-02' },
    { text: 'unrelated fact about cars', created_at: '2024-01-03' },
  ];
  const words = ['coffee', 'morning'];
  const scores = fake.map((r) => scoreText(r.text, words));
  console.assert(scores[0] === 2, 'memory: expected 2 matches for row 0', scores);
  console.assert(scores[1] === 1, 'memory: expected 1 match for row 1 (coffee only)', scores);
  console.assert(scores[2] === 0, 'memory: expected 0 matches for row 2', scores);
}
