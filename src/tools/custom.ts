// User-authored tools: OPFS folder /tools/<name>/{tool.json, handler.js}. Each handler runs in a
// sandboxed Worker (module worker, dynamic `import()` of a Blob URL) with a small `api` shim that
// round-trips storage/notify/speak/schedule/fetch calls back to the main thread.
import type { Tool, ToolFlags, ToolResult, JsonSchema } from '../core/types';
import { opfs } from '../storage/opfs';
import { tools } from './registry';
import { scheduler } from './schedule';

interface ToolJson {
  name: string;
  description: string;
  parameters: JsonSchema;
  flags?: ToolFlags;
  spoken?: string;
}

const RUN_TIMEOUT_MS = 30000;

function ctoolStoreKey(name: string): string {
  return `va.ctool.${name}`;
}
function readStore(name: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(ctoolStoreKey(name)) || '{}');
  } catch {
    return {};
  }
}
function writeStore(name: string, store: Record<string, unknown>): void {
  try {
    localStorage.setItem(ctoolStoreKey(name), JSON.stringify(store));
  } catch (e) {
    console.warn('custom tool storage save failed', name, e);
  }
}

const WRAPPER_SRC = `
let handlerRun;
const pending = new Map();
let reqId = 0;
function callMain(api, payload) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    self.postMessage({ kind: 'api', id, api, payload });
  });
}
self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.kind === 'api-result') {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) {
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.value);
    }
    return;
  }
  if (msg.kind === 'run') {
    try {
      const blob = new Blob([msg.handlerSrc], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const mod = await import(/* @vite-ignore */ url);
      URL.revokeObjectURL(url);
      handlerRun = mod.run;
      const api = {
        storage: {
          get: (key) => callMain('storage.get', key),
          set: (key, value) => callMain('storage.set', { key, value }),
        },
        notify: (title, body) => callMain('notify', { title, body }),
        speak: (text) => callMain('speak', text),
        schedule: (job) => callMain('schedule', job),
      };
      if (msg.remote) api.fetch = (url2, init) => callMain('fetch', { url: url2, init });
      const result = await handlerRun(msg.args, api);
      self.postMessage({ kind: 'done', result });
    } catch (err) {
      self.postMessage({ kind: 'error', error: String((err && err.message) || err) });
    }
  }
};
`;

async function handleApi(name: string, api: string, payload: unknown, ctx: { notify(t: string, b?: string): void; speak(t: string): void }): Promise<unknown> {
  switch (api) {
    case 'storage.get': {
      const { key } = payload as { key: string };
      return readStore(name)[key];
    }
    case 'storage.set': {
      const { key, value } = payload as { key: string; value: unknown };
      const store = readStore(name);
      store[key] = value;
      writeStore(name, store);
      return true;
    }
    case 'notify': {
      const { title, body } = payload as { title: string; body?: string };
      ctx.notify(title, body);
      return true;
    }
    case 'speak':
      ctx.speak(String(payload));
      return true;
    case 'schedule':
      return scheduler.add(payload as Parameters<typeof scheduler.add>[0]);
    case 'fetch': {
      const { url, init } = payload as { url: string; init?: RequestInit };
      const res = await fetch(url, init);
      const body = await res.text();
      return { status: res.status, ok: res.ok, body: body.slice(0, 8000) };
    }
    default:
      return null;
  }
}

