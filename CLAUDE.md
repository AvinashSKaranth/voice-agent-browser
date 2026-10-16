# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Browser-only voice assistant (no backend): STT, LLM, TTS, VAD and wake word all run client-side in Web Workers; optional cloud LLM providers and MCP servers. Deployed as static files to GitHub Pages.

**Read `ARCHITECTURE.md` before changing code** — it holds the exact module export contracts and cross-cutting rules. `BRD.md` is the product spec (requirement IDs like PF-1..8 are referenced in code/docs).

## Commands

```bash
npm run dev          # Vite dev server, http://localhost:5173
npm run build        # tsc --noEmit + vite build → docs/ (committed; served by GitHub Pages)
npm run typecheck
npm test             # vitest (jsdom), tests/**/*.test.ts
npx vitest run tests/pipeline.test.ts       # single unit test file
npx vitest run -t "name of test"            # single test by name
npm run e2e          # Playwright (chromium), starts its own Vite on port 5175
npx playwright test e2e/assistant.spec.ts   # single e2e spec
```

- `docs/` is build output and is committed — rebuild it when shipping, never hand-edit it.
- Local LLM needs WebGPU (Chrome/Edge 113+); STT/TTS fall back to WASM.

## Architecture essentials

- **Flow**: `audio/mic.ts` (VAD) + `audio/wake.ts` → `audio/pipeline.ts` state machine (wake→listening→thinking→speaking, barge-in) → `core/orchestrator.ts` agent loop → `providers/registry.ts` (local LFM2.5 worker or OpenAI-compatible cloud) ↔ `tools/registry.ts` → `audio/tts.ts`.
- **Events**: modules emit on `core/bus.ts` (`AppEvent` union in `core/types.ts`); UI subscribes. Modules never import UI.
- **`src/core/types.ts` is frozen**: add types, never rename.
- **Tool calls**: local provider parses LFM2.5 `<|tool_call_start|>[name(arg="v")]<|tool_call_end|>` (Python-literal args) into `ToolCall[]`; cloud uses OpenAI `tool_calls`. Orchestrator never sees raw markup. Max 6 tool hops/turn, results truncated to 8k chars.
- **Spoken feedback** (acks, heartbeat, retry/backoff) lives in `core/feedback.ts` + orchestrator; filler never enters the model transcript.
- **MCP tools** register as `${serverId}__${toolName}` with `flags.mcp = serverId`.
- **Storage**: settings in `localStorage` via `getSettings()`/`saveSettings()` only (other keys must be `va.*` and documented). SQLite (memory, transcripts, documents, schedules) runs in `sqlite.worker.ts` on the `opfs-sahpool` VFS with `:memory:` fallback; the pool is released on `pagehide`/unload so reloads keep persistent storage. Skills (`/skills/<name>/SKILL.md`) and custom tools (`/tools/<name>/`) are OPFS folders.
- **UI**: Preact, hand-rolled hash routes in `ui/App.tsx` (`#/`, `#/setup`, `#/assistant`, `#/settings`, `#/extensions`, `#/documents`, `#/logs`, `#/bench`). Routes other than landing/setup redirect to `#/` until `settings.setupDone`, so pages don't start model downloads early.

## Hard constraints

- GitHub Pages: no COOP/COEP → no SharedArrayBuffer, ORT single-threaded, sqlite must use opfs-sahpool in a worker.
- `base: './'`: never use absolute `/` URLs at runtime. Use `new URL('./x', import.meta.url)`; workers via `new Worker(new URL('../workers/x.worker.ts', import.meta.url), { type: 'module' })`.
- VAD/ORT assets are copied by `vite-plugin-static-copy` (`./vad/`, `./ort/`); wake-word models in `public/models/oww/`.
- `onnxruntime-node` is kept external (kitten-tts-js tries it first, falls back to onnxruntime-web). See comments in `vite.config.ts` before touching `optimizeDeps`.
- Don't add dependencies without a comment explaining why.
- Errors: throw `Error` with a human sentence (orchestrator speaks it); never swallow.
- Style: small files, plain functions, no classes unless state demands it, no `any` at module boundaries, no frameworks beyond Preact.

## Testing notes

- Some `src/` modules contain `if (import.meta.env.DEV) { console.assert(...) }` self-check blocks; vitest forces `DEV=false` so they don't run in unit tests.
- E2E tests (`e2e/helpers.ts`) seed settings into localStorage (merged onto defaults), block model downloads, and mock a cloud provider via SSE responses — use `seedSettings`, `blockModelDownloads`, `mockToolCallThenAnswer` rather than loading real models. Chromium runs with fake media stream flags.
