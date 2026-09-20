// Wraps sqlite.worker.ts as a promise-based DbApi and runs migrations once.
import type { DbApi, SqlValue } from '../core/types';
import { bus } from '../core/bus';

type Pending = { resolve(rows: unknown[]): void; reject(err: Error): void };

let worker: Worker | null = null;
const pending = new Map<string, Pending>();
let nextId = 0;
let readyResolve!: () => void;
const readyPromise = new Promise<void>((r) => (readyResolve = r));
let initStarted = false;

function send(sql: string, params: SqlValue[] | undefined, mode: 'exec' | 'query'): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, sql, params, mode });
  });
}

export const db: DbApi = {
  async exec(sql, params) {
    await readyPromise;
    await send(sql, params, 'exec');
  },
  async query<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]) {
    await readyPromise;
    return (await send(sql, params, 'query')) as T[];
  },
};

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, text TEXT, tags TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, name TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, markdown TEXT, chars INTEGER, added_at TEXT)`,
];

export async function initDb(): Promise<void> {
  if (initStarted) return readyPromise;
  initStarted = true;
  worker = new Worker(new URL('../workers/sqlite.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<any>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      if (!msg.persistent) bus.emit({ type: 'toast', level: 'warn', text: 'Storage is not persistent in this browser' });
      readyResolve();
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.rows ?? []);
  };

  await readyPromise;
  for (const sql of MIGRATIONS) await db.exec(sql);
  try {
    await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(name, markdown, content='documents', content_rowid='rowid')`);
  } catch (e) {
    console.warn('fts5 unavailable, falling back to LIKE search', e);
  }

  try {
    await navigator.storage.persist();
  } catch {
    // best-effort; not all browsers support it
  }
}
