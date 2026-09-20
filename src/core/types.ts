// Shared contracts. Every module imports from here; nobody redefines these.

// ---------- Chat / LLM ----------
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string }; // data:image/...;base64,...

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  toolCalls?: ToolCall[]; // assistant only
  toolCallId?: string; // tool only
  name?: string; // tool only (tool name)
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolSpec {
  name: string; // snake_case, unique
  description: string;
  parameters: JsonSchema;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onToken: (text: string) => void; // streamed plain text (never tool-call markup)
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult {
  text: string; // full plain text
  toolCalls: ToolCall[]; // parsed; empty when plain reply
  finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';
  usage?: { prompt: number; completion: number };
}

export interface LlmProvider {
  id: string; // 'local' | provider id from settings
  label: string;
  supportsImages: boolean;
  supportsTools: boolean;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

// ---------- Tools ----------
export interface ToolFlags {
  confirm?: boolean; // ask user before running
  remote?: boolean; // makes network calls
  bridge?: boolean; // needs native bridge
  custom?: boolean; // user-defined
  mcp?: string; // MCP server id that owns it
}

export interface ToolResult {
  ok: boolean;
  content: string; // text handed back to the model (keep < 8k chars; truncate)
  images?: string[]; // data URLs for vision follow-up
  error?: string;
}

export interface ToolContext {
  signal: AbortSignal;
  speak(text: string): void; // immediate spoken feedback
  notify(title: string, body?: string): void;
  provider(): LlmProvider; // active provider (for describe_image etc.)
  settings: Settings;
  db: DbApi;
  confirm(question: string): Promise<boolean>;
}

export interface Tool {
  spec: ToolSpec;
  flags?: ToolFlags;
  spoken?: string; // e.g. "Let me search for that" - said before running
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------- Storage ----------
export type SqlValue = string | number | null | Uint8Array;
export interface DbApi {
  exec(sql: string, params?: SqlValue[]): Promise<void>;
  query<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

// ---------- STT models (src/audio/stt-models.ts holds the registry) ----------
export type SttModelId = 'whisper-tiny' | 'whisper-base' | 'distil-small.en' | 'moonshine-tiny' | 'moonshine-base';

// ---------- TTS engines (src/audio/tts-engines.ts holds the registry) ----------
export type TtsEngine = 'kokoro' | 'kitten-nano' | 'kitten-mini';

// ---------- Settings (localStorage, key 'va.settings') ----------
export interface ProviderConfig {
  id: string; // 'openrouter' | 'nim' | 'openai' | ... | 'ollama' | 'custom-<uuid>'
  label: string;
  baseUrl: string; // OpenAI-compatible base, no trailing slash, e.g. https://openrouter.ai/api/v1
  apiKey?: string;
  model: string;
  supportsImages: boolean;
  supportsTools: boolean;
  extraHeaders?: Record<string, string>;
  viaBridge?: boolean; // route through bridge provider.proxy (NIM)
  enabled: boolean;
}

export interface McpServerConfig {
  id: string;
  label: string;
  url: string; // Streamable HTTP endpoint
  token?: string; // bearer
  enabled: boolean;
}

export interface Settings {
  setupDone: boolean;
  mode: 'local' | 'cloud'; // which LlmProvider answers turns
  activeProviderId: string; // when mode === 'cloud'
  providers: ProviderConfig[];
  local: {
    llm: boolean; // download/run LFM2.5-VL-3B
    stt: boolean; // whisper-base
    ttsDevice: 'wasm' | 'webgpu';
    ttsDeviceExplicit?: boolean; // true once the user picked a device in Settings; else tts.ts auto-resolves (webgpu when available)
    ttsEngine: TtsEngine; // default 'kokoro'; kitten-* always runs on wasm regardless of ttsDevice (see src/audio/tts-engines.ts)
    sttModel: SttModelId; // default 'whisper-base'; see src/audio/stt-models.ts
    sttDevice: 'auto' | 'webgpu' | 'wasm' | 'hybrid'; // default 'auto' = webgpu when available; 'hybrid' = encoder on webgpu, decoder on wasm (see src/audio/stt-models.ts)
    sttStreaming: boolean; // default true; streamed partial transcription while VAD reports speech
  };
  voice: { id: string; speed: number }; // kokoro voice id, default af_heart, 1.0
  wake: { enabled: boolean; phrase: string; threshold: number; pushToTalk: boolean }; // default 'hey_jarvis', 0.5
  feedback: { heartbeatSec: number; maxRetries: number; quiet: boolean }; // 60, 3, false
  terminal: string; // bridge terminal command, '' = OS default
  bridge: { url: string; token?: string }; // ws://127.0.0.1:7711
  mcp: McpServerConfig[];
  tinyfishKey?: string;
  userName?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  setupDone: false,
  mode: 'local',
  activeProviderId: 'openrouter',
  providers: [],
  local: { llm: true, stt: true, ttsDevice: 'wasm', ttsEngine: 'kokoro', sttModel: 'moonshine-base', sttDevice: 'auto', sttStreaming: true },
  voice: { id: 'af_heart', speed: 1.0 },
  wake: { enabled: true, phrase: 'hey_jarvis', threshold: 0.5, pushToTalk: false },
  feedback: { heartbeatSec: 60, maxRetries: 3, quiet: false },
  terminal: '',
  bridge: { url: 'ws://127.0.0.1:7711' },
  mcp: [],
};

// ---------- Events (single global bus, see bus.ts) ----------
export type ModelName = 'stt' | 'llm' | 'tts' | 'vad' | 'wake';
export type LoadStatus = 'downloading' | 'loading' | 'ready' | 'error';

export type AppEvent =
  | { type: 'model:progress'; model: ModelName; file?: string; loaded: number; total: number; status: LoadStatus; error?: string }
  | { type: 'audio:state'; state: 'idle' | 'wake' | 'listening' | 'thinking' | 'speaking' }
  | { type: 'wake:detected'; score: number }
  | { type: 'stt:partial'; text: string }
  | { type: 'stt:final'; text: string }
  | { type: 'turn:start'; id: string; input: string }
  | { type: 'turn:token'; id: string; text: string }
  | { type: 'turn:tool'; id: string; name: string; args: Record<string, unknown>; status: 'start' | 'done' | 'error'; result?: string }
  | { type: 'turn:end'; id: string; text: string; error?: string }
  | { type: 'turn:feedback'; id: string; kind: 'ack' | 'heartbeat' | 'retry' | 'giveup'; text: string }
  | { type: 'turn:ack'; source: 'voice' } // pipeline played a cached ack before transcription started
  | { type: 'tts:start'; text: string }
  | { type: 'tts:end' }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'settings:changed'; settings: Settings }
  | { type: 'tools:changed' }
  | { type: 'confirm:request'; id: string; question: string }
  | { type: 'confirm:answer'; id: string; ok: boolean }
  | { type: 'log:entry'; row: LogRow };

// ---------- Metrics (src/core/metrics.ts) ----------
export interface LogRow {
  id: number;
  ts: number; // epoch ms
  turnId: string | null;
  name: string;
  ms: number | null;
  value: number | null;
  detail: string | null;
}

// ---------- Worker protocols ----------
export type WorkerProgress = { type: 'progress'; file?: string; loaded: number; total: number; status: LoadStatus; error?: string };

// STT worker
export type SttIn =
  | { type: 'load'; device?: 'wasm' | 'webgpu' | 'hybrid'; model?: SttModelId }
  | { type: 'transcribe'; id: string; audio: Float32Array; partial?: boolean };
export type SttOut =
  | WorkerProgress
  | { type: 'result'; id: string; text: string; partial?: boolean }
  | { type: 'error'; id?: string; error: string; partial?: boolean };

// LLM worker (local LFM2.5-VL-3B)
export type LlmIn =
  | { type: 'load' }
  | { type: 'generate'; id: string; messages: ChatMessage[]; tools: ToolSpec[]; maxTokens?: number; temperature?: number }
  | { type: 'abort'; id: string };
export type LlmOut =
  | WorkerProgress
  | { type: 'token'; id: string; text: string }
  | { type: 'done'; id: string; text: string; finishReason: 'stop' | 'length' | 'aborted' }
  | { type: 'error'; id?: string; error: string };

// TTS worker (kokoro, or kitten-nano/kitten-mini via kitten-tts-js)
export type TtsIn =
  | { type: 'load'; device: 'wasm' | 'webgpu'; engine?: TtsEngine }
  | { type: 'speak'; id: string; text: string; voice: string; speed: number }
  | { type: 'abort'; id: string }
  | { type: 'voices' };
export type TtsOut =
  | WorkerProgress
  | { type: 'chunk'; id: string; audio: Float32Array; sampleRate: number }
  | { type: 'done'; id: string }
  | { type: 'voices'; voices: string[] }
  | { type: 'error'; id?: string; error: string };
