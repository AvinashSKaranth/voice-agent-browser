// Aggregates a worker's per-file progress events (transformers.js / kokoro-js style) into ONE
// bus 'model:progress' event with combined loaded/total, so a multi-file download doesn't have
// each file's message overwrite the previous file's in the single UI progress bar.
import { bus } from '../core/bus';
import type { ModelName, WorkerProgress } from '../core/types';

export function createProgressAggregator(model: ModelName): (msg: WorkerProgress) => void {
  const files = new Map<string, { loaded: number; total: number }>();

  return (msg: WorkerProgress): void => {
    if (msg.status !== 'downloading') {
      bus.emit({ type: 'model:progress', model, loaded: msg.loaded, total: msg.total, status: msg.status, error: msg.error });
      return;
    }
    const key = msg.file ?? '';
    const prev = files.get(key);
    // A 'done' file (loaded === its total) has a real total; keep it if a later message for the
    // same file lacks one instead of dropping back to 0.
    const total = msg.total || prev?.total || 0;
    files.set(key, { loaded: msg.loaded, total });
    let loaded = 0;
    let totalSum = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      totalSum += f.total;
    }
    bus.emit({ type: 'model:progress', model, loaded, total: totalSum, status: 'downloading' });
  };
}
