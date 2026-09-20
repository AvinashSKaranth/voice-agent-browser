import type { Tool, ToolResult } from '../../core/types';

const TIMEOUT_MS = 10000;

// Runs `code` as the body of an async function inside a fresh Worker, sandboxed from the page.
const WORKER_SRC = `
self.onmessage = async (e) => {
  try {
    const fn = new Function('return (async () => {\\n' + e.data + '\\n})()');
    const result = await fn();
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
`;

const run_js: Tool = {
  spec: {
    name: 'run_js',
    description: 'Execute a short JavaScript snippet in a sandboxed worker (10s timeout) and return its JSON result. Use "return <value>" to produce output.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  flags: { confirm: true },
  spoken: 'Running that',
  run(args) {
    const code = String(args.code ?? '');
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
      const worker = new Worker(url);
      let settled = false;
      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, content: '', error: 'run_js timed out' }), TIMEOUT_MS);
      worker.onmessage = (e) => {
        const data = e.data;
        finish(data.ok ? { ok: true, content: JSON.stringify(data.result ?? null).slice(0, 8000) } : { ok: false, content: '', error: data.error });
      };
      worker.onerror = (e) => finish({ ok: false, content: '', error: e.message });
      worker.postMessage(code);
    });
  },
};

export default run_js;
