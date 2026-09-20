import type { ChatMessage, ContentPart, GenerateResult, ToolContext } from './types';
import { bus } from './bus';
import { getSettings } from './settings';
import { createFeedback } from './feedback';
import { getActiveProvider } from '../providers/registry';
import { localLlmReady } from '../providers/local';
import { tts } from '../audio/tts';
import { pipeline } from '../audio/pipeline';
import { db } from '../storage/db';
import { transcripts } from '../storage/transcripts';
import { memory } from '../storage/memory';
import { skills } from '../extensions/skills';
import { tools } from '../tools/registry';

const SESSION_KEY = 'va.session';
const MAX_HISTORY_MESSAGES = 30;
const MAX_HISTORY_CHARS = 24000;
const MAX_HOPS = 6;
const TOOL_TIMEOUT_MS = 60000;
const RESULT_TRUNCATE = 8000;

let sid: string | null = null;
try {
  sid = localStorage.getItem(SESSION_KEY);
} catch {
  sid = null;
}
let sidPromise: Promise<string> | null = null;

let currentController: AbortController | null = null;
let running = false;

async function ensureSession(): Promise<string> {
  if (sid) return sid;
  if (!sidPromise) sidPromise = transcripts.newSession().then((id) => (sid = id));
  const id = await sidPromise;
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    /* ignore quota errors */
  }
  return id;
}

/** Switches the active session pointer without creating a new one (used by session_resume). */
export function resumeSession(id: string): void {
  sid = id;
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    /* ignore quota errors */
  }
}

function messageChars(m: ChatMessage): number {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
}

function trimHistory(msgs: ChatMessage[]): ChatMessage[] {
  let trimmed = msgs.slice(-MAX_HISTORY_MESSAGES);
  let total = trimmed.reduce((n, m) => n + messageChars(m), 0);
  while (total > MAX_HISTORY_CHARS && trimmed.length > 1) {
    const idx = trimmed.findIndex((m) => m.role !== 'system');
    if (idx === -1) break;
    total -= messageChars(trimmed[idx]);
    trimmed.splice(idx, 1);
  }
  return trimmed;
}

async function buildSystemPrompt(input: string): Promise<string> {
  const settings = getSettings();
  const parts: string[] = [
    'You are a helpful voice assistant. Answers are spoken aloud: be concise, no markdown, no lists unless asked, plain sentences.',
    `Current date and time: ${new Date().toString()}.`,
  ];
  if (settings.userName) parts.push(`The user's name is ${settings.userName}.`);
  try {
    const matched = await skills.match(input);
    const bodies = await Promise.all(matched.map((name) => skills.get(name)));
    parts.push(...bodies);
  } catch (e) {
    console.warn('skills.match failed', e);
  }
  try {
    const hints = await memory.recall(input, 5);
    if (hints.length) parts.push(`Relevant memory:\n${hints.join('\n')}`);
  } catch (e) {
    console.warn('memory.recall failed', e);
  }
  parts.push('When a tool can answer the request precisely, call it instead of guessing. Keep spoken answers short; put long tables or code only in the visible transcript.');
  return parts.filter(Boolean).join('\n\n');
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function confirmRoundTrip(question: string): Promise<boolean> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const off = bus.on('confirm:answer', (e) => {
      if (e.id !== id || settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve(e.ok);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve(false);
    }, 60000);
    bus.emit({ type: 'confirm:request', id, question });
  });
}

/** Builds a ToolContext bound to `signal`; reused by the orchestrator's own tool loop and by the scheduler. */
export function makeToolContext(signal: AbortSignal): ToolContext {
  return {
    signal,
    speak(text: string) {
      tts.say(text);
    },
    notify(title: string, body?: string) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body });
      } else {
        bus.emit({ type: 'toast', level: 'info', text: body ? `${title}: ${body}` : title });
      }
    },
    provider() {
      return getActiveProvider();
    },
    settings: getSettings(),
    db,
    confirm(question: string) {
      return confirmRoundTrip(question);
    },
  };
}

async function generateWithRetry(
  provider: ReturnType<typeof getActiveProvider>,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken: (text: string) => void,
  fb: ReturnType<typeof createFeedback>
): Promise<GenerateResult> {
  const maxRetries = getSettings().feedback.maxRetries;
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.generate({
        messages,
        tools: provider.supportsTools ? tools.specs() : [],
        signal,
        onToken,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      if (attempt >= maxRetries) {
        fb.giveUp();
        throw e;
      }
      await fb.retry(attempt + 1);
    }
  }
}

