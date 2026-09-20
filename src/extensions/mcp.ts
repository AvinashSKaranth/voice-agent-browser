// MCP client over Streamable HTTP; registers remote tools into the shared tool registry.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tools } from '../tools/registry';
import { getSettings } from '../core/settings';
import { bus } from '../core/bus';
import type { JsonSchema, McpServerConfig, Tool, ToolResult } from '../core/types';

type ConnStatus = 'connected' | 'error' | 'off';

const clients = new Map<string, Client>();
const statuses = new Map<string, ConnStatus>();
const registeredNames = new Map<string, string[]>();

function sanitizeToolName(serverId: string, toolName: string): string {
  return `${serverId}__${toolName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

const AUTO_CONFIRM_RE = /submit|delete|remove|send|pay|purchase|buy|automation|write|update|create|post|run|execute/i;

function coerceSchema(schema: unknown): JsonSchema {
  const s = schema as { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined;
  return { type: 'object', properties: s?.properties ?? {}, required: s?.required };
}

function spokenFor(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes('search')) return 'Let me search the web';
  if (n.includes('fetch')) return 'Let me read that page';
  if (n.includes('automation') || n.includes('browser')) return 'Let me work in the browser';
  return `Running ${toolName}`;
}

function flattenResult(result: { content?: Array<Record<string, unknown>>; isError?: boolean }): ToolResult {
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of result.content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      images.push(`data:${part.mimeType};base64,${part.data}`);
    }
  }
  const content = texts.join('\n').slice(0, 8000);
  return { ok: !result.isError, content, images: images.length ? images : undefined, error: result.isError ? content : undefined };
}

function makeTransport(cfg: McpServerConfig): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {} },
  });
}

async function connect(cfg: McpServerConfig): Promise<{ tools: number }> {
  const client = new Client({ name: 'voice-agent-browser', version: '0.1.0' });
  await client.connect(makeTransport(cfg));
  try {
    const { tools: remoteTools } = await client.listTools();

    const names: string[] = [];
    const seen = new Set<string>();
    for (const t of remoteTools) {
      let toolName = sanitizeToolName(cfg.id, t.name);
      if (seen.has(toolName)) {
        let n = 2;
        while (seen.has(`${toolName}_${n}`)) n++;
        toolName = `${toolName}_${n}`;
      }
      seen.add(toolName);
      names.push(toolName);
      const tool: Tool = {
        spec: { name: toolName, description: t.description ?? '', parameters: coerceSchema(t.inputSchema) },
        flags: { remote: true, mcp: cfg.id, confirm: AUTO_CONFIRM_RE.test(t.name) },
        spoken: spokenFor(t.name),
        async run(args) {
          try {
            const result = await client.callTool({ name: t.name, arguments: args });
            return flattenResult(result as { content?: Array<Record<string, unknown>>; isError?: boolean });
          } catch (e) {
            return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
          }
        },
      };
      tools.register(tool);
    }

    clients.set(cfg.id, client);
    registeredNames.set(cfg.id, names);
    statuses.set(cfg.id, 'connected');
    return { tools: names.length };
  } catch (e) {
    // listTools()/registration failed after connect() succeeded — close the transport so it's not leaked.
    try {
      await client.close();
    } catch {
      // already closed / unreachable
    }
    throw e;
  }
}

async function disconnect(id: string): Promise<void> {
  for (const name of registeredNames.get(id) ?? []) tools.unregister(name);
  registeredNames.delete(id);
  const client = clients.get(id);
  clients.delete(id);
  if (client) {
    try {
      await client.close();
    } catch {
      // already closed / unreachable
    }
  }
  statuses.set(id, 'off');
}

async function connectAll(): Promise<void> {
  const settings = getSettings();
  const configs: McpServerConfig[] = [...settings.mcp];
  if (settings.tinyfishKey && !configs.some((c) => c.id === 'tinyfish')) {
    configs.push({ id: 'tinyfish', label: 'TinyFish', url: 'https://agent.tinyfish.ai/mcp', token: settings.tinyfishKey, enabled: true });
  }
  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    try {
      await connect(cfg);
    } catch (e) {
      statuses.set(cfg.id, 'error');
      bus.emit({ type: 'toast', level: 'error', text: `MCP server "${cfg.label}" failed to connect: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}

async function test(cfg: McpServerConfig): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  let client: Client | undefined;
  try {
    client = new Client({ name: 'voice-agent-browser', version: '0.1.0' });
    await client.connect(makeTransport(cfg));
    const { tools: remoteTools } = await client.listTools();
    return { ok: true, tools: remoteTools.map((t) => t.name) };
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      await client?.close();
    } catch {
      // ignore
    }
  }
}

export const mcp = {
  connectAll,
  connect,
  disconnect,
  status(id: string): ConnStatus {
    return statuses.get(id) ?? 'off';
  },
  test,
};
