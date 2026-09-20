// Scheduled jobs: sqlite table + a 15s poll loop that fires due one-off or repeating tool calls.
import { db } from '../storage/db';
import { makeToolContext } from '../core/orchestrator';
import { tools } from './registry';
import { bus } from '../core/bus';

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT,
  at TEXT,
  every_sec INTEGER,
  action TEXT,
  last_run TEXT,
  enabled INTEGER
)`;

interface ScheduleRow {
  id: string;
  name: string;
  at: string | null;
  every_sec: number | null;
  action: string;
  last_run: string | null;
  enabled: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!tableReady) tableReady = db.exec(TABLE_SQL);
  return tableReady;
}

/** Resolves "at" to an absolute ISO datetime. Accepts ISO strings, "in N minutes/hours/seconds", and "at H[:MM][am|pm]". */
function resolveAt(at: string): string {
  const trimmed = at.trim();

  const inMatch = /^in\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)$/i.exec(trimmed);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const ms = unit.startsWith('hour') ? n * 3600000 : unit.startsWith('minute') ? n * 60000 : n * 1000;
    return new Date(Date.now() + ms).toISOString();
  }

  const atMatch = /^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(trimmed);
  if (atMatch) {
    let h = Number(atMatch[1]);
    const m = atMatch[2] ? Number(atMatch[2]) : 0;
    const ap = atMatch[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.toISOString();
  }

  const iso = Date.parse(trimmed);
  if (!Number.isNaN(iso)) return new Date(iso).toISOString();

  throw new Error(`Cannot parse schedule time: "${at}"`);
}

async function fireJob(row: ScheduleRow): Promise<void> {
  try {
    const action = JSON.parse(row.action) as { tool: string; args: Record<string, unknown> };
    const tool = tools.get(action.tool);
    if (tool?.flags?.confirm) {
      // defence in depth: scheduler.add() already rejects confirm-gated tools, but jobs created
      // before that check existed (or via a stale row) should still not run without confirmation.
      bus.emit({ type: 'toast', level: 'warn', text: `Scheduled job "${row.name}" skipped: "${action.tool}" needs confirmation.` });
    } else if (tool) {
      const controller = new AbortController();
      await tool.run(action.args ?? {}, makeToolContext(controller.signal));
    } else {
      console.warn('schedule: unknown tool', action.tool);
    }
  } catch (e) {
    console.error('schedule job failed', row.id, e);
  } finally {
    const now = new Date().toISOString();
    if (row.every_sec) {
      await db.exec('UPDATE schedules SET last_run = ? WHERE id = ?', [now, row.id]);
    } else {
      await db.exec('UPDATE schedules SET enabled = 0, last_run = ? WHERE id = ?', [now, row.id]);
    }
  }
}

async function runDue(): Promise<void> {
  await ensureTable();
  const rows = await db.query<ScheduleRow>('SELECT * FROM schedules WHERE enabled = 1');
  const now = Date.now();
  for (const row of rows) {
    let due = false;
    if (row.every_sec) {
      const last = row.last_run ? Date.parse(row.last_run) : 0;
      due = now - last >= row.every_sec * 1000;
    } else if (row.at) {
      due = now >= Date.parse(row.at);
    }
    if (due) await fireJob(row);
  }
}

let ticking = false;

export const scheduler = {
  start(): void {
    if (timer) return;
    ensureTable().catch((e) => console.error('schedule table', e));
    timer = setInterval(() => {
      if (ticking) return; // guard against overlapping ticks if runDue() outlasts 15s
      ticking = true;
      runDue()
        .catch((e) => console.error('schedule poll', e))
        .finally(() => {
          ticking = false;
        });
    }, 15000);
  },

  async add(job: { name: string; at?: string; everySec?: number; action: { tool: string; args: Record<string, unknown> } }): Promise<string> {
    await ensureTable();
    if (tools.get(job.action.tool)?.flags?.confirm) {
      throw new Error('This tool needs confirmation and cannot be scheduled');
    }
    const id = crypto.randomUUID();
    const at = job.at ? resolveAt(job.at) : null;
    // ponytail: a repeating job's first fire is one interval after creation (last_run seeded to now), not immediately.
    const lastRun = job.everySec ? new Date().toISOString() : null;
    await db.exec('INSERT INTO schedules (id, name, at, every_sec, action, last_run, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)', [
      id,
      job.name,
      at,
      job.everySec ?? null,
      JSON.stringify(job.action),
      lastRun,
    ]);
    return id;
  },

  async list(): Promise<ScheduleRow[]> {
    await ensureTable();
    return db.query<ScheduleRow>('SELECT * FROM schedules WHERE enabled = 1');
  },

  async cancel(id: string): Promise<void> {
    await ensureTable();
    await db.exec('UPDATE schedules SET enabled = 0 WHERE id = ?', [id]);
  },
};
