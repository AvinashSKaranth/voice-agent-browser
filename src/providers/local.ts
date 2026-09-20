// Local LLM provider: wraps llm.worker.ts (LFM2.5-VL-3B) behind the shared LlmProvider contract.
// Strips <|tool_call_start|>...<|tool_call_end|> markup from streamed tokens (the orchestrator must
// never see raw markup) and parses the Pythonic call list inside it into ToolCall[].
import { bus } from '../core/bus';
import { createProgressAggregator } from '../audio/progress';
import type { ChatMessage, GenerateOptions, GenerateResult, LlmIn, LlmOut, LlmProvider, ToolCall } from '../core/types';

const TOOL_CALL_START = '<|tool_call_start|>';
const TOOL_CALL_END = '<|tool_call_end|>';

// ---------- streamed markup stripping ----------
// Buffers text after a tool-call start marker and never forwards it to onToken; handles markers
// split across streamed token chunks by holding back a short tail until a marker can't match it.
// Length of the longest suffix of `s` that is itself a prefix of `marker` (0 if none) - used to
// hold back a possible partial marker split across chunks without leaking it as visible text.
function partialSuffixLen(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (marker.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

function makeStreamSplitter(onVisible: (text: string) => void) {
  let buf = '';
  let inCall = false;
  const drain = (final: boolean): void => {
    for (;;) {
      if (!inCall) {
        const idx = buf.indexOf(TOOL_CALL_START);
        if (idx === -1) {
          // On final flush, only hold back (and drop) a real partial-marker suffix; never leak it.
          const holdBack = final ? partialSuffixLen(buf, TOOL_CALL_START) : TOOL_CALL_START.length - 1;
          const safeLen = Math.max(0, buf.length - holdBack);
          if (safeLen > 0) {
            onVisible(buf.slice(0, safeLen));
          }
          buf = buf.slice(safeLen);
          return;
        }
        if (idx > 0) onVisible(buf.slice(0, idx));
        buf = buf.slice(idx + TOOL_CALL_START.length);
        inCall = true;
      } else {
        const idx = buf.indexOf(TOOL_CALL_END);
        if (idx === -1) return; // still inside the call; wait for more text (or final flush drops it)
        buf = buf.slice(idx + TOOL_CALL_END.length);
        inCall = false;
      }
    }
  };
  return {
    push: (chunk: string): void => {
      buf += chunk;
      drain(false);
    },
    flush: (): void => drain(true),
  };
}

// ---------- Python-literal tool-call-list parser ----------
interface Pos {
  i: number;
}

function skipWs(s: string, pos: Pos): void {
  while (pos.i < s.length && /\s/.test(s[pos.i])) pos.i++;
}

function parseIdent(s: string, pos: Pos): string {
  const start = pos.i;
  while (pos.i < s.length && /[A-Za-z0-9_]/.test(s[pos.i])) pos.i++;
  return s.slice(start, pos.i);
}

function parseString(s: string, pos: Pos): string {
  const quote = s[pos.i];
  pos.i++;
  let out = '';
  while (pos.i < s.length && s[pos.i] !== quote) {
    if (s[pos.i] === '\\' && pos.i + 1 < s.length) {
      out += s[pos.i + 1];
      pos.i += 2;
    } else {
      out += s[pos.i];
      pos.i++;
    }
  }
  pos.i++; // closing quote
  return out;
}

function parseValue(s: string, pos: Pos): unknown {
  skipWs(s, pos);
  const c = s[pos.i];
  if (c === '"' || c === "'") return parseString(s, pos);
  if (c === '[') return parseList(s, pos);
  if (c === '{') return parseDict(s, pos);
  if (s.startsWith('True', pos.i)) {
    pos.i += 4;
    return true;
  }
  if (s.startsWith('False', pos.i)) {
    pos.i += 5;
    return false;
  }
  if (s.startsWith('None', pos.i)) {
    pos.i += 4;
    return null;
  }
  const start = pos.i;
  while (pos.i < s.length && /[-+0-9.eE]/.test(s[pos.i])) pos.i++;
  const numStr = s.slice(start, pos.i);
  const num = Number(numStr);
  return numStr && !Number.isNaN(num) ? num : numStr;
}

function parseList(s: string, pos: Pos): unknown[] {
  pos.i++; // [
  skipWs(s, pos);
  const out: unknown[] = [];
  while (pos.i < s.length && s[pos.i] !== ']') {
    out.push(parseValue(s, pos));
    skipWs(s, pos);
    if (s[pos.i] === ',') {
      pos.i++;
      skipWs(s, pos);
    }
  }
  if (s[pos.i] === ']') pos.i++;
  return out;
}

function parseDict(s: string, pos: Pos): Record<string, unknown> {
  pos.i++; // {
  skipWs(s, pos);
  const out: Record<string, unknown> = {};
  while (pos.i < s.length && s[pos.i] !== '}') {
    const key = String(parseValue(s, pos));
    skipWs(s, pos);
    if (s[pos.i] === ':') pos.i++;
    skipWs(s, pos);
    out[key] = parseValue(s, pos);
    skipWs(s, pos);
    if (s[pos.i] === ',') {
      pos.i++;
      skipWs(s, pos);
    }
  }
  if (s[pos.i] === '}') pos.i++;
  return out;
}

function parseCall(s: string, pos: Pos): { name: string; args: Record<string, unknown> } {
  skipWs(s, pos);
  const name = parseIdent(s, pos);
  skipWs(s, pos);
  const args: Record<string, unknown> = {};
  if (s[pos.i] === '(') {
    pos.i++;
    skipWs(s, pos);
    while (pos.i < s.length && s[pos.i] !== ')') {
      const key = parseIdent(s, pos);
      skipWs(s, pos);
      if (s[pos.i] === '=') pos.i++;
      skipWs(s, pos);
      args[key] = parseValue(s, pos);
      skipWs(s, pos);
      if (s[pos.i] === ',') {
        pos.i++;
        skipWs(s, pos);
      }
    }
    if (s[pos.i] === ')') pos.i++;
  }
  return { name, args };
}

function parseCallList(src: string): Array<{ name: string; args: Record<string, unknown> }> {
  const s = src.trim();
  const pos: Pos = { i: 0 };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  skipWs(s, pos);
  const bracketed = s[pos.i] === '[';
  if (bracketed) {
    pos.i++;
    skipWs(s, pos);
  }
  const closer = bracketed ? ']' : '';
  while (pos.i < s.length && s[pos.i] !== closer) {
    calls.push(parseCall(s, pos));
    skipWs(s, pos);
    if (s[pos.i] === ',') {
      pos.i++;
      skipWs(s, pos);
    } else break;
  }
  return calls;
}

/** Pure: extracts every `<|tool_call_start|>...<|tool_call_end|>` block from text and parses its
 * Pythonic call list into ToolCall[]. Malformed blocks are dropped, not thrown (AG-4 leaves
 * re-prompt-on-malformed-call to the orchestrator; this parser never surfaces raw markup). */
export function parseLfmToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const re = new RegExp(`${TOOL_CALL_START}([\\s\\S]*?)${TOOL_CALL_END}`, 'g');
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = re.exec(text))) {
    try {
      for (const c of parseCallList(match[1])) {
        if (c.name) calls.push({ id: `call_${idx++}`, name: c.name, args: c.args });
      }
    } catch {
      /* malformed tool-call block: dropped */
    }
  }
  return calls;
}

