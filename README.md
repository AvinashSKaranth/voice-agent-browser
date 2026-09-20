# Voice Agent (browser)

Voice assistant that runs entirely in the browser: whisper-base (speech to text), LFM2.5-VL-3B (reasoning, tool calls, images), Kokoro (speech), Silero VAD and openWakeWord ("Hey Jarvis"). Optional cloud providers (OpenRouter, NVIDIA NIM, OpenAI, Anthropic, Gemini, Groq, Mistral, xAI, DeepSeek, Together, Ollama, custom endpoints), MCP servers (TinyFish search, fetch and browser automation), skills, custom tools, schedules and alerts.

Spec: [BRD.md](BRD.md). Module contracts: [ARCHITECTURE.md](ARCHITECTURE.md).

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:5173. WebGPU (Chrome or Edge 113+) is required for the local LLM; speech to text and text to speech fall back to WASM.

## Build and deploy (GitHub Pages)

```bash
npm run build
```

Output goes to `docs/` with relative asset paths. In the repository settings choose Pages → Source: "Deploy from a branch", branch `main`, folder `/docs`.

Model weights are downloaded from Hugging Face on first use and cached by the browser (Cache API). Settings live in `localStorage`; memory, transcripts, documents and schedules in SQLite (OPFS); skills and custom tools in OPFS folders.

## Ollama

Ollama only accepts localhost origins by default. Run once and restart Ollama:

```bash
setx OLLAMA_ORIGINS "https://<your-user>.github.io"
```

Chrome 142+ shows a "local network access" prompt the first time the page calls `http://localhost:11434`. Accept it.

## Layout

- `src/core` – contracts, event bus, settings, orchestrator (agent loop), spoken feedback, bridge client
- `src/workers` – one Web Worker per model (STT, LLM, TTS, wake word) plus SQLite
- `src/audio` – microphone + VAD, wake word, playback, voice pipeline state machine
- `src/providers` – local model provider, OpenAI-compatible cloud providers, presets, Ollama
- `src/tools` – tool registry, built-in tools, custom tools sandbox, scheduler, documents (anydoc WASM)
- `src/storage` – SQLite worker, OPFS helpers, memory, transcripts
- `src/extensions` – skills (SKILL.md), MCP client, marketplace search
- `src/ui` – Preact pages: landing, setup wizard, assistant, settings, extensions, documents
