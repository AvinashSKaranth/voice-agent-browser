# Architecture and module contracts

Read this before touching code. `BRD.md` is the spec; this file is the build contract. `src/core/types.ts` holds the shared types and is frozen (add, never rename).

## Stack

- Vite 8 + TypeScript + Preact (hooks, no router lib: hash routes `#/`, `#/setup`, `#/assistant`, `#/settings`, `#/extensions`, `#/documents`).
- Output: `npm run build` → `docs/` with relative paths (`base: './'`), deployed to GitHub Pages. Never use absolute `/` URLs at runtime; use `new URL('./x', import.meta.url)` or `./` relative strings. Workers: `new Worker(new URL('../workers/x.worker.ts', import.meta.url), { type: 'module' })`.
- Static assets copied at build (see `vite.config.ts`): `./vad/vad.worklet.bundle.min.js`, `./vad/silero_vad_v5.onnx`, `./ort/*.wasm|*.mjs`. Wake-word models live in `public/models/oww/`.
- Deps installed: `@huggingface/transformers@4.3`, `kokoro-js@1.2`, `@ricky0123/vad-web@0.0.31`, `onnxruntime-web@1.30`, `@sqlite.org/sqlite-wasm`, `@modelcontextprotocol/sdk@1.30`, `zod`, `@firecrawl/anydoc-wasm`, `mathjs`, `preact`. Do not add dependencies without a comment explaining why.
- No backend. No COOP/COEP headers available (GitHub Pages), so: no SharedArrayBuffer, sqlite uses the `opfs-sahpool` VFS inside a worker, ORT runs single-threaded.

## Folder ownership

| Folder | Owner task | Contents |
| --- | --- | --- |
| `src/core/` | shared | `types.ts`, `bus.ts`, `settings.ts` (done); `orchestrator.ts`, `feedback.ts`, `bridge.ts` |
| `src/workers/` | audio | `stt.worker.ts`, `llm.worker.ts`, `tts.worker.ts`, `wake.worker.ts`, `sqlite.worker.ts` (storage) |
| `src/audio/` | audio | `mic.ts`, `player.ts`, `stt.ts`, `tts.ts`, `wake.ts`, `pipeline.ts` |
| `src/providers/` | providers | `local.ts` (audio task), `openai-compatible.ts`, `roster.ts`, `ollama.ts`, `registry.ts` |
| `src/tools/` | tools | `registry.ts`, `builtin/*.ts`, `custom.ts`, `schedule.ts`, `documents.ts` (storage task) |
| `src/storage/` | storage | `db.ts`, `opfs.ts`, `memory.ts`, `transcripts.ts` |
| `src/extensions/` | storage | `skills.ts`, `mcp.ts`, `marketplace.ts` |
| `src/ui/` | ui | `App.tsx`, `Landing.tsx`, `Wizard.tsx`, `Assistant.tsx`, `Settings.tsx`, `Extensions.tsx`, `Documents.tsx`, `components.tsx`, `app.css` |
| `src/main.tsx` | ui | mount + boot |

## Module exports (exact)

### Audio

```ts
// src/audio/stt.ts
export const stt: { load(): Promise<void>; transcribe(audio: Float32Array /*16 kHz mono*/): Promise<string>; ready(): boolean };
// src/audio/tts.ts  – queue + Web Audio playback; resolves when that text finished playing
export const tts: { load(): Promise<void>; say(text: string): Promise<void>; stop(): void; voices(): Promise<string[]>; ready(): boolean; speaking(): boolean };
// src/audio/mic.ts – @ricky0123/vad-web MicVAD (baseAssetPath './vad/', onnxWASMBasePath './ort/'), also raw 16 kHz frames for wake word
export const mic: { start(h: { onSpeechStart?(): void; onSpeechEnd?(audio: Float32Array): void; onFrame?(frame: Float32Array): void }): Promise<void>; stop(): void; pause(): void; resume(): void; active(): boolean };
// src/audio/wake.ts – openWakeWord ONNX in wake.worker.ts
export const wake: { load(phrase: string): Promise<void>; feed(frame16k: Float32Array): void; onDetect(cb: (score: number) => void): void; setThreshold(t: number): void; ready(): boolean };
// src/audio/pipeline.ts – state machine wake→listening→thinking→speaking, emits 'audio:state'
export const pipeline: { start(): Promise<void>; stop(): void; pushToTalkStart(): void; pushToTalkStop(): void; onUtterance(cb: (text: string) => void): void; onBargeIn(cb: () => void): void; setThinking(on: boolean): void };
```