function stripToolCallMarkup(text: string): string {
  const withoutPairs = text.replace(new RegExp(`${TOOL_CALL_START}[\\s\\S]*?${TOOL_CALL_END}`, 'g'), '');
  // Truncated generation can leave an unmatched start marker with no closing tag; drop it and
  // everything after it rather than let raw markup leak into the visible/spoken text.
  const idx = withoutPairs.indexOf(TOOL_CALL_START);
  return (idx === -1 ? withoutPairs : withoutPairs.slice(0, idx)).trim();
}

// ---------- worker wrapper ----------
let worker: Worker | null = null;
let isReady = false;
let loadPromise: Promise<void> | null = null;
let seq = 0;
const emitProgress = createProgressAggregator('llm');

interface ActiveGen {
  splitter: ReturnType<typeof makeStreamSplitter>;
  resolve: (r: GenerateResult) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}
const active = new Map<string, ActiveGen>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/llm.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<LlmOut>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      if (msg.status === 'ready') isReady = true;
      emitProgress(msg);
      return;
    }
    if (msg.type === 'token') {
      active.get(msg.id)?.splitter.push(msg.text);
      return;
    }
    if (msg.type === 'done') {
      const g = active.get(msg.id);
      if (!g) return;
      g.splitter.flush();
      active.delete(msg.id);
      g.cleanup();
      const toolCalls = parseLfmToolCalls(msg.text);
      const finishReason: GenerateResult['finishReason'] =
        msg.finishReason === 'aborted' ? 'aborted' : toolCalls.length > 0 ? 'tool_calls' : msg.finishReason;
      g.resolve({ text: stripToolCallMarkup(msg.text), toolCalls, finishReason });
      return;
    }
    if (msg.type === 'error') {
      if (!msg.id) {
        bus.emit({ type: 'toast', level: 'error', text: `LLM: ${msg.error}` });
        return;
      }
      const g = active.get(msg.id);
      if (!g) return;
      active.delete(msg.id);
      g.cleanup();
      g.reject(new Error(msg.error)); // let the orchestrator's retry/give-up path handle it
    }
  };
  return worker;
}

