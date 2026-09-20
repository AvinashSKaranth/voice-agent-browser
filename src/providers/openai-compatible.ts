// OpenAI-compatible chat-completions provider: streams SSE, converts ChatMessage <-> wire format,
// and optionally routes through the native bridge's provider.proxy command (NIM has no CORS).
import type {
  ChatMessage,
  ContentPart,
  GenerateOptions,
  GenerateResult,
  LlmProvider,
  ProviderConfig,
  ToolCall,
  ToolSpec,
} from '../core/types';
import { bridge } from '../core/bridge';

type WireContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface WireMessage {
  role: string;
  content?: string | WireContentPart[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface WireStreamChoice {
  delta?: {
    content?: string;
    tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
}

interface WireStreamChunk {
  choices?: WireStreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  // OpenRouter reports upstream failures as HTTP 200 with an error object in the body.
  error?: { message?: string; code?: number | string; metadata?: { error_type?: string } };
}

export function createOpenAiProvider(cfg: ProviderConfig): LlmProvider {
  return {
    id: cfg.id,
    label: cfg.label,
    supportsImages: cfg.supportsImages,
    supportsTools: cfg.supportsTools,
    generate: (opts: GenerateOptions) => runGenerate(cfg, opts),
  };
}

function contentToWire(content: string | ContentPart[]): string | WireContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } }));
}

function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', name: m.name, content: contentToWire(m.content) };
    }
    const wire: WireMessage = { role: m.role, content: contentToWire(m.content) };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      wire.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
    }
    return wire;
  });
}

function toWireTools(tools: ToolSpec[]) {
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function buildHeaders(cfg: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (cfg.extraHeaders) Object.assign(headers, cfg.extraHeaders);
  if (cfg.id === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Voice Agent';
  }
  if (cfg.id === 'anthropic') {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

function buildBody(cfg: ProviderConfig, opts: GenerateOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { model: cfg.model, messages: toWireMessages(opts.messages), stream: true };
  // OpenRouter free models often hit upstream capacity limits; `models` makes OpenRouter fall back
  // to the next id in the list instead of returning an error. Verified free, tool + image capable 2026-09-20.
  if (/openrouter\.ai/.test(cfg.baseUrl) && cfg.model.endsWith(':free')) {
    body.models = [...new Set([cfg.model, 'google/gemma-4-26b-a4b-it:free', 'qwen/qwen3.8-27b:free'])].slice(0, 3); // OpenRouter caps this at 3
  }
  if (cfg.supportsTools && opts.tools.length) {
    body.tools = toWireTools(opts.tools);
    body.tool_choice = 'auto';
  }
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.temperature != null) body.temperature = opts.temperature;
  return body;
}

function httpErrorMessage(status: number, bodyText: string): string {
  if (status === 429) {
    let detail = '';
    try { detail = String((JSON.parse(bodyText) as { error?: { message?: string } }).error?.message ?? ''); } catch { /* not json */ }
    return `Rate limited${detail ? `: ${detail.slice(0, 200)}` : ', wait a minute.'}`;
  }
  if (status === 401) return 'Invalid API key.';
  return `Provider request failed (${status}): ${bodyText.slice(0, 300)}`;
}

function mapFinishReason(r: string): GenerateResult['finishReason'] {
  if (r === 'tool_calls') return 'tool_calls';
  if (r === 'length') return 'length';
  return 'stop';
}

interface ToolCallAccum {
  id: string;
  name: string;
  args: string;
}

interface StreamState {
  text: string;
  toolCalls: Map<number, ToolCallAccum>;
  finishReason: GenerateResult['finishReason'];
  usage?: { prompt: number; completion: number };
  buffer: string;
  thinkOpen: boolean;
  pendingData: string[]; // data: lines accumulated for the current SSE event, until a blank line
}

function createStreamState(): StreamState {
  return { text: '', toolCalls: new Map(), finishReason: 'stop', buffer: '', thinkOpen: false, pendingData: [] };
}

// Strips <think>...</think> reasoning blocks (Nemotron) out of streamed text.
// ponytail: a tag split mid-marker across two SSE chunks (e.g. "<thi" + "nk>") won't be caught;
// upgrade to a rolling tail buffer if that shows up with a real model.
function stripThink(state: StreamState, input: string): string {
  let out = '';
  let rest = input;
  while (rest.length) {
    if (state.thinkOpen) {
      const end = rest.indexOf('</think>');
      if (end === -1) {
        rest = '';
        break;
      }
      rest = rest.slice(end + '</think>'.length);
      state.thinkOpen = false;
    } else {
      const start = rest.indexOf('<think>');
      if (start === -1) {
        out += rest;
        rest = '';
      } else {
        out += rest.slice(0, start);
        rest = rest.slice(start + '<think>'.length);
        state.thinkOpen = true;
      }
    }
  }
  return out;
}

function finalizeToolCalls(map: Map<number, ToolCallAccum>): ToolCall[] {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => {
      let args: Record<string, unknown>;
      try {
        args = v.args ? JSON.parse(v.args) : {};
      } catch {
        args = { _raw: v.args };
      }
      return { id: v.id || crypto.randomUUID(), name: v.name, args };
    });
}

// Parses one complete SSE event's accumulated data: lines and applies it to `state`.
function applySseEvent(state: StreamState, dataLines: string[], onToken: (text: string) => void): void {
  if (!dataLines.length) return;
  const data = dataLines.join('\n');
  if (data === '[DONE]' || data === '') return;
  let json: WireStreamChunk;
  try {
    json = JSON.parse(data) as WireStreamChunk;
  } catch {
    return;
  }
  if (json.error) throw new Error(`Provider error: ${json.error.message ?? String(json.error.code ?? 'unknown')}`);
  if (json.usage) state.usage = { prompt: json.usage.prompt_tokens ?? 0, completion: json.usage.completion_tokens ?? 0 };
  const choice = json.choices?.[0];
  if (!choice) return;
  const delta = choice.delta ?? {};
  if (typeof delta.content === 'string' && delta.content) {
    const clean = stripThink(state, delta.content);
    if (clean) {
      state.text += clean;
      onToken(clean);
    }
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      let entry = state.toolCalls.get(idx);
      if (!entry) {
        entry = { id: '', name: '', args: '' };
        state.toolCalls.set(idx, entry);
      }
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
    }
  }
  if (choice.finish_reason) state.finishReason = mapFinishReason(choice.finish_reason);
}