function runHandler(name: string, handlerSrc: string, flags: ToolFlags, args: Record<string, unknown>, ctx: { notify(t: string, b?: string): void; speak(t: string): void }): Promise<ToolResult> {
  return new Promise((resolve) => {
    const wrapperUrl = URL.createObjectURL(new Blob([WRAPPER_SRC], { type: 'application/javascript' }));
    const worker = new Worker(wrapperUrl, { type: 'module' });
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(wrapperUrl);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, content: '', error: `Custom tool ${name} timed out` }), RUN_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.kind === 'api') {
        handleApi(name, msg.api, msg.payload, ctx)
          .then((value) => worker.postMessage({ kind: 'api-result', id: msg.id, value }))
          .catch((err) => worker.postMessage({ kind: 'api-result', id: msg.id, error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      if (msg.kind === 'done') {
        finish({ ok: true, content: JSON.stringify(msg.result ?? null).slice(0, 8000) });
      } else if (msg.kind === 'error') {
        finish({ ok: false, content: '', error: msg.error });
      }
    };
    worker.onerror = (e) => finish({ ok: false, content: '', error: e.message });
    worker.postMessage({ kind: 'run', handlerSrc, args, remote: !!flags.remote });
  });
}

async function registerFromFolder(name: string): Promise<void> {
  const jsonText = await opfs.readText(`/tools/${name}/tool.json`);
  const handlerSrc = await opfs.readText(`/tools/${name}/handler.js`);
  if (!jsonText || !handlerSrc) return;
  const spec: ToolJson = JSON.parse(jsonText);
  const flags: ToolFlags = { ...spec.flags, custom: true };
  const tool: Tool = {
    spec: { name: spec.name, description: spec.description, parameters: spec.parameters },
    flags,
    spoken: spec.spoken,
    run: (args, ctx) => runHandler(spec.name, handlerSrc, flags, args, ctx),
  };
  tools.register(tool);
}

const WORD_COUNT_TOOL_JSON = JSON.stringify(
  {
    name: 'word_count',
    description: 'Count the number of words in a piece of text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    spoken: 'Counting words',
  },
  null,
  2
);
const WORD_COUNT_HANDLER = `export async function run(args, api) {
  const text = String(args.text || '');
  const words = text.trim().length ? text.trim().split(/\\s+/).length : 0;
  return { count: words };
}
`;

async function ensureExampleTool(): Promise<void> {
  const existing = await opfs.readText('/tools/word_count/tool.json');
  if (existing) return;
  await opfs.mkdir('/tools/word_count');
  await opfs.writeText('/tools/word_count/tool.json', WORD_COUNT_TOOL_JSON);
  await opfs.writeText('/tools/word_count/handler.js', WORD_COUNT_HANDLER);
}

export const customTools = {
  async list(): Promise<Array<{ name: string; spec: import('../core/types').ToolSpec; flags: ToolFlags; handler: string }>> {
    const names = await opfs.list('/tools');
    const out: Array<{ name: string; spec: import('../core/types').ToolSpec; flags: ToolFlags; handler: string }> = [];
    for (const name of names) {
      const jsonText = await opfs.readText(`/tools/${name}/tool.json`);
      const handler = await opfs.readText(`/tools/${name}/handler.js`);
      if (!jsonText || !handler) continue;
      const parsed: ToolJson = JSON.parse(jsonText);
      out.push({ name, spec: { name: parsed.name, description: parsed.description, parameters: parsed.parameters }, flags: { ...parsed.flags, custom: true }, handler });
    }
    return out;
  },

  async save(name: string, spec: import('../core/types').ToolSpec, flags: ToolFlags, handler: string): Promise<void> {
    await opfs.mkdir(`/tools/${name}`);
    const toolJson: ToolJson = { name: spec.name, description: spec.description, parameters: spec.parameters, flags };
    await opfs.writeText(`/tools/${name}/tool.json`, JSON.stringify(toolJson, null, 2));
    await opfs.writeText(`/tools/${name}/handler.js`, handler);
    await registerFromFolder(name);
  },

  async remove(name: string): Promise<void> {
    await opfs.remove(`/tools/${name}/tool.json`);
    await opfs.remove(`/tools/${name}/handler.js`);
    tools.unregister(name);
  },

  async loadAll(): Promise<void> {
    await ensureExampleTool();
    const names = await opfs.list('/tools');
    for (const name of names) {
      try {
        await registerFromFolder(name);
      } catch (e) {
        console.error('custom tool load failed', name, e);
      }
    }
  },
};
