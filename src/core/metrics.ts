// Timing/counter instrumentation. In-memory ring for cheap access, sqlite for the Logs page's
// "last hour" view across reloads. Never throws: a metrics write must not break the caller.
import { bus } from './bus';
import { db } from '../storage/db';
import type { LogRow } from './types';

const RING_MAX = 2000;
const RETENTION_MS = 60 * 60 * 1000;
const ring: LogRow[] = [];
let nextId = 1;

function record(name: string, ms: number | null, value: number | null, detail: string | null, turnId: string | null): void {
  const row: LogRow = { id: nextId++, ts: Date.now(), turnId, name, ms, value, detail };
  ring.push(row);
  if (ring.length > RING_MAX) ring.shift();
  bus.emit({ type: 'log:entry', row });
  db.exec('INSERT INTO logs (ts, turn_id, name, ms, value, detail) VALUES (?, ?, ?, ?, ?, ?)', [row.ts, turnId, name, ms, value, detail])
    .then(() => db.exec('DELETE FROM logs WHERE ts < ?', [Date.now() - RETENTION_MS]))
    .catch(() => {});
}

export const metrics = {
  /** Starts a span; call the returned function when it ends (optionally with a detail string). */
  start(name: string, turnId?: string): (detail?: string) => void {
    const t0 = performance.now();
    return (detail?: string) => record(name, performance.now() - t0, null, detail ?? null, turnId ?? null);
  },
  /** Records a one-off counter/value (no duration). */
  event(name: string, value?: number, detail?: string, turnId?: string): void {
    record(name, null, value ?? null, detail ?? null, turnId ?? null);
  },
  /** Last hour of rows from sqlite, newest first. */
  async recent(): Promise<LogRow[]> {
    const rows = await db.query<{ id: number; ts: number; turn_id: string | null; name: string; ms: number | null; value: number | null; detail: string | null }>(
      'SELECT id, ts, turn_id, name, ms, value, detail FROM logs WHERE ts > ? ORDER BY ts DESC',
      [Date.now() - RETENTION_MS]
    );
    return rows.map((r) => ({ id: r.id, ts: r.ts, turnId: r.turn_id, name: r.name, ms: r.ms, value: r.value, detail: r.detail }));
  },
  async clear(): Promise<void> {
    ring.length = 0;
    await db.exec('DELETE FROM logs');
  },
};