### Providers

```ts
// src/providers/local.ts – wraps llm.worker.ts; parses LFM2.5 tool calls
export const localProvider: LlmProvider; export function loadLocalLlm(): Promise<void>; export function localLlmReady(): boolean;
// src/providers/openai-compatible.ts
export function createOpenAiProvider(cfg: ProviderConfig): LlmProvider;
// src/providers/roster.ts
export const PROVIDER_PRESETS: Array<Omit<ProviderConfig, 'apiKey' | 'enabled'> & { needsKey: boolean; note: string; docsUrl: string }>;
export function listModels(cfg: ProviderConfig): Promise<Array<{ id: string; vision?: boolean; free?: boolean }>>;
export function pickDefaultModel(cfg: ProviderConfig, models: Array<{ id: string; vision?: boolean; free?: boolean }>): string;
// src/providers/ollama.ts
export function listOllamaModels(baseUrl: string): Promise<Array<{ id: string; vision: boolean }>>;
// src/providers/registry.ts
export function getActiveProvider(): LlmProvider;           // local or configured cloud, from settings
export function testConnection(cfg: ProviderConfig): Promise<{ ok: boolean; error?: string; latencyMs: number }>;
// src/core/bridge.ts – Rust bridge WebSocket client (JSON-RPC-ish: {id, cmd, params} / {id, result|error|stream})
export const bridge: { connect(): Promise<boolean>; connected(): boolean; call<T = unknown>(cmd: string, params?: Record<string, unknown>, onStream?: (chunk: string) => void): Promise<T>; onStatus(cb: (c: boolean) => void): () => void };
```

### Tools and orchestration

```ts
// src/tools/registry.ts
export const tools: { register(t: Tool): void; unregister(name: string): void; get(name: string): Tool | undefined; list(): Tool[]; specs(): ToolSpec[] };
// src/tools/builtin/index.ts
export function registerBuiltinTools(): void;
// src/tools/custom.ts – tool.json + handler.js in OPFS /tools/<name>/ ; handler runs in a sandboxed Worker with 30 s timeout
export const customTools: { list(): Promise<Array<{ name: string; spec: ToolSpec; flags: ToolFlags; handler: string }>>; save(name: string, spec: ToolSpec, flags: ToolFlags, handler: string): Promise<void>; remove(name: string): Promise<void>; loadAll(): Promise<void> };
// src/tools/schedule.ts – jobs in sqlite, timer loop, fires alert/tool
export const scheduler: { start(): void; add(job: { name: string; at?: string; everySec?: number; action: { tool: string; args: Record<string, unknown> } }): Promise<string>; list(): Promise<any[]>; cancel(id: string): Promise<void> };
// src/tools/documents.ts – anydoc wasm
export const documents: { add(file: File): Promise<{ id: string; name: string; chars: number }>; list(): Promise<Array<{ id: string; name: string; chars: number; addedAt: string }>>; get(id: string): Promise<string>; search(q: string): Promise<Array<{ id: string; name: string; snippet: string }>>; remove(id: string): Promise<void> };
// src/core/orchestrator.ts
export const orchestrator: { runTurn(input: string, opts?: { images?: string[]; silent?: boolean }): Promise<string>; abort(): void; busy(): boolean; newSession(): Promise<string>; sessionId(): string };
```