// Feeds one chunk of raw SSE text into `state`, calling onToken for each clean content delta.
// Exported for the DEV self-check below; not part of the module's public API surface.
// Per the SSE spec an event's data: lines accumulate (joined by \n) until a blank line terminates it.
function feedSse(state: StreamState, chunkText: string, onToken: (text: string) => void): void {
  state.buffer += chunkText;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      applySseEvent(state, state.pendingData, onToken);
      state.pendingData = [];
      continue;
    }
    if (!line.startsWith('data:')) continue;
    state.pendingData.push(line.slice(5).trim());
  }
}

async function runGenerate(cfg: ProviderConfig, opts: GenerateOptions): Promise<GenerateResult> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const headers = buildHeaders(cfg);
  const body = buildBody(cfg, opts);
  const state = createStreamState();

  if (cfg.viaBridge) {
    try {
      await bridge.call<void>('provider.proxy', { url, method: 'POST', headers, body }, (chunk) => feedSse(state, chunk, opts.onToken), opts.signal);
    } catch (e) {
      if (opts.signal.aborted) return { text: state.text, toolCalls: finalizeToolCalls(state.toolCalls), finishReason: 'aborted' };
      throw e;
    }
    return { text: state.text, toolCalls: finalizeToolCalls(state.toolCalls), finishReason: state.finishReason, usage: state.usage };
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
  } catch (e) {
    if (opts.signal.aborted) return { text: '', toolCalls: [], finishReason: 'aborted' };
    throw e;
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(httpErrorMessage(res.status, bodyText));
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body from provider.');
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feedSse(state, decoder.decode(value, { stream: true }), opts.onToken);
    }
  } catch (e) {
    if (opts.signal.aborted) return { text: state.text, toolCalls: finalizeToolCalls(state.toolCalls), finishReason: 'aborted' };
    throw e;
  }
  return { text: state.text, toolCalls: finalizeToolCalls(state.toolCalls), finishReason: state.finishReason, usage: state.usage };
}

// DEV-only self-check: a 3-chunk sample with a content delta plus a tool-call whose
// `arguments` string arrives split across two chunks. Run with `npm run dev` and watch the
// console; a failed console.assert prints its message and the offending value.
if (import.meta.env.DEV) {
  const state = createStreamState();
  const tokens: string[] = [];
  // Each SSE event's data: line(s) end with a blank line (\n\n), per spec.
  const line1 = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`;
  const line2 = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }],
  })}\n\n`;
  const line3 = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] }, finish_reason: 'tool_calls' }],
  })}\n\ndata: [DONE]\n\n`;
  feedSse(state, line1, (t) => tokens.push(t));
  feedSse(state, line2, (t) => tokens.push(t));
  feedSse(state, line3, (t) => tokens.push(t));
  const calls = finalizeToolCalls(state.toolCalls);
  console.assert(tokens.join('') === 'Hel', '[openai-compatible self-check] content token mismatch', tokens);
  console.assert(
    calls.length === 1 && calls[0].name === 'get_weather' && JSON.stringify(calls[0].args) === JSON.stringify({ city: 'NYC' }),
    '[openai-compatible self-check] tool-call mismatch',
    calls
  );
  console.assert(state.finishReason === 'tool_calls', '[openai-compatible self-check] finish reason mismatch', state.finishReason);
}
