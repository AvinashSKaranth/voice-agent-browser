// LLM worker: LiquidAI LFM2.5-VL-3B via @huggingface/transformers (AutoModelForImageTextToText).
// WebGPU only — the q4 decoder is unsupported on wasm. Streams raw text (tool-call markup included);
// src/providers/local.ts strips markup and parses tool calls.
import {
  AutoModelForImageTextToText,
  AutoProcessor,
  TextStreamer,
  InterruptableStoppingCriteria,
  load_image,
  type RawImage,
  type PreTrainedModel,
  type Processor,
} from '@huggingface/transformers';
import type { LlmIn, LlmOut, ChatMessage, ToolCall, ToolSpec, ContentPart } from '../core/types';

const MODEL_ID = 'LiquidAI/LFM2.5-VL-3B-ONNX';

let processor: Processor | null = null;
let model: PreTrainedModel | null = null;
let loading: Promise<void> | null = null;
const stopping = new InterruptableStoppingCriteria();
let activeId: string | null = null;
let currentGen: Promise<void> | null = null;

function post(msg: LlmOut): void {
  (self as unknown as { postMessage(m: LlmOut): void }).postMessage(msg);
}

function onProgress(p: unknown): void {
  const info = p as { status: string; file?: string; loaded?: number; total?: number };
  if (info.status === 'progress') {
    post({ type: 'progress', file: info.file, loaded: info.loaded ?? 0, total: info.total ?? 0, status: 'downloading' });
  } else if (info.status === 'initiate' || info.status === 'download') {
    post({ type: 'progress', file: info.file, loaded: 0, total: 0, status: 'downloading' });
  } else if (info.status === 'done') {
    post({ type: 'progress', file: info.file, loaded: 1, total: 1, status: 'downloading' });
  }
}

async function load(): Promise<void> {
  if (model) return;
  if (loading) return loading;
  loading = (async () => {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new Error('WebGPU not available');
    }
    processor = (await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: onProgress })) as Processor;
    model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
      device: 'webgpu',
      dtype: { embed_tokens: 'fp16', decoder_model_merged: 'q4', vision_encoder: 'fp16' },
      progress_callback: onProgress,
    });
    post({ type: 'progress', loaded: 1, total: 1, status: 'ready' });
  })();
  try {
    await loading;
  } catch (e) {
    loading = null;
    post({ type: 'progress', loaded: 0, total: 0, status: 'error', error: (e as Error).message });
    throw e;
  }
}

// ---------- message / tool-call text rendering (mirror of the parser in providers/local.ts) ----------

