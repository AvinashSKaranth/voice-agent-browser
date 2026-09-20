// Picks the active LlmProvider from settings (local model vs. a configured cloud provider) and
// offers a connection test used by the settings UI's "test connection" button.
import type { LlmProvider, ProviderConfig } from '../core/types';
import { getSettings } from '../core/settings';
import { bus } from '../core/bus';
import { createOpenAiProvider } from './openai-compatible';
import { localProvider, localLlmReady } from './local';

const instanceCache = new Map<string, LlmProvider>();

export function getActiveProvider(): LlmProvider {
  const settings = getSettings();
  if (settings.mode === 'local') return localProvider;

  const cfg = settings.providers.find((p) => p.id === settings.activeProviderId && p.enabled);
  if (!cfg) {
    const reason = localLlmReady() ? 'falling back to the local model.' : 'falling back to the local model, which is still loading.';
    bus.emit({ type: 'toast', level: 'warn', text: `No active cloud provider configured; ${reason}` });
    return localProvider;
  }

  const key = JSON.stringify(cfg);
  let provider = instanceCache.get(key);
  if (!provider) {
    provider = createOpenAiProvider(cfg);
    instanceCache.set(key, provider);
  }
  return provider;
}

export async function testConnection(cfg: ProviderConfig): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
  const provider = createOpenAiProvider(cfg);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const start = performance.now();
  try {
    await provider.generate({
      messages: [{ role: 'user', content: 'Say OK' }],
      tools: [],
      signal: controller.signal,
      onToken: () => {},
      maxTokens: 5,
    });
    return { ok: true, latencyMs: performance.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: performance.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}
