// Document store: anydoc-wasm converts office/PDF formats to Markdown; the
// result is kept in the `documents` table (+ FTS5 index when available).
import init, { toMarkdownBytes, formatFromExtension } from '@firecrawl/anydoc-wasm';
import wasmUrl from '@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm?url';
import { db } from '../storage/db';

let initPromise: Promise<unknown> | null = null;
function ensureInit(): Promise<unknown> {
  if (!initPromise) initPromise = init({ module_or_path: wasmUrl });
  return initPromise;
}

const PLAIN_TEXT_EXT = new Set(['md', 'txt', 'json', 'csv']);

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

async function toMarkdown(file: File): Promise<string> {
  const ext = extOf(file.name);
  if (PLAIN_TEXT_EXT.has(ext)) return file.text();

  await ensureInit();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return toMarkdownBytes(bytes, formatFromExtension(ext) ?? null);
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: string }).code === 'needsOcr') {
      throw new Error('This PDF is scanned; OCR is not available offline');
    }
    throw e;
  }
}

async function hasFts(): Promise<boolean> {
  const rows = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'");
  return rows.length > 0;
}

export const documents = {
  async add(file: File): Promise<{ id: string; name: string; chars: number }> {
    const markdown = await toMarkdown(file);
    const id = crypto.randomUUID();
    const addedAt = new Date().toISOString();
    await db.exec('INSERT INTO documents (id, name, markdown, chars, added_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      file.name,
      markdown,
      markdown.length,
      addedAt,
    ]);
    if (await hasFts()) {
      const row = (await db.query<{ rowid: number }>('SELECT rowid FROM documents WHERE id = ?', [id]))[0];
      if (row) await db.exec('INSERT INTO documents_fts (rowid, name, markdown) VALUES (?, ?, ?)', [row.rowid, file.name, markdown]);
    }
    return { id, name: file.name, chars: markdown.length };
  },

  async list(): Promise<Array<{ id: string; name: string; chars: number; addedAt: string }>> {
    const rows = await db.query<{ id: string; name: string; chars: number; added_at: string }>(
      'SELECT id, name, chars, added_at FROM documents ORDER BY added_at DESC'
    );
    return rows.map((r) => ({ id: r.id, name: r.name, chars: r.chars, addedAt: r.added_at }));
  },

  async get(idOrName: string): Promise<string> {
    const rows = await db.query<{ markdown: string }>('SELECT markdown FROM documents WHERE id = ? OR name = ? COLLATE NOCASE', [
      idOrName,
      idOrName,
    ]);
    if (!rows[0]) throw new Error(`Document "${idOrName}" not found`);
    return rows[0].markdown;
  },

  async search(q: string): Promise<Array<{ id: string; name: string; snippet: string }>> {
    if (await hasFts()) {
      try {
        const rows = await db.query<{ id: string; name: string; snippet: string }>(
          `SELECT d.id as id, d.name as name, snippet(documents_fts, 1, '[', ']', '...', 10) as snippet
           FROM documents_fts f JOIN documents d ON d.rowid = f.rowid
           WHERE documents_fts MATCH ? ORDER BY rank`,
          [q]
        );
        return rows;
      } catch {
        // fall through to LIKE
      }
    }
    const rows = await db.query<{ id: string; name: string; markdown: string }>(
      'SELECT id, name, markdown FROM documents WHERE markdown LIKE ? OR name LIKE ?',
      [`%${q}%`, `%${q}%`]
    );
    return rows.map((r) => {
      const idx = r.markdown.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 40);
      const snippet = idx === -1 ? r.markdown.slice(0, 80) : r.markdown.slice(start, idx + q.length + 40);
      return { id: r.id, name: r.name, snippet };
    });
  },

  async remove(id: string): Promise<void> {
    const row = (await db.query<{ rowid: number }>('SELECT rowid FROM documents WHERE id = ?', [id]))[0];
    await db.exec('DELETE FROM documents WHERE id = ?', [id]);
    if (row && (await hasFts())) await db.exec('DELETE FROM documents_fts WHERE rowid = ?', [row.rowid]);
  },
};
