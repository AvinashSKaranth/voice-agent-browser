import type { Page } from '@playwright/test';

// Merged onto DEFAULT_SETTINGS by getSettings()'s deepMerge, so only fields that differ from the
// defaults need to be listed here.
const BASE_OVERRIDES = {
  setupDone: true,
  mode: 'cloud',
  activeProviderId: 'mock',
  providers: [
    {
      id: 'mock',
      label: 'Mock',
      baseUrl: 'https://mock.local/v1',
      apiKey: 'k',
      model: 'mock-1',
      supportsImages: true,
      supportsTools: true,
      enabled: true,
    },
  ],
  wake: { enabled: false, phrase: 'hey_jarvis', threshold: 0.5, pushToTalk: true },
};

/** Seeds va.settings in localStorage before the app boots, so it lands on the assistant/settings/
 * extensions/documents pages instead of the setup wizard. */
export async function seedSettings(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  const settings = { ...BASE_OVERRIDES, ...overrides };
  // addInitScript re-runs on every navigation in this page, including page.reload() - only seed
  // when nothing is stored yet, so a test that changes a setting and reloads to check persistence
  // doesn't have its change clobbered back to the seed on the very reload it's testing.
  await page.addInitScript((s) => {
    if (!localStorage.getItem('va.settings')) localStorage.setItem('va.settings', JSON.stringify(s));
  }, settings);
}

/** Aborts requests to the model hosts so STT/TTS/local-LLM downloads never happen in e2e runs. */
export async function blockModelDownloads(page: Page): Promise<void> {
  await page.route('https://huggingface.co/**', (route) => route.abort());
  await page.route('https://cdn-lfs*/**', (route) => route.abort());
}

function sseBody(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/** SSE body for a single-hop tool call to `calculator({ expression: "18% of 4250" })`. */
export function toolCallSse(): string {
  return sseBody({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'calculator', arguments: JSON.stringify({ expression: '18% of 4250' }) } }] },
        finish_reason: 'tool_calls',
      },
    ],
  });
}

/** SSE body for a plain content reply. */
export function contentSse(text: string): string {
  return sseBody({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });
}

export interface MockProviderRequest {
  messages: Array<{ role: string; [k: string]: unknown }>;
}

/** Routes the mock provider's chat/completions endpoint: first call returns a `calculator` tool
 * call, every call after that returns plain text. Returns the array of parsed request bodies so
 * tests can assert on what the orchestrator sent (e.g. the tool-result follow-up message). */
export async function mockToolCallThenAnswer(page: Page, answerText: string): Promise<MockProviderRequest[]> {
  const requests: MockProviderRequest[] = [];
  await page.route('https://mock.local/v1/chat/completions', async (route) => {
    requests.push(route.request().postDataJSON());
    const body = requests.length === 1 ? toolCallSse() : contentSse(answerText);
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return requests;
}

/** Routes the mock provider's chat/completions endpoint to always fail with HTTP 429. */
export async function mockRateLimited(page: Page): Promise<void> {
  await page.route('https://mock.local/v1/chat/completions', async (route) => {
    await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'rate limited' } }) });
  });
}
