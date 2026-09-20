import { useEffect, useState } from 'preact/hooks';
import { Card } from './components';

const CAPABILITIES = ['Local models', 'Cloud providers', 'Tools', 'Skills', 'MCP', 'Coding agents'];

export function Landing() {
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    setWebgpu(!!(navigator as unknown as { gpu?: unknown }).gpu);
    navigator.storage
      ?.estimate?.()
      .then((e) => setStorage({ usage: e.usage || 0, quota: e.quota || 0 }))
      .catch(() => {});
  }, []);

  const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

  return (
    <div class="landing">
      <section class="hero">
        <h1>Talk to your computer.</h1>
        <p class="lede">Everything runs in your browser.</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="#/setup">
            Get started
          </a>
          <a class="btn btn-ghost" href="#/setup?step=3">
            Skip to cloud setup
          </a>
        </div>
      </section>

      <section class="how-it-works">
        <div class="step">
          <span class="step-num">1</span>
          <p>Download models once</p>
        </div>
        <div class="step">
          <span class="step-num">2</span>
          <p>Say "Hey Jarvis"</p>
        </div>
        <div class="step">
          <span class="step-num">3</span>
          <p>It searches, reads, calculates, schedules and, with the optional bridge, drives your terminal</p>
        </div>
      </section>

      <section class="capability-grid">
        {CAPABILITIES.map((c) => (
          <div class="capability-card" key={c}>
            {c}
          </div>
        ))}
      </section>

      <Card class="device-check">
        <h2>Device check</h2>
        <ul>
          <li>WebGPU: {webgpu === null ? 'Checking…' : webgpu ? 'Available' : 'Not available'}</li>
          <li>Free storage: {storage ? `${gb(storage.quota - storage.usage)} of ${gb(storage.quota)}` : 'Checking…'}</li>
          <li>GPU memory: unknown to the browser — the local model needs roughly 4 GB</li>
        </ul>
        <p class="verdict">
          {webgpu === null
            ? ''
            : webgpu
              ? 'This machine can run the local model.'
              : 'No WebGPU detected on this browser — use a cloud provider for the best experience.'}
        </p>
      </Card>

      <section>
        <h2>FAQ</h2>
        <p>
          <strong>Download size:</strong> the local model, speech-to-text and voice together are about 2.7 GB, cached once. <strong>Browsers:</strong>{' '}
          a recent Chrome or Edge works best; WebGPU is optional. <strong>Offline:</strong> once models are cached, local mode works with no
          connection. <strong>Keys:</strong> API keys are stored only in this browser's local storage, never sent anywhere but the provider you
          chose.
        </p>
      </section>

      <p class="privacy-note">
        Your audio, documents and conversation stay on this device unless you choose a cloud provider or a tool that calls the network.
      </p>
    </div>
  );
}