function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `"${k}": ${pyLiteral(val)}`)
      .join(', ')}}`;
  }
  return String(v);
}

function renderToolCalls(calls: ToolCall[]): string {
  const body = calls
    .map((c) => `${c.name}(${Object.entries(c.args).map(([k, v]) => `${k}=${pyLiteral(v)}`).join(', ')})`)
    .join(', ');
  return `<|tool_call_start|>[${body}]<|tool_call_end|>`;
}

type TemplateContent = { type: string; text?: string };
type TemplateMessage = { role: string; content: string | TemplateContent[] };

function toTemplateMessages(messages: ChatMessage[]): TemplateMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: contentToText(m.content) };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const base = contentToText(m.content);
      return { role: 'assistant', content: `${base ? base + '\n' : ''}${renderToolCalls(m.toolCalls)}` };
    }
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: m.content.map((p) => (p.type === 'image' ? { type: 'image' } : { type: 'text', text: p.text })),
    };
  });
}

function collectImageUrls(messages: ChatMessage[]): string[] {
  const urls: string[] = [];
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === 'image') urls.push(p.dataUrl);
    }
  }
  return urls;
}

async function loadCappedImage(dataUrl: string): Promise<RawImage> {
  const img = await load_image(dataUrl);
  const longEdge = Math.max(img.width, img.height);
  if (longEdge <= 1024) return img;
  const scale = 1024 / longEdge;
  return img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
}

function toolListText(tools: ToolSpec[]): string {
  const arr = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return `<|tool_list_start|>${JSON.stringify(arr)}<|tool_list_end|>`;
}

function withToolsInSystemPrompt(msgs: TemplateMessage[], tools: ToolSpec[]): TemplateMessage[] {
  const list = toolListText(tools);
  const idx = msgs.findIndex((m) => m.role === 'system');
  if (idx >= 0) {
    const text = contentToText(msgs[idx].content as string | ContentPart[]);
    const next = [...msgs];
    next[idx] = { role: 'system', content: `${text}\nList of tools: ${list}` };
    return next;
  }
  return [{ role: 'system', content: `List of tools: ${list}` }, ...msgs];
}

function buildPrompt(templateMsgs: TemplateMessage[], tools: ToolSpec[]): string {
  const applyTemplate = (proc: Processor) =>
    proc.apply_chat_template as unknown as (
      messages: TemplateMessage[],
      options?: Record<string, unknown>,
    ) => string;
  if (tools.length > 0) {
    try {
      const rendered = applyTemplate(processor!)(templateMsgs, {
        add_generation_prompt: true,
        tokenize: false,
        tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      });
      if (rendered.includes('<|tool_list_start|>')) return rendered;
    } catch {
      /* fall through to manual system-prompt injection */
    }
    return applyTemplate(processor!)(withToolsInSystemPrompt(templateMsgs, tools), {
      add_generation_prompt: true,
      tokenize: false,
    });
  }
  return applyTemplate(processor!)(templateMsgs, { add_generation_prompt: true, tokenize: false });
}

// ---------- generation ----------

async function runGenerate(msg: Extract<LlmIn, { type: 'generate' }>): Promise<void> {
  const { id, messages, tools, maxTokens, temperature } = msg;
  stopping.reset();
  let fullText = '';
  try {
    await load();
    const templateMsgs = toTemplateMessages(messages);
    const prompt = buildPrompt(templateMsgs, tools);
    const imageUrls = collectImageUrls(messages);
    const images = await Promise.all(imageUrls.map(loadCappedImage));

    const inputs =
      images.length > 0
        ? await (processor as unknown as (i: RawImage | RawImage[], t: string, o: Record<string, unknown>) => Promise<Record<string, unknown>>)(
            images.length === 1 ? images[0] : images,
            prompt,
            { add_special_tokens: false },
          )
        : ((await processor!.tokenizer!(prompt, { add_special_tokens: false })) as unknown as Record<string, unknown>);

    let tokenCount = 0;
    const streamer = new TextStreamer(processor!.tokenizer!, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        fullText += text;
        post({ type: 'token', id, text });
      },
      token_callback_function: () => {
        tokenCount++;
      },
    });

    const maxNewTokens = maxTokens ?? 512;
    await model!.generate({
      ...inputs,
      do_sample: false,
      temperature: temperature ?? 0.2,
      top_k: 50,
      repetition_penalty: 1.05,
      max_new_tokens: maxNewTokens,
      streamer,
      stopping_criteria: stopping,
    });

    const finishReason: 'stop' | 'length' | 'aborted' = stopping.interrupted ? 'aborted' : tokenCount >= maxNewTokens ? 'length' : 'stop';
    post({ type: 'done', id, text: fullText, finishReason });
  } catch (e) {
    post({ type: 'error', id, error: (e as Error).message });
  } finally {
    if (activeId === id) activeId = null;
  }
}

self.onmessage = async (ev: MessageEvent<LlmIn>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    try {
      await load();
    } catch {
      /* error already posted */
    }
    return;
  }
  if (msg.type === 'abort') {
    if (msg.id === activeId) stopping.interrupt();
    return;
  }
  if (msg.type === 'generate') {
    activeId = msg.id; // set before awaiting the previous generation so an abort for this id isn't dropped
    if (currentGen) {
      // ponytail: single-flight worker, interrupt the in-flight turn before starting the next one.
      stopping.interrupt();
      await currentGen.catch(() => {});
    }
    currentGen = runGenerate(msg).finally(() => {
      currentGen = null;
    });
  }
};
