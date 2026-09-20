import { useEffect, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { getSettings, saveSettings } from '../core/settings';
import type { ProviderConfig, Settings as SettingsType } from '../core/types';
import { Button, Card, Field, Modal, ProviderForm, Select, Toggle, VoiceSettings, WakeWordSettings, useDraft } from './components';
import type { ProviderModel, ProviderTestResult } from './components';
import { PROVIDER_PRESETS, listModels } from '../providers/roster';
import { testConnection } from '../providers/registry';
import { tts } from '../audio/tts';
import { bridge } from '../core/bridge';
import { memory } from '../storage/memory';

export function Settings() {
  const [settings, setSettings] = useState<SettingsType>(getSettings());
  const [flash, setFlash] = useState(false);

  function update(patch: Partial<SettingsType> | ((s: SettingsType) => SettingsType)) {
    setSettings(saveSettings(patch));
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  }

  return (
    <div class="settings">
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <h1>Settings</h1>
        {flash && <span class="saved-flash">Saved</span>}
      </div>

      <BrainSection settings={settings} update={update} />
      <ProvidersSection settings={settings} update={update} />
      <LocalModelsSection settings={settings} update={update} />
      <VoiceSection settings={settings} update={update} />
      <WakeSection settings={settings} update={update} />
      <FeedbackSection settings={settings} update={update} />
      <BridgeSection settings={settings} update={update} />
      <MemorySection />
      <DataSection settings={settings} update={update} />
    </div>
  );
}

type Updater = (patch: Partial<SettingsType> | ((s: SettingsType) => SettingsType)) => void;

function BrainSection(props: { settings: SettingsType; update: Updater }) {
  const { settings, update } = props;
  const enabled = settings.providers.filter((p) => p.enabled);
  return (
    <Card>
      <h2>Brain</h2>
      <Field label="Mode">
        <Select
          value={settings.mode}
          onChange={(v) => update({ mode: v as 'local' | 'cloud' })}
          options={[
            { value: 'local', label: 'Local' },
            { value: 'cloud', label: 'Cloud' },
          ]}
        />
      </Field>
      {settings.mode === 'cloud' && (
        <Field label="Active provider">
          <Select
            value={settings.activeProviderId}
            onChange={(v) => update({ activeProviderId: v })}
            options={enabled.map((p) => ({ value: p.id, label: p.label }))}
          />
        </Field>
      )}
      <a href="#/setup">Run setup again</a>
    </Card>
  );
}

function ProvidersSection(props: { settings: SettingsType; update: Updater }) {
  const { settings, update } = props;
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [isNewCustom, setIsNewCustom] = useState(false);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<ProviderModel[] | undefined>(undefined);

  function save() {
    if (!editing) return;
    const exists = settings.providers.some((p) => p.id === editing.id);
    const providers = exists ? settings.providers.map((p) => (p.id === editing.id ? editing : p)) : [...settings.providers, editing];
    update({ providers });
    setEditing(null);
  }

  function remove(id: string) {
    update({ providers: settings.providers.filter((p) => p.id !== id) });
  }

  function toggleEnabled(p: ProviderConfig) {
    update({ providers: settings.providers.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)) });
  }

  function addPreset(id: string) {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetPickerOpen(false);
    setIsNewCustom(false);
    setModels(undefined);
    setTestResult(null);
    setEditing({ id: preset.id, label: preset.label, baseUrl: preset.baseUrl, model: preset.model, supportsImages: preset.supportsImages, supportsTools: preset.supportsTools, enabled: true, apiKey: '' });
  }

  function addCustom() {
    setIsNewCustom(true);
    setModels(undefined);
    setTestResult(null);
    setEditing({ id: `custom-${Date.now()}`, label: '', baseUrl: '', model: '', supportsImages: false, supportsTools: true, enabled: true, apiKey: '' });
  }

  function editExisting(p: ProviderConfig) {
    setIsNewCustom(p.id.startsWith('custom-'));
    setModels(undefined);
    setTestResult(null);
    setEditing(p);
  }

  async function test() {
    if (!editing) return;
    setTesting(true);
    try {
      setTestResult(await testConnection(editing));
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message, latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  async function fetchModels() {
    if (!editing) return;
    setFetchingModels(true);
    try {
      setModels(await listModels(editing));
    } catch (err) {
      bus.emit({ type: 'toast', level: 'error', text: `Could not fetch models: ${(err as Error).message}` });
    } finally {
      setFetchingModels(false);
    }
  }

  const availablePresets = PROVIDER_PRESETS.filter((p) => !settings.providers.some((sp) => sp.id === p.id));

  return (
    <Card>
      <h2>Providers</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {settings.providers.map((p) => (
            <tr key={p.id}>
              <td>{p.label}</td>
              <td>{p.model || '—'}</td>
              <td>
                <Toggle checked={p.enabled} onChange={() => toggleEnabled(p)} label="" />
              </td>
              <td>
                <div class="row">
                  <Button variant="ghost" onClick={() => editExisting(p)}>
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => remove(p.id)}>
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="row">
        <Button variant="ghost" onClick={() => setPresetPickerOpen(true)}>
          Add preset
        </Button>
        <Button variant="ghost" onClick={addCustom}>
          Add custom endpoint
        </Button>
      </div>

      <Modal open={presetPickerOpen} onClose={() => setPresetPickerOpen(false)} title="Add a preset provider">
        <div class="preset-cards">
          {availablePresets.map((p) => (
            <Card key={p.id}>
              <h3>{p.label}</h3>
              <p class="field-hint">{p.note}</p>
              <Button onClick={() => addPreset(p.id)}>Add</Button>
            </Card>
          ))}
        </div>
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.label || 'Provider'}>
        {editing && (
          <div>
            <ProviderForm
              cfg={editing}
              onChange={setEditing}
              editableIdentity={isNewCustom}
              models={models}
              fetchingModels={fetchingModels}
              onFetchModels={fetchModels}
              testing={testing}
              testResult={testResult}
              onTest={test}
            />
            <div class="row-end">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={save}>Save</Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function LocalModelsSection(props: { settings: SettingsType; update: Updater }) {
  const { settings, update } = props;
  async function clearCache() {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    bus.emit({ type: 'toast', level: 'info', text: 'Model cache cleared.' });
  }
  return (
    <Card>
      <h2>Local models</h2>
      <Toggle checked={settings.local.llm} onChange={(v) => update({ local: { ...settings.local, llm: v } })} label="Run local LLM" />
      <Field label="TTS device">
        <Select
          value={settings.local.ttsDevice}
          onChange={(v) => update({ local: { ...settings.local, ttsDevice: v as 'wasm' | 'webgpu', ttsDeviceExplicit: true } })}
          options={[
            { value: 'wasm', label: 'WASM' },
            { value: 'webgpu', label: 'WebGPU' },
          ]}
        />
      </Field>
      <Button variant="danger" onClick={clearCache}>
        Clear model cache
      </Button>
    </Card>
  );
}

function VoiceSection(props: { settings: SettingsType; update: Updater }) {
  return (
    <Card>
      <h2>Voice</h2>
      <VoiceSettings
        value={props.settings.voice}
        onChange={(v) => props.update({ voice: v })}
        onPreview={() => tts.load().then(() => tts.say('Hi, I am your assistant. How can I help?')).catch((e: Error) => bus.emit({ type: 'toast', level: 'error', text: e.message }))}
      />
    </Card>
  );
}

function WakeSection(props: { settings: SettingsType; update: Updater }) {
  return (
    <Card>
      <h2>Wake word</h2>
      <WakeWordSettings value={props.settings.wake} onChange={(w) => props.update({ wake: w })} />
    </Card>
  );
}

function FeedbackSection(props: { settings: SettingsType; update: Updater }) {
  const { settings, update } = props;
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  async function requestNotifications() {
    try {
      setNotifPerm(await Notification.requestPermission());
    } catch {
      setNotifPerm('denied');
    }
  }

  const [heartbeat, setHeartbeat] = useDraft(settings.feedback.heartbeatSec);
  const [maxRetries, setMaxRetries] = useDraft(settings.feedback.maxRetries);

  return (
    <Card>
      <h2>Spoken feedback</h2>
      <div class="row">
        <Button variant="ghost" onClick={requestNotifications} disabled={notifPerm === 'unsupported'}>
          Allow notifications
        </Button>
        <span class="field-hint">Notifications: {notifPerm}</span>
      </div>
      <Field label={`Heartbeat every ${heartbeat}s`}>
        <input
          class="slider"
          type="range"
          min="30"
          max="120"
          step="5"
          value={heartbeat}
          onInput={(e) => setHeartbeat(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => update({ feedback: { ...settings.feedback, heartbeatSec: Number((e.target as HTMLInputElement).value) } })}
        />
      </Field>
      <Field label={`Max retries: ${maxRetries}`}>
        <input
          class="slider"
          type="range"
          min="1"
          max="5"
          step="1"
          value={maxRetries}
          onInput={(e) => setMaxRetries(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => update({ feedback: { ...settings.feedback, maxRetries: Number((e.target as HTMLInputElement).value) } })}
        />
      </Field>
      <Toggle
        checked={settings.feedback.quiet}
        onChange={(v) => update({ feedback: { ...settings.feedback, quiet: v } })}
        label="Quiet mode (chime only, no heartbeat narration)"
      />
    </Card>
  );
}

function BridgeSection(props: { settings: SettingsType; update: Updater }) {
  const { settings, update } = props;
  const [connected, setConnected] = useState(bridge.connected());
  const [connecting, setConnecting] = useState(false);
  const [url, setUrl] = useDraft(settings.bridge.url);
  const [token, setToken] = useDraft(settings.bridge.token || '');
  const [terminal, setTerminal] = useDraft(settings.terminal);

  useEffect(() => bridge.onStatus(setConnected), []);

  async function connect() {
    setConnecting(true);
    try {
      await bridge.connect();
    } catch (err) {
      bus.emit({ type: 'toast', level: 'error', text: `Bridge connect failed: ${(err as Error).message}` });
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Card>
      <h2>Bridge</h2>
      <p>Status: {connected ? 'Connected' : 'Disconnected'}</p>
      <Field label="Bridge URL">
        <input
          class="input"
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onBlur={() => update({ bridge: { ...settings.bridge, url } })}
        />
      </Field>
      <Field label="Token">
        <input
          class="input"
          type="password"
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          onBlur={() => update({ bridge: { ...settings.bridge, token } })}
        />
      </Field>
      <Button onClick={connect} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect'}
      </Button>
      <Field label="Terminal command" hint="empty = OS default">
        <input
          class="input"
          value={terminal}
          onInput={(e) => setTerminal((e.target as HTMLInputElement).value)}
          onBlur={() => update({ terminal })}
        />
      </Field>
    </Card>
  );
}

function MemorySection() {
  const [facts, setFacts] = useState<Array<{ id: number; text: string; createdAt: string }>>([]);

  function refresh() {
    memory.all().then(setFacts).catch(() => {});
  }
  useEffect(refresh, []);

  async function del(text: string) {
    await memory.forget(text);
    refresh();
  }

  return (
    <Card>
      <h2>Memory</h2>
      <ul class="doc-list">
        {facts.map((f) => (
          <li key={f.id}>
            <span>{f.text}</span>
            <Button variant="danger" onClick={() => del(f.text)}>
              Delete
            </Button>
          </li>
        ))}
        {facts.length === 0 && <li>No stored memories yet.</li>}
      </ul>
    </Card>
  );
}

function DataSection(props: { settings: SettingsType; update: Updater }) {
  const { settings } = props;

  function exportJson() {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voice-agent-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text);
        saveSettings(parsed);
        bus.emit({ type: 'toast', level: 'info', text: 'Settings imported.' });
      })
      .catch((err) => bus.emit({ type: 'toast', level: 'error', text: `Import failed: ${err.message}` }));
  }

  function resetApp() {
    if (!confirm('This clears all settings and reloads the app. Continue?')) return;
    localStorage.clear();
    location.reload();
  }

  return (
    <Card>
      <h2>Data</h2>
      <div class="row">
        <Button variant="ghost" onClick={exportJson}>
          Export settings
        </Button>
        <label class="btn btn-ghost">
          Import settings
          <input type="file" accept="application/json" style={{ display: 'none' }} onChange={importJson} />
        </label>
        <Button variant="danger" onClick={resetApp}>
          Reset app
        </Button>
      </div>
      <p class="field-hint">Settings are stored per site. Export from localhost and import here after deploying, or run setup again.</p>
    </Card>
  );
}