export function loadLocalLlm(): Promise<void> {
  if (isReady) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const w = ensureWorker();
  loadPromise = new Promise<void>((resolve, reject) => {
    const off = bus.on('model:progress', (e) => {
      if (e.model !== 'llm') return;
      if (e.status === 'ready') {
        off();
        resolve();
      } else if (e.status === 'error') {
        off();
        loadPromise = null;
        reject(new Error(e.error ?? 'LLM load failed'));
      }
    });
    w.postMessage({ type: 'load' } satisfies LlmIn);
  });
  return loadPromise;
}

export function localLlmReady(): boolean {
  return isReady;
}

async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  if (opts.signal.aborted) return { text: '', toolCalls: [], finishReason: 'aborted' };
  await loadLocalLlm();
  const w = ensureWorker();
  const id = `gen_${++seq}`;
  const messages: ChatMessage[] = opts.messages;
  return new Promise<GenerateResult>((resolve, reject) => {
    const onAbort = () => w.postMessage({ type: 'abort', id } satisfies LlmIn);
    opts.signal.addEventListener('abort', onAbort);
    active.set(id, {
      splitter: makeStreamSplitter(opts.onToken),
      resolve,
      reject,
      cleanup: () => opts.signal.removeEventListener('abort', onAbort),
    });
    w.postMessage({
      type: 'generate',
      id,
      messages,
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    } satisfies LlmIn);
  });
}

export const localProvider: LlmProvider = {
  id: 'local',
  label: 'Local (LFM2.5-VL-3B)',
  supportsImages: true,
  supportsTools: true,
  generate,
};

// ---------- self-check (dev only) ----------
if (import.meta.env.DEV) {
  const cases: Array<[string, ToolCall[]]> = [
    ['<|tool_call_start|>[calc(expr="18% of 4250")]<|tool_call_end|>', [{ id: 'call_0', name: 'calc', args: { expr: '18% of 4250' } }]],
    [
      "<|tool_call_start|>[search(query='weather', n=3, exact=True)]<|tool_call_end|>",
      [{ id: 'call_0', name: 'search', args: { query: 'weather', n: 3, exact: true } }],
    ],
    [
      '<|tool_call_start|>[a(x=1.5, tags=["x","y"], opts={"k": None}), b(y=False)]<|tool_call_end|>',
      [
        { id: 'call_0', name: 'a', args: { x: 1.5, tags: ['x', 'y'], opts: { k: null } } },
        { id: 'call_1', name: 'b', args: { y: false } },
      ],
    ],
  ];
  for (const [input, expected] of cases) {
    const got = parseLfmToolCalls(input);
    console.assert(JSON.stringify(got) === JSON.stringify(expected), 'parseLfmToolCalls self-check failed', { input, got, expected });
  }
}
