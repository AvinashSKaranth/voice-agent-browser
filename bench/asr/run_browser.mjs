// Runs browser.html in real Chrome (WebGPU on) for each model/device and saves raw results.
// Usage (repo root): node bench/asr/run_browser.mjs [model[/device] ...]
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const CONFIGS = ['whisper-base', 'canary-180m-flash', 'parakeet-redux', 'phonon-2'].flatMap((m) => ['webgpu-igpu', 'webgpu-dgpu', 'wasm'].map((d) => `${m}/${d}`)).concat('phonon-2-c/wasm');
const wanted = process.argv.slice(2);
const runs = CONFIGS.filter((c) => !wanted.length || wanted.some((w) => c.startsWith(w)));
const OUT = 'bench/asr/results/browser.json';

const server = await createServer({ server: { port: 5176, strictPort: true }, logLevel: 'warn' });
await server.listen();
mkdirSync('bench/asr/results', { recursive: true });
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
try {
  for (const cfg of runs) {
    const [model, target] = cfg.split('/');
    const device = target.startsWith('webgpu') ? 'webgpu' : 'wasm';
    // Headed: Chrome on Windows only exposes the real GPU adapter to a visible window. On this hybrid
    // laptop Chrome defaults to the integrated GPU; --force_high_performance_gpu picks the discrete one.
    const args = ['--enable-unsafe-webgpu', ...(target === 'webgpu-dgpu' ? ['--force_high_performance_gpu'] : [])];
    // Persistent profile so the HTTP/Cache API copies of the model files survive between launches.
    const browser = await chromium.launchPersistentContext('bench/asr/.chrome-profile', { channel: 'chrome', headless: false, args });
    const page = browser.pages()[0] ?? await browser.newPage();
    page.on('console', (m) => console.log(`[${cfg}] ${m.text()}`));
    await page.goto('http://localhost:5176/bench/asr/browser.html', { timeout: 180000 });
    await page.waitForFunction(() => 'bench' in window, null, { timeout: 120000 });
    const adapter = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a ? `${a.info?.vendor ?? ''} ${a.info?.architecture ?? ''} ${a.info?.description ?? ''}`.trim() : null;
    });
    try {
      const r = await page.evaluate(([m, d]) => window.bench(m, d), [model, device]);
      results[cfg] = { ...r, target, gpu_adapter: adapter };
    } catch (e) {
      results[cfg] = { model, device, target, error: String(e.message ?? e), gpu_adapter: adapter };
      console.error(`[${cfg}] FAILED: ${e.message ?? e}`);
    }
    writeFileSync(OUT, JSON.stringify(results, null, 1));
    await browser.close();
  }
} finally {
  await server.close();
}
