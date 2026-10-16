import { createServer } from 'vite';
import { chromium } from '@playwright/test';
const server = await createServer({ server: { port: 5177, strictPort: true }, logLevel: 'warn' });
await server.listen();
try {
  for (const [target, args] of [['webgpu', ['--force_high_performance_gpu']], ['wasm', []]]) {
    const b = await chromium.launchPersistentContext('bench/asr/.chrome-profile', { channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', ...args] });
    const page = b.pages()[0] ?? await b.newPage();
    page.on('console', (m) => console.log(`[${target}] ${m.text()}`.slice(0, 240)));
    page.on('pageerror', (e) => console.log(`[${target}] PAGEERROR ${e.message}`));
    await page.goto('http://localhost:5177/bench/asr/app-stt.html');
    await page.waitForFunction(() => 'check' in window);
    try { const r = await page.evaluate((d) => window.check(d), target); console.log(`[${target}] load ${r.load_s.toFixed(1)} s`); }
    catch (e) { console.log(`[${target}] FAILED ${e.message}`); }
    await b.close();
  }
} finally { await server.close(); }
