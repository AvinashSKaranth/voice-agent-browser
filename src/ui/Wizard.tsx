import { useEffect, useState } from 'preact/hooks';
import { getSettings, saveSettings } from '../core/settings';
import { bus } from '../core/bus';
import type { ModelName, ProviderConfig, Settings } from '../core/types';
import { Button, Card, CopyButton, Field, ProgressBar, ProviderForm, VoiceSettings, WakeWordSettings } from './components';
import type { ProviderModel, ProviderTestResult } from './components';
import { stt } from '../audio/stt';
import { tts } from '../audio/tts';
import { wake } from '../audio/wake';
import { pipeline } from '../audio/pipeline';
import { loadLocalLlm } from '../providers/local';
import { PROVIDER_PRESETS, listModels, pickDefaultModel } from '../providers/roster';
import { listOllamaModels } from '../providers/ollama';
import { testConnection } from '../providers/registry';

const STEP_LABELS = ['Welcome', 'Brain', 'Provider', 'Models', 'TinyFish', 'Voice', 'Wake word', 'Done'];

function hasWebGpu() {
  return !!(navigator as unknown as { gpu?: unknown }).gpu;
}

export function Wizard(props: { initialStep?: number }) {
  const [step, setStep] = useState(props.initialStep && props.initialStep >= 1 && props.initialStep <= 8 ? props.initialStep : 1);
  const [settings, setSettings] = useState<Settings>(getSettings());

  function update(patch: Partial<Settings> | ((s: Settings) => Settings)) {
    setSettings(saveSettings(patch));
  }

  function goTo(s: number) {
    location.hash = `#/setup?step=${s}`;
    setStep(s);
  }
  function next() {
    goTo(Math.min(8, step + 1));
  }
  function back() {
    goTo(Math.max(1, step - 1));
  }
  function finish() {
    update({ setupDone: true });
    location.hash = '#/assistant';
  }

  const skippable = (step === 3 && settings.mode === 'local') || step === 5 || step === 7;

  let body;
  switch (step) {
    case 1:
      body = <Step1Welcome />;
      break;
    case 2:
      body = <Step2Brain settings={settings} update={update} />;
      break;
    case 3:
      body = <Step3Provider settings={settings} update={update} />;
      break;
    case 4:
      body = <Step4Models settings={settings} />;
      break;
    case 5:
      body = <Step5TinyFish settings={settings} update={update} />;
      break;
    case 6:
      body = (
        <VoiceSettings
          value={settings.voice}
          engine={settings.local.ttsEngine}
          onEngineChange={(engine) => update({ local: { ...settings.local, ttsEngine: engine } })}
          onChange={(v) => update({ voice: v })}
          onPreview={() => tts.load().then(() => tts.say('Hi, I am your assistant. How can I help?')).catch((e: Error) => bus.emit({ type: 'toast', level: 'error', text: e.message }))}
        />
      );
      break;
    case 7:
      body = <Step7Wake settings={settings} update={update} />;
      break;
    case 8:
      body = <Step8Done settings={settings} />;
      break;
  }

  return (
    <div class="wizard card">
      <ProgressBar value={step} max={8} label={`Step ${step} of 8: ${STEP_LABELS[step - 1]}`} />
      <div class="wizard-step">{body}</div>
      <div class="wizard-nav">
        <Button variant="ghost" onClick={back} disabled={step === 1}>
          Back
        </Button>
        <div class="row">
          {skippable && (
            <Button variant="ghost" onClick={next}>
              Skip
            </Button>
          )}
          {step < 8 ? <Button onClick={next}>Next</Button> : <Button onClick={finish}>Open assistant</Button>}
        </div>
      </div>
    </div>
  );
}

// ---------- Step 1: Welcome + device check + mic + persistent storage ----------
function Step1Welcome() {
  const [webgpu] = useState(hasWebGpu());
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  async function requestMic() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMicOk(true);
    } catch {
      setMicOk(false);
      bus.emit({ type: 'toast', level: 'error', text: 'Microphone permission denied.' });
    }
  }

  async function requestPersist() {
    try {
      const ok = (await navigator.storage?.persist?.()) ?? false;
      setPersisted(ok);
    } catch {
      setPersisted(false);
    }
  }

  async function requestNotifications() {
    try {
      setNotifPerm(await Notification.requestPermission());
    } catch {
      setNotifPerm('denied');
    }
  }

  return (
    <div>
      <h2>Welcome</h2>
      <p>Let's get your assistant set up. Nothing here needs an account, and closing the tab keeps your progress.</p>
      <p class="field-hint">Why we ask: the assistant needs a microphone to hear you, persistent storage so downloaded models survive a browser restart, and notification permission to alert you when a scheduled job fires.</p>
      <ul>
        <li>WebGPU: {webgpu ? 'available' : 'not available'}</li>
        <li>Microphone: {micOk === null ? 'not checked' : micOk ? 'granted' : 'denied'}</li>
        <li>Persistent storage: {persisted === null ? 'not requested' : persisted ? 'granted' : 'not granted'}</li>
        <li>Notifications: {notifPerm}</li>
      </ul>
      <div class="row">
        <Button onClick={requestMic}>Allow microphone</Button>
        <Button variant="ghost" onClick={requestPersist}>
          Request persistent storage
        </Button>
        <Button variant="ghost" onClick={requestNotifications} disabled={notifPerm === 'unsupported'}>
          Allow notifications
        </Button>
      </div>
    </div>
  );
}

