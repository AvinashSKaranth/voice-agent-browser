// Shipped provider presets (BRD.md "Provider roster") plus live model listing/selection.
import type { ProviderConfig } from '../core/types';
import { listOllamaModels } from './ollama';

type Preset = Omit<ProviderConfig, 'apiKey' | 'enabled'> & { needsKey: boolean; note: string; docsUrl: string };

// Every preset other than openrouter/nim ships with model: '' — pickDefaultModel() fills it in
// from the provider's live /models list (vision required if any exist, then free, then first).
export const PROVIDER_PRESETS: Preset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: '20 req/min on :free models (50/day, 1000/day after $10 lifetime credit); CORS enabled.',
    docsUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    supportsImages: true,
    supportsTools: true,
    viaBridge: true,
    needsKey: true,
    note: 'No CORS from the browser; routed through the bridge proxy. Free key, ~40 req/min.',
    docsUrl: 'https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: 'Browser direct, CORS enabled.',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: 'Browser direct via anthropic-dangerous-direct-browser-access header.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: 'Generous free tier; browser direct.',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: 'Very fast decode; browser direct (verify CORS).',
    docsUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: 'Free experiment tier; CORS unverified.',
    docsUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: 'Browser direct, CORS enabled.',
    docsUrl: 'https://console.x.ai',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: '',
    supportsImages: false,
    supportsTools: true,
    needsKey: true,
    note: 'Text only, no vision; cheapest text fallback. CORS unverified.',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: true,
    note: 'Many open models; CORS unverified.',
    docsUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    supportsImages: true,
    supportsTools: true,
    needsKey: false,
    note: 'Set OLLAMA_ORIGINS=https://<user>.github.io and restart Ollama; Chrome may prompt for local-network access.',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
  },
];

const VISION_HINTS = [
  'vision', 'vl', 'omni', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'claude', 'gemini', 'pixtral',
  'llava', 'llama-4', 'qwen2.5-vl', 'gemma-3', 'gemma-4', 'scout', 'maverick',
];

function looksVisionCapable(id: string): boolean {
  const s = id.toLowerCase();
  return VISION_HINTS.some((h) => s.includes(h));
}

interface OpenRouterModel {
  id: string;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string };
}

export async function listModels(cfg: ProviderConfig): Promise<Array<{ id: string; vision?: boolean; free?: boolean }>> {
  if (cfg.id === 'ollama') return listOllamaModels(cfg.baseUrl);

  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/models`, { headers });
  } catch (e) {
    if (e instanceof TypeError) throw new Error('Browser cannot reach this endpoint directly (CORS). Use the bridge or a proxy.');
    throw e;
  }
  if (!res.ok) throw new Error(`Failed to list models (${res.status} ${res.statusText}).`);

  const json = (await res.json()) as { data?: OpenRouterModel[] };
  const list = json.data ?? [];

  if (cfg.id === 'openrouter') {
    return list.map((m) => ({
      id: m.id,
      vision: !!m.architecture?.input_modalities?.includes('image'),
      free: m.pricing?.prompt === '0',
    }));
  }
  return list.map((m) => ({ id: m.id, vision: looksVisionCapable(m.id) }));
}

// Rule: vision-capable required if any exist, then cheapest/free, then just the first one.
export function pickDefaultModel(cfg: ProviderConfig, models: Array<{ id: string; vision?: boolean; free?: boolean }>): string {
  if (!models.length) return cfg.model;
  let pool = models;
  const withVision = pool.filter((m) => m.vision);
  if (withVision.length) pool = withVision;
  const free = pool.filter((m) => m.free);
  if (free.length) pool = free;
  return pool[0].id;
}
