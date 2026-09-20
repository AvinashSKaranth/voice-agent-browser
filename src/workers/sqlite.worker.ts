// Dedicated worker: owns the sqlite-wasm connection. Runs the opfs-sahpool VFS
// (works without COOP/COEP, but only inside a dedicated worker); falls back to
// an in-memory db if the pool cannot be installed (e.g. private browsing).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type InMsg = { id: string; sql: string; params?: unknown[]; mode: 'exec' | 'query' };
type OutMsg = { id: string; rows?: unknown[] } | { id: string; error: string } | { type: 'ready'; persistent: boolean; reason?: string };

let db: any;

// The published types declare sqlite3InitModule() with no params, but the
// runtime accepts an options object (print/printErr hooks) — cast around the
// type/runtime mismatch rather than losing the diagnostics hooks.
type InitModuleFn = (opts: { print: typeof console.log; printErr: typeof console.error }) => Promise<any>;

async function boot() {
  const sqlite3 = await (sqlite3InitModule as unknown as InitModuleFn)({ print: console.log, printErr: console.error });
  let persistent = true;
  let reason = '';
  // The SAH pool is exclusive: a second tab of the app cannot open it until the first closes.
  // Retry a few times (the other tab may be closing) before falling back to memory.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'va-pool', directory: '.va-sqlite' });
      db = new pool.OpfsSAHPoolDb('/va.sqlite3');
      reason = '';
      break;
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
      console.error('opfs-sahpool attempt failed', attempt + 1, reason);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!db) {
    db = new sqlite3.oo1.DB(':memory:');
    persistent = false;
  }
  (self as unknown as { postMessage(m: OutMsg): void }).postMessage({ type: 'ready', persistent, reason });
}

const ready = boot();

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  await ready;
  const { id, sql, params, mode } = ev.data;
  try {
    if (mode === 'query') {
      const rows = db.exec({ sql, bind: params ?? [], rowMode: 'object', returnValue: 'resultRows' });
      (self as unknown as { postMessage(m: OutMsg): void }).postMessage({ id, rows });
    } else {
      db.exec({ sql, bind: params ?? [] });
      (self as unknown as { postMessage(m: OutMsg): void }).postMessage({ id, rows: [] });
    }
  } catch (e) {
    (self as unknown as { postMessage(m: OutMsg): void }).postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