export const orchestrator = {
  async runTurn(input: string, opts: { images?: string[]; silent?: boolean } = {}): Promise<string> {
    const { images, silent } = opts;
    const id = crypto.randomUUID();

    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;
    running = true;

    const fb = createFeedback(id);
    bus.emit({ type: 'turn:start', id, input });
    pipeline.setThinking(true);
    if (!silent) fb.ack(input);

    let finalText = '';
    let turnError: string | undefined;
    try {
      const sessionId = await ensureSession();

      const userContent: string | ContentPart[] = images?.length
        ? [{ type: 'text', text: input }, ...images.map((dataUrl): ContentPart => ({ type: 'image', dataUrl }))]
        : input;
      await transcripts.append(sessionId, { role: 'user', content: userContent });

      const systemPrompt = await buildSystemPrompt(input);
      const history = trimHistory(await transcripts.load(sessionId));
      const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history];

      const provider = getActiveProvider();
      if (!silent) fb.heartbeatStart();

      for (let hop = 0; hop < MAX_HOPS; hop++) {
        // Local provider's generate() awaits the model load itself; this just keeps the spoken
        // feedback (and the heartbeat's stage narration) honest about why the first hop is slow.
        if (hop === 0 && provider.id === 'local' && !localLlmReady()) {
          fb.stage('downloading the local model');
          if (!silent) tts.say('The local model is still loading. I will answer as soon as it is ready.');
        } else {
          fb.stage('waiting for the model');
        }

        let sentenceBuf = '';
        const onToken = (text: string) => {
          bus.emit({ type: 'turn:token', id, text });
          if (silent) return;
          sentenceBuf += text;
          const parts = sentenceBuf.split(/(?<=[.!?])[ \n]/);
          if (parts.length > 1) {
            for (let i = 0; i < parts.length - 1; i++) {
              const s = parts[i].trim();
              if (s) tts.say(s);
            }
            sentenceBuf = parts[parts.length - 1];
          }
        };

        let result: GenerateResult;
        try {
          result = await generateWithRetry(provider, messages, controller.signal, onToken, fb);
        } catch (e) {
          turnError = e instanceof Error ? e.message : String(e);
          break;
        }
        if (!silent && sentenceBuf.trim()) tts.say(sentenceBuf.trim());

        if (controller.signal.aborted) {
          finalText = '';
          break;
        }

        if (result.toolCalls.length === 0) {
          finalText = result.text;
          await transcripts.append(sessionId, { role: 'assistant', content: result.text });
          break;
        }

        const assistantMsg: ChatMessage = { role: 'assistant', content: result.text, toolCalls: result.toolCalls };
        messages.push(assistantMsg);
        await transcripts.append(sessionId, assistantMsg);

        for (const call of result.toolCalls) {
          bus.emit({ type: 'turn:tool', id, name: call.name, args: call.args, status: 'start' });
          const tool = tools.get(call.name);

          if (!tool) {
            const content = `Unknown tool: ${call.name}`;
            const toolMsg: ChatMessage = { role: 'tool', content, toolCallId: call.id, name: call.name };
            messages.push(toolMsg);
            await transcripts.append(sessionId, toolMsg);
            bus.emit({ type: 'turn:tool', id, name: call.name, args: call.args, status: 'error', result: content });
            continue;
          }

          if (tool.flags?.confirm) {
            const ok = await confirmRoundTrip(`Run ${tool.spec.name.replace(/_/g, ' ')}?`);
            if (!ok) {
              const content = 'Cancelled by user';
              const toolMsg: ChatMessage = { role: 'tool', content, toolCallId: call.id, name: call.name };
              messages.push(toolMsg);
              await transcripts.append(sessionId, toolMsg);
              bus.emit({ type: 'turn:tool', id, name: call.name, args: call.args, status: 'done', result: content });
              continue;
            }
          }

          if (tool.spoken && !silent && !getSettings().feedback.quiet) tts.say(tool.spoken);
          fb.stage(`running ${tool.spec.name.replace(/_/g, ' ')}`);

          const ctx = makeToolContext(controller.signal);
          let content: string;
          let images2: string[] | undefined;
          try {
            const res = await withTimeout(tool.run(call.args, ctx), TOOL_TIMEOUT_MS, `Tool ${call.name} timed out`);
            content = res.content.slice(0, RESULT_TRUNCATE);
            images2 = res.images;
            bus.emit({ type: 'turn:tool', id, name: call.name, args: call.args, status: res.ok ? 'done' : 'error', result: content });
          } catch (e) {
            content = e instanceof Error ? e.message : String(e);
            bus.emit({ type: 'turn:tool', id, name: call.name, args: call.args, status: 'error', result: content });
          }

          const toolMsg: ChatMessage = {
            role: 'tool',
            content: images2?.length ? [{ type: 'text', text: content }, ...images2.map((d): ContentPart => ({ type: 'image', dataUrl: d }))] : content,
            toolCallId: call.id,
            name: call.name,
          };
          messages.push(toolMsg);
          await transcripts.append(sessionId, toolMsg);
        }
      }
    } catch (e) {
      // Unexpected errors (storage, skills, etc.) - never throw out of runTurn, speak and surface instead.
      turnError = e instanceof Error ? e.message : String(e);
      if (!silent) tts.say(turnError);
    } finally {
      fb.heartbeatStop();
      fb.dispose();
      pipeline.setThinking(false);
      running = false;
      bus.emit({ type: 'turn:end', id, text: finalText, error: turnError });
    }
    return finalText;
  },

  abort(): void {
    currentController?.abort();
    tts.stop();
  },

  busy(): boolean {
    return running;
  },

  async newSession(): Promise<string> {
    const id = await transcripts.newSession();
    sid = id;
    try {
      localStorage.setItem(SESSION_KEY, id);
    } catch {
      /* ignore quota errors */
    }
    return id;
  },

  sessionId(): string {
    return sid ?? '';
  },
};

pipeline.onBargeIn(() => orchestrator.abort());
// Spoken utterances (VAD + STT, or push-to-talk) drive turns exactly like typed input.
pipeline.onUtterance((text) => {
  if (orchestrator.busy()) orchestrator.abort();
  orchestrator.runTurn(text).catch((e: unknown) => bus.emit({ type: 'toast', level: 'error', text: (e as Error).message }));
});
