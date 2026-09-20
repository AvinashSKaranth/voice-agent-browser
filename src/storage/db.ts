// Wraps sqlite.worker.ts as a promise-based DbApi and runs migrations once.
import type { DbApi, SqlValue } from '../core/types';
import { bus } from '../core/bus';

type Pending = { resolve(rows: unknown[]): void; reject(err: Error): void };

let worker: Worker | null = null;
const pending = new Map<string, Pending>();
let nextId = 0;
let readyResolve!: () => void;
const readyPromise = new Promise<void>((r) => (readyResolve = r));
let migratedResolve!: () => void;
// Public db calls wait for migrations, not just the worker; migrations themselves use rawExec.
const migratedPromise = new Promise<void>((r) => (migratedResolve = r));
let initStarted = false;

function send(sql: string, params: SqlValue[] | undefined, mode: 'exec' | 'query'): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, sql, params, mode });
  });
}

async function rawExec(sql: string): Promise<void> {
  await readyPromise;
  await send(sql, undefined, 'exec');
}

export const db: DbApi = {
  async exec(sql, params) {
    await migratedPromise;
    await send(sql, params, 'exec');
  },
  async query<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]) {
    await migratedPromise;
    return (await send(sql, params, 'query')) as T[];
  },
};

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, text TEXT, tags TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, name TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, markdown TEXT, chars INTEGER, added_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, ts INTEGER, turn_id TEXT, name TEXT, ms REAL, value REAL, detail TEXT)`,
];

export async function initDb(): Promise<void> {
  if (initStarted) return migratedPromise;
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
  for (const sql of MIGRATIONS) await rawExec(sql);
  try {
    await rawExec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(name, markdown, content='documents', content_rowid='rowid')`);
  } catch (e) {
    console.warn('fts5 unavailable, falling back to LIKE search', e);
  }
  migratedResolve();

  try {
    await navigator.storage.persist();
  } catch {
    // best-effort; not all browsers support it
  }
}