// ---------- Step 2: Choose brain ----------
function Step2Brain(props: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const webgpu = hasWebGpu();
  const { settings, update } = props;
  const selected: 'local' | 'cloud' | 'both' = settings.mode === 'local' ? (settings.providers.some((p) => p.enabled) ? 'both' : 'local') : 'cloud';

  function choose(kind: 'local' | 'cloud' | 'both') {
    if (kind === 'local') update({ mode: 'local', local: { ...settings.local, llm: true } });
    else if (kind === 'cloud') update({ mode: 'cloud', local: { ...settings.local, llm: false } });
    else update({ mode: 'local', local: { ...settings.local, llm: true } });
  }

  return (
    <div>
      <h2>Choose your brain</h2>
      <p class="field-hint">Why we ask: this decides what downloads now and which model answers by default.</p>
      <div class="brain-cards">
        <Card class={`brain-card ${selected === 'local' ? 'selected' : ''}`}>
          <h3>Local</h3>
          <p>LFM2.5-VL-3B, about 2.5 GB. Needs WebGPU and roughly 4 GB of GPU memory. Fully private.</p>
          {!webgpu && <p class="test-error">No WebGPU detected on this browser.</p>}
          <Button onClick={() => choose('local')}>Choose local</Button>
        </Card>
        <Card class={`brain-card ${selected === 'cloud' ? 'selected' : ''}`}>
          <h3>Cloud</h3>
          <p>No download. Pick a provider in the next step.</p>
          <Button onClick={() => choose('cloud')}>Choose cloud</Button>
        </Card>
        <Card class={`brain-card ${selected === 'both' ? 'selected' : ''}`}>
          <h3>Both</h3>
          <p>Local answers by default; add a cloud provider next so you can switch anytime from the Assistant page.</p>
          <Button onClick={() => choose('both')}>Choose both</Button>
        </Card>
      </div>
    </div>
  );
}

// ---------- Step 3: Cloud provider ----------
type PresetProvider = (typeof PROVIDER_PRESETS)[number];

function findProvider(settings: Settings, id: string): ProviderConfig | undefined {
  return settings.providers.find((p) => p.id === id);
}

function upsertProvider(settings: Settings, update: (p: Partial<Settings>) => void, cfg: ProviderConfig) {
  const exists = settings.providers.some((p) => p.id === cfg.id);
  const providers = exists ? settings.providers.map((p) => (p.id === cfg.id ? cfg : p)) : [...settings.providers, cfg];
  update({ providers });
}