### Storage and extensions

```ts
// src/storage/db.ts – sqlite.worker.ts with opfs-sahpool VFS, fallback :memory:
export const db: DbApi; export function initDb(): Promise<void>;
// src/storage/opfs.ts
export const opfs: { readText(path: string): Promise<string | null>; writeText(path: string, text: string): Promise<void>; list(dir: string): Promise<string[]>; remove(path: string): Promise<void>; mkdir(dir: string): Promise<void> };
// src/storage/memory.ts
export const memory: { remember(text: string, tags?: string[]): Promise<void>; recall(q: string, limit?: number): Promise<string[]>; forget(q: string): Promise<number>; all(): Promise<Array<{ id: number; text: string; createdAt: string }>> };
// src/storage/transcripts.ts
export const transcripts: { newSession(title?: string): Promise<string>; append(sessionId: string, m: ChatMessage): Promise<void>; load(sessionId: string): Promise<ChatMessage[]>; sessions(): Promise<Array<{ id: string; title: string; updatedAt: string }>>; exportMarkdown(sessionId: string): Promise<string> };
// src/extensions/skills.ts – SKILL.md folders in OPFS /skills/<name>/SKILL.md ; frontmatter: name, description, triggers (comma list)
export const skills: { list(): Promise<Array<{ name: string; description: string; triggers: string[] }>>; get(name: string): Promise<string>; save(name: string, markdown: string): Promise<void>; remove(name: string): Promise<void>; match(text: string): Promise<string[]>; installFromUrl(url: string): Promise<string> };
// src/extensions/mcp.ts – @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport; registers tools as `${serverId}__${toolName}` with flags.mcp = serverId
export const mcp: { connectAll(): Promise<void>; connect(cfg: McpServerConfig): Promise<{ tools: number }>; disconnect(id: string): Promise<void>; status(id: string): 'connected' | 'error' | 'off'; test(cfg: McpServerConfig): Promise<{ ok: boolean; tools: string[]; error?: string }> };
// src/extensions/marketplace.ts
export const marketplace: { sources: Array<{ id: string; label: string; url: string }>; search(q: string, sourceId?: string): Promise<Array<{ name: string; description: string; source: string; installUrl: string; pageUrl: string }>> };
```

## Cross-cutting rules

- **Events**: import `bus` from `src/core/bus.ts`; the `AppEvent` union lists every event. UI subscribes; modules emit. Never import UI from modules.
- **Settings**: `getSettings()` / `saveSettings()` only. No other localStorage keys except `va.*` prefixed and documented in a comment.
- **Errors**: throw `Error` with a human sentence; the orchestrator turns it into spoken text. Never swallow.
- **Spoken feedback** (BRD PF-1..8): orchestrator says an acknowledgement within 500 ms of the utterance (pick by intent keyword: search/look up → "Let me search for that", open/run/create → "On it", read/summarise/describe → "Let me look at that", default rotate "On it" / "One moment" / "Working on it"), heartbeat every `feedback.heartbeatSec` ("Still working on it, I am <stage>"), on failure "That broke, trying again" with 2/5/10 s backoff, after `feedback.maxRetries` "I will stop trying now. Ask me again when you want me to retry." Tool `spoken` label is said before the tool runs. Filler never goes into the model transcript.
- **Tool-call formats**: local LFM2.5 emits `<|tool_call_start|>[name(arg="v", n=1)]<|tool_call_end|>`; the local provider parses this into `ToolCall[]` (Python literal args: strings, numbers, booleans, lists, dicts). Cloud uses OpenAI `tool_calls`. Orchestrator never sees raw markup.
- **Max 6 tool hops per turn**, tool results truncated to 8k chars.
- **Style**: small files, plain functions, no classes unless state demands it, no `any` at module boundaries, comments only where behaviour is non-obvious. No frameworks beyond Preact.
