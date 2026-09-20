// web_search / web_fetch via the TinyFish REST APIs (free tier, CORS enabled, X-API-Key auth).
// The TinyFish MCP endpoint cannot be used from a browser: it does not expose Mcp-Session-Id
// (checked 2026-09-20), so these tools call the plain HTTP APIs instead.
import type { Tool, ToolResult } from '../../core/types';

const SEARCH_URL = 'https://api.search.tinyfish.ai';
const FETCH_URL = 'https://api.fetch.tinyfish.ai';
const TIMEOUT_MS = 30000;

function noKey(): ToolResult {
  return { ok: false, content: '', error: 'No TinyFish API key configured. Add one in Settings to enable web search and fetch.' };
}

async function call(url: string, init: RequestInit, key: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-API-Key': key }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpError(res: Response): string {
  if (res.status === 401) return 'TinyFish rejected the API key.';
  if (res.status === 429) return 'TinyFish rate limit reached, wait a minute.';
  return `TinyFish returned HTTP ${res.status}.`;
}

interface SearchResult {
  position?: number;
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

export const web_search: Tool = {
  spec: {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs and snippets. Use for current events, facts you are unsure of, or anything after your training data.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        recency_minutes: { type: 'number', description: 'Only results from the last N minutes, e.g. 1440 for one day' },
        domain_type: { type: 'string', enum: ['web', 'news', 'research_paper'] },
      },
      required: ['query'],
    },
  },
  flags: { remote: true },
  spoken: 'Let me search the web',
  async run(args, ctx) {
    const key = ctx.settings.tinyfishKey;
    if (!key) return noKey();
    const params = new URLSearchParams({ query: String(args.query ?? '') });
    if (args.recency_minutes) params.set('recency_minutes', String(Math.max(1, Math.floor(Number(args.recency_minutes)))));
    if (args.domain_type) params.set('domain_type', String(args.domain_type));
    try {
      const res = await call(`${SEARCH_URL}?${params.toString()}`, { method: 'GET' }, key);
      if (!res.ok) return { ok: false, content: '', error: httpError(res) };
      const json = (await res.json()) as { results?: SearchResult[] };
      const lines = (json.results ?? []).slice(0, 8).map((r, i) => `${i + 1}. ${r.title ?? ''}\n   ${r.url ?? ''}\n   ${(r.snippet ?? '').replace(/\s+/g, ' ').slice(0, 300)}${r.date ? `\n   (${r.date})` : ''}`);
      return { ok: true, content: lines.length ? lines.join('\n') : 'No results.' };
    } catch (e) {
      return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

interface FetchPage {
  url: string;
  title?: string | null;
  text?: string | null;
}

export const web_fetch: Tool = {
  spec: {
    name: 'web_fetch',
    description: 'Fetch one or more web pages (max 5) and return their main content as Markdown. Use after web_search to read a result.',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Absolute http(s) URLs' },
      },
      required: ['urls'],
    },
  },
  flags: { remote: true },
  spoken: 'Let me read that page',
  async run(args, ctx) {
    const key = ctx.settings.tinyfishKey;
    if (!key) return noKey();
    const raw = Array.isArray(args.urls) ? args.urls : [args.urls];
    const urls = raw.map((u) => String(u)).filter((u) => /^https?:\/\//.test(u)).slice(0, 5);
    if (!urls.length) return { ok: false, content: '', error: 'No valid http(s) URL given.' };
    try {
      const res = await call(FETCH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls, format: 'markdown' }) }, key);
      if (!res.ok) return { ok: false, content: '', error: httpError(res) };
      const json = (await res.json()) as { results?: FetchPage[]; errors?: Array<{ url: string; error: string }> };
      const perPage = Math.floor(7500 / urls.length);
      const parts = (json.results ?? []).map((p) => `## ${p.title ?? p.url}\n${p.url}\n\n${(p.text ?? '').slice(0, perPage)}`);
      for (const e of json.errors ?? []) parts.push(`## ${e.url}\nCould not fetch: ${e.error}`);
      return { ok: parts.length > 0, content: parts.join('\n\n').slice(0, 8000), error: parts.length ? undefined : 'Nothing fetched.' };
    } catch (e) {
      return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};
