import { useEffect, useMemo, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { metrics } from '../core/metrics';
import type { LogRow } from '../core/types';
import { Button, Card } from './components';

function fmt(n: number | null): string {
  if (n === null) return '—';
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

export function Logs() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    metrics.recent().then(setRows).catch(() => {});
    return bus.on('log:entry', (e) => {
      setRows((prev) => [e.row, ...prev].slice(0, 2000));
    });
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (r.detail ?? '').toLowerCase().includes(q) || (r.turnId ?? '').toLowerCase().includes(q));
  }, [rows, filter]);

  const summary = useMemo(() => {
    const byName = new Map<string, number[]>();
    for (const r of rows) {
      const v = r.ms ?? r.value;
      if (v === null) continue;
      (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push(v);
    }
    return Array.from(byName.entries())
      .map(([name, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          name,
          count: values.length,
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          p50: percentile(sorted, 0.5),
          max: sorted[sorted.length - 1],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  async function clear() {
    await metrics.clear();
    setRows([]);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <h1>Logs</h1>
        <div class="row">
          <Button variant="ghost" onClick={exportJson}>
            Export JSON
          </Button>
          <Button variant="danger" onClick={clear}>
            Clear
          </Button>
        </div>
      </div>

      <Card>
        <h2>Summary (last hour)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Count</th>
              <th>Avg</th>
              <th>p50</th>
              <th>Max</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>{s.count}</td>
                <td>{fmt(s.avg)}</td>
                <td>{fmt(s.p50)}</td>
                <td>{fmt(s.max)}</td>
              </tr>
            ))}
            {summary.length === 0 && (
              <tr>
                <td colSpan={5}>No metrics recorded in the last hour yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card>
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <h2>Entries ({filtered.length})</h2>
          <input class="input" placeholder="Filter by name, detail, turn…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Turn</th>
              <th>Name</th>
              <th>ms/value</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.ts).toLocaleTimeString()}</td>
                <td>{r.turnId ? r.turnId.slice(0, 8) : '—'}</td>
                <td>{r.name}</td>
                <td>{fmt(r.ms ?? r.value)}</td>
                <td title={r.detail ?? ''}>{(r.detail ?? '').slice(0, 80)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5}>No entries.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
