import type { Tool } from '../../core/types';

const TIMEOUT_MS = 10000;

const http_request: Tool = {
  spec: {
    name: 'http_request',
    description: 'Call a URL with a given HTTP method, headers and body. For personal APIs the user has asked to wire up.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', properties: {} },
        body: { type: 'string' },
      },
      required: ['url'],
    },
  },
  flags: { remote: true, confirm: true },
  spoken: 'Making that request',
  async run(args) {
    const url = String(args.url ?? '');
    const method = args.method ? String(args.method) : 'GET';
    const headers = (args.headers as Record<string, string>) ?? undefined;
    const body = args.body ? String(args.body) : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      return { ok: res.ok, content: text.slice(0, 8000), error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  },
};

export default http_request;