function Step3Provider(props: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { settings, update } = props;
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const [fetching, setFetching] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ProviderModel[]>>({});
  const host = location.hostname;
  const ghUser = host.endsWith('.github.io') ? host.split('.')[0] : host;

  // The preset that's "Active" per settings (e.g. the OpenRouter default) needs its ProviderConfig
  // created before its form can render — otherwise the card shows "Active" with no form until the
  // user clicks another card.
  useEffect(() => {
    if (settings.mode === 'cloud' && !findProvider(settings, settings.activeProviderId)) {
      const preset = PROVIDER_PRESETS.find((p) => p.id === settings.activeProviderId);
      if (preset) activate(preset);
    }
  }, []);

  function activate(preset: PresetProvider) {
    let cfg = findProvider(settings, preset.id);
    if (!cfg) {
      cfg = { id: preset.id, label: preset.label, baseUrl: preset.baseUrl, model: preset.model, supportsImages: preset.supportsImages, supportsTools: preset.supportsTools, enabled: true, apiKey: '' };
      upsertProvider(settings, update, cfg);
    } else if (!cfg.enabled) {
      upsertProvider(settings, update, { ...cfg, enabled: true });
    }
    update({ mode: 'cloud', activeProviderId: preset.id });
  }

  function change(cfg: ProviderConfig) {
    upsertProvider(settings, update, cfg);
  }

  async function fetchModels(cfg: ProviderConfig) {
    setFetching(cfg.id);
    try {
      const list = cfg.id === 'ollama' ? await listOllamaModels(cfg.baseUrl) : await listModels(cfg);
      setModels((m) => ({ ...m, [cfg.id]: list }));
      const def = pickDefaultModel(cfg, list);
      if (def) change({ ...cfg, model: def });
    } catch (err) {
      bus.emit({ type: 'toast', level: 'error', text: `Could not fetch models: ${(err as Error).message}` });
    } finally {
      setFetching(null);
    }
  }

  async function test(cfg: ProviderConfig) {
    setTesting(cfg.id);
    try {
      const res = await testConnection(cfg);
      setTestResults((r) => ({ ...r, [cfg.id]: res }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [cfg.id]: { ok: false, error: (err as Error).message, latencyMs: 0 } }));
    } finally {
      setTesting(null);
    }
  }

  const [customCfg, setCustomCfg] = useState<ProviderConfig>({
    id: `custom-${Date.now()}`,
    label: '',
    baseUrl: '',
    model: '',
    supportsImages: false,
    supportsTools: true,
    enabled: false,
    apiKey: '',
  });

  function saveCustom() {
    if (!customCfg.label || !customCfg.baseUrl) {
      bus.emit({ type: 'toast', level: 'error', text: 'Name and base URL are required.' });
      return;
    }
    const cfg = { ...customCfg, enabled: true };
    upsertProvider(settings, update, cfg);
    update({ mode: 'cloud', activeProviderId: cfg.id });
    bus.emit({ type: 'toast', level: 'info', text: 'Custom endpoint saved.' });
  }

  return (
    <div>
      <h2>Add a cloud provider</h2>
      <p class="field-hint">Why we ask: cloud mode needs a reachable, working endpoint before you can chat with it.</p>
      <div class="preset-cards">
        {PROVIDER_PRESETS.map((preset) => {
          const cfg = findProvider(settings, preset.id);
          const isActive = settings.activeProviderId === preset.id && settings.mode === 'cloud';
          return (
            <Card class={`preset-card ${isActive ? 'selected' : ''}`} key={preset.id}>
              <h3>{preset.label}</h3>
              <p class="field-hint">{preset.note}</p>
              <Button variant={isActive ? 'primary' : 'ghost'} onClick={() => activate(preset)}>
                {isActive ? 'Active' : 'Select'}
              </Button>
              {isActive && cfg && (
                <div>
                  <ProviderForm
                    cfg={cfg}
                    onChange={change}
                    docsUrl={preset.docsUrl}
                    models={models[cfg.id]}
                    fetchingModels={fetching === cfg.id}
                    onFetchModels={() => fetchModels(cfg)}
                    testing={testing === cfg.id}
                    testResult={testResults[cfg.id] || null}
                    onTest={() => test(cfg)}
                  />
                  {preset.id === 'ollama' && (
                    <div class="ollama-setup">
                      <p class="field-hint">Run Ollama with browser access allowed, then verify it answers:</p>
                      <div class="row">
                        <code>OLLAMA_ORIGINS=https://{ghUser}.github.io ollama serve</code>
                        <CopyButton text={`OLLAMA_ORIGINS=https://${ghUser}.github.io ollama serve`} />
                      </div>
                      <div class="row">
                        <code>curl http://localhost:11434/api/tags</code>
                        <CopyButton text="curl http://localhost:11434/api/tags" />
                      </div>
                      <p class="field-hint">
                        Chrome may show a "This site wants to access devices on your local network" prompt when connecting to Ollama — click Allow.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <h3>Custom endpoint</h3>
      <ProviderForm cfg={customCfg} onChange={setCustomCfg} editableIdentity />
      <Button onClick={saveCustom}>Save custom endpoint</Button>
    </div>
  );
}

// ---------- Step 4: Download models ----------
function Step4Models(props: { settings: Settings }) {
  const { settings } = props;
  const [progress, setProgress] = useState<Partial<Record<ModelName, { loaded: number; total: number; status: string; error?: string }>>>({});
  const [busy, setBusy] = useState<Partial<Record<ModelName, boolean>>>({});

  useEffect(
    () =>
      bus.on('model:progress', (e) => {
        setProgress((p) => ({ ...p, [e.model]: { loaded: e.loaded, total: e.total, status: e.status, error: e.error } }));
        if (e.status === 'ready' || e.status === 'error') setBusy((b) => ({ ...b, [e.model]: false }));
      }),
    [],
  );

  async function run(model: ModelName, fn: () => Promise<void>) {
    setBusy((b) => ({ ...b, [model]: true }));
    try {
      await fn();
    } catch (err) {
      bus.emit({ type: 'toast', level: 'error', text: `${model} download failed: ${(err as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [model]: false }));
    }
  }

  function mb(n: number) {
    return (n / 1e6).toFixed(1);
  }

  const rows: Array<{ model: ModelName; label: string; onDownload: () => void; show: boolean }> = [
    { model: 'stt', label: 'Speech to text (Whisper)', onDownload: () => run('stt', () => stt.load()), show: true },
    { model: 'tts', label: 'Voice (Kokoro)', onDownload: () => run('tts', () => tts.load()), show: true },
    { model: 'llm', label: 'Local brain (LFM2.5-VL-3B)', onDownload: () => run('llm', () => loadLocalLlm()), show: settings.local.llm },
    { model: 'wake', label: 'Load wake word (3 MB, bundled)', onDownload: () => run('wake', () => wake.load(settings.wake.phrase)), show: settings.wake.enabled },
  ];

  return (
    <div>
      <h2>Download models</h2>
      <p class="field-hint">Why we ask: models are cached in the browser so the assistant can run offline afterward. You can move to the next step while these keep downloading.</p>
      {rows
        .filter((r) => r.show)
        .map((r) => {
          const p = progress[r.model];
          return (
            <div class="card" key={r.model}>
              <div class="row" style={{ justifyContent: 'space-between' }}>
                <strong>{r.label}</strong>
                <Button variant="ghost" onClick={r.onDownload} disabled={busy[r.model] || p?.status === 'ready'}>
                  {p?.status === 'ready' ? 'Ready' : busy[r.model] ? 'Downloading…' : 'Download'}
                </Button>
              </div>
              {p && p.total > 0 && p.status !== 'error' && <ProgressBar value={p.loaded} max={p.total} label={`${mb(p.loaded)} / ${mb(p.total)} MB`} />}
              {p?.status === 'error' && <p class="test-error">{p.error || 'Download failed.'}</p>}
            </div>
          );
        })}
    </div>
  );
}

// ---------- Step 5: TinyFish ----------
function Step5TinyFish(props: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  return (
    <div>
      <h2>TinyFish key (optional)</h2>
      <p class="field-hint">
        Why we ask: an <a href="https://agent.tinyfish.ai" target="_blank" rel="noreferrer">agent.tinyfish.ai</a> key enables the web_search, web_fetch
        and browser_use tools. Skip this and add it later from Extensions if you don't need web access yet.
      </p>
      <Field label="TinyFish API key">
        <input
          class="input"
          type="password"
          value={props.settings.tinyfishKey || ''}
          onChange={(e) => props.update({ tinyfishKey: (e.target as HTMLInputElement).value })}
        />
      </Field>
    </div>
  );
}

// ---------- Step 7: Wake word ----------
function Step7Wake(props: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { settings, update } = props;
  const [testing, setTesting] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(
    () =>
      bus.on('wake:detected', () => {
        setCount((c) => c + 1);
      }),
    [],
  );

  useEffect(() => {
    if (count >= 3 && testing) {
      pipeline.stop();
      setTesting(false);
    }
  }, [count, testing]);

  async function startTest() {
    setCount(0);
    setTesting(true);
    try {
      await pipeline.start();
    } catch (err) {
      setTesting(false);
      bus.emit({ type: 'toast', level: 'error', text: `Could not start listening: ${(err as Error).message}` });
    }
  }

  useEffect(() => () => { if (testing) pipeline.stop(); }, []);

  return (
    <div>
      <h2>Wake word</h2>
      <p class="field-hint">Why we ask: this decides how you start talking to the assistant hands-free.</p>
      <WakeWordSettings value={settings.wake} onChange={(w) => update({ wake: w })} onTest={startTest} testing={testing} testCount={count} />
    </div>
  );
}

// ---------- Step 8: Done ----------
function Step8Done(props: { settings: Settings }) {
  const { settings } = props;
  return (
    <div>
      <h2>All set</h2>
      <ul>
        <li>Brain: {settings.mode === 'local' ? 'Local' : `Cloud (${settings.activeProviderId})`}</li>
        <li>Voice: {settings.voice.id} at {settings.voice.speed.toFixed(2)}x</li>
        <li>Wake word: {settings.wake.enabled ? settings.wake.phrase : 'off, using push-to-talk'}</li>
        <li>TinyFish: {settings.tinyfishKey ? 'configured' : 'not configured'}</li>
      </ul>
      <p>Click "Open assistant" to start talking.</p>
    </div>
  );
}
