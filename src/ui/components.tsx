// Shared, dumb UI primitives + a couple of feature-shared forms (ProviderForm, VoicePicker,
// WakeWordPicker) reused by both the Wizard and Settings so the two don't duplicate logic.
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { bus } from '../core/bus';
import type { ProviderConfig, TtsEngine } from '../core/types';
import { TTS_ENGINES, KITTEN_VOICES } from '../audio/tts-engines';

// ---------- useDraft: local echo for text/range inputs, committed on blur/change (not per keystroke/drag tick) ----------
export function useDraft<T>(value: T): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return [draft, setDraft];
}

// ---------- Button ----------
export function Button(props: {
  children: ComponentChildren;
  onClick?: (e: MouseEvent) => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const { children, onClick, variant = 'primary', disabled, type = 'button', title } = props;
  return (
    <button type={type} class={`btn btn-${variant}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

// ---------- Card ----------
export function Card(props: { children: ComponentChildren; class?: string }) {
  return <div class={`card ${props.class || ''}`}>{props.children}</div>;
}

// ---------- Field (label wrapper) ----------
// A native <label> wrapping its control needs no id/for pairing to be accessible.
export function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </label>
  );
}

// ---------- Toggle ----------
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <label class="toggle" for={props.id}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

// ---------- Select ----------
export function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <select
      id={props.id}
      class="select"
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------- Tabs ----------
export function Tabs(props: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }) {
  return (
    <div class="tabs" role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === props.active}
          class={`tab ${t.id === props.active ? 'active' : ''}`}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Modal ----------
export function Modal(props: { open: boolean; onClose: () => void; title?: string; children: ComponentChildren }) {
  if (!props.open) return null;
  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <h3>{props.title}</h3>
          <button class="modal-close" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

// ---------- ProgressBar ----------
export function ProgressBar(props: { value: number; max: number; label?: string }) {
  const pct = props.max > 0 ? Math.min(100, Math.max(0, (props.value / props.max) * 100)) : 0;
  return (
    <div class="progress">
      {props.label && <div class="progress-label">{props.label}</div>}
      <div class="progress-track">
        <div class="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------- Toast host ----------
interface ToastItem {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(
    () =>
      bus.on('toast', (e) => {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t, { id, level: e.level, text: e.text }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
      }),
    [],
  );
  return (
    <div class="toast-host">
      {toasts.map((t) => (
        <div key={t.id} class={`toast toast-${t.level}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- CopyButton ----------
export function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      bus.emit({ type: 'toast', level: 'error', text: 'Could not copy to clipboard.' });
    }
  }
  return (
    <Button variant="ghost" onClick={copy}>
      {copied ? 'Copied!' : props.label || 'Copy'}
    </Button>
  );
}

// ---------- ProviderForm (shared by Wizard step 3 and Settings > Providers) ----------
export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  latencyMs: number;
}
export interface ProviderModel {
  id: string;
  vision?: boolean;
  free?: boolean;
}
export function ProviderForm(props: {
  cfg: ProviderConfig;
  onChange: (cfg: ProviderConfig) => void;
  editableIdentity?: boolean; // true for custom endpoints: name + base URL are editable
  docsUrl?: string;
  models?: ProviderModel[];
  fetchingModels?: boolean;
  onFetchModels?: () => void;
  testing?: boolean;
  testResult?: ProviderTestResult | null;
  onTest?: () => void;
}) {
  const { cfg, onChange } = props;
  const [showKey, setShowKey] = useState(false);
  const [headersText, setHeadersText] = useState(() => JSON.stringify(cfg.extraHeaders || {}, null, 2));
  const [headersError, setHeadersError] = useState<string | null>(null);

  function patch(p: Partial<ProviderConfig>) {
    onChange({ ...cfg, ...p });
  }

  function commitHeaders(text: string) {
    setHeadersText(text);
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      setHeadersError(null);
      patch({ extraHeaders: parsed });
    } catch {
      setHeadersError('Invalid JSON');
    }
  }

  return (
    <div class="provider-form">
      {props.editableIdentity && (
        <Field label="Name">
          <input class="input" value={cfg.label} onChange={(e) => patch({ label: (e.target as HTMLInputElement).value })} />
        </Field>
      )}
      {props.editableIdentity && (
        <Field label="Base URL" hint="OpenAI-compatible, no trailing slash">
          <input class="input" value={cfg.baseUrl} onChange={(e) => patch({ baseUrl: (e.target as HTMLInputElement).value })} />
        </Field>
      )}
      <Field label="API key" hint={props.docsUrl ? undefined : undefined}>
        <div class="input-with-btn">
          <input
            class="input"
            type={showKey ? 'text' : 'password'}
            value={cfg.apiKey || ''}
            onChange={(e) => patch({ apiKey: (e.target as HTMLInputElement).value })}
          />
          <Button variant="ghost" onClick={() => setShowKey((s) => !s)}>
            {showKey ? 'Hide' : 'Show'}
          </Button>
        </div>
      </Field>
      {props.docsUrl && (
        <a class="docs-link" href={props.docsUrl} target="_blank" rel="noreferrer">
          Get an API key
        </a>
      )}
      <Field label="Model">
        {props.models && props.models.length > 0 ? (
          <Select
            value={cfg.model}
            onChange={(v) => patch({ model: v })}
            options={props.models.map((m) => ({ value: m.id, label: m.vision ? `${m.id} (vision)` : m.id }))}
          />
        ) : (
          <input class="input" value={cfg.model} onChange={(e) => patch({ model: (e.target as HTMLInputElement).value })} placeholder="model id" />
        )}
      </Field>
      <div class="row">
        {props.onFetchModels && (
          <Button variant="ghost" onClick={props.onFetchModels} disabled={props.fetchingModels}>
            {props.fetchingModels ? 'Fetching…' : 'Fetch models'}
          </Button>
        )}
        {props.onTest && (
          <Button variant="ghost" onClick={props.onTest} disabled={props.testing}>
            {props.testing ? 'Testing…' : 'Test'}
          </Button>
        )}
      </div>
      {props.testResult && (
        <p class={props.testResult.ok ? 'test-ok' : 'test-error'}>
          {props.testResult.ok ? `Connected (${props.testResult.latencyMs} ms)` : `Failed: ${props.testResult.error}`}
        </p>
      )}
      <div class="row">
        <Toggle checked={cfg.supportsImages} onChange={(v) => patch({ supportsImages: v })} label="Supports images" />
        <Toggle checked={cfg.supportsTools} onChange={(v) => patch({ supportsTools: v })} label="Supports tools" />
      </div>
      {props.editableIdentity && (
        <Field label="Extra headers (JSON)" hint={headersError || undefined}>
          <textarea
            class={`textarea mono ${headersError ? 'has-error' : ''}`}
            rows={3}
            value={headersText}
            onChange={(e) => commitHeaders((e.target as HTMLTextAreaElement).value)}
          />
        </Field>
      )}
    </div>
  );
}

// ---------- Voice picker (Wizard step 6 + Settings > Voice) ----------
// af_heart first per spec; static fallback list of kokoro-js's 28 voices used until tts.voices() resolves.
export const KOKORO_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

export interface VoiceValue {
  id: string;
  speed: number;
}
export function VoiceSettings(props: {
  value: VoiceValue;
  engine: TtsEngine;
  onEngineChange: (e: TtsEngine) => void;
  onChange: (v: VoiceValue) => void;
  onPreview: (voiceId: string) => Promise<void> | void;
}) {
  const fallbackVoices = props.engine === 'kokoro' ? KOKORO_VOICES : KITTEN_VOICES.map((v) => `kitten:${v}`);
  const [voices, setVoices] = useState<string[]>(fallbackVoices);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [speed, setSpeed] = useDraft(props.value.speed);

  useEffect(() => {
    setVoices(fallbackVoices);
    import('../audio/tts')
      .then(({ tts }) => tts.voices())
      .then((v) => {
        if (v && v.length) setVoices(v.includes('af_heart') ? ['af_heart', ...v.filter((x) => x !== 'af_heart')] : v);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fallbackVoices is derived from props.engine
  }, [props.engine]);

  async function changeEngine(id: string) {
    const engine = id as TtsEngine;
    props.onEngineChange(engine);
    const stillValid = engine === 'kokoro' ? !props.value.id.startsWith('kitten:') : props.value.id.startsWith('kitten:');
    if (!stillValid) props.onChange({ ...props.value, id: TTS_ENGINES[engine].defaultVoice });
    setReloading(true);
    try {
      const { tts } = await import('../audio/tts');
      await tts.reloadWith(undefined, engine);
    } catch (e) {
      bus.emit({ type: 'toast', level: 'error', text: `TTS engine switch failed: ${(e as Error).message}` });
    } finally {
      setReloading(false);
    }
  }

  async function preview(id: string) {
    setPreviewing(id);
    try {
      await props.onPreview(id);
    } finally {
      setPreviewing(null);
    }
  }

  return (
    <div class="voice-settings">
      <Field label="TTS engine" hint={TTS_ENGINES[props.engine].note}>
        <Select
          value={props.engine}
          disabled={reloading}
          onChange={changeEngine}
          options={Object.values(TTS_ENGINES).map((e) => ({ value: e.id, label: e.label }))}
        />
      </Field>
      <div class="voice-list">
        {voices.map((v) => (
          <label class="voice-row" key={v}>
            <input type="radio" name="voice" checked={props.value.id === v} onChange={() => props.onChange({ ...props.value, id: v })} />
            <span>{v.replace(/^kitten:/, '')}</span>
            <Button variant="ghost" onClick={() => preview(v)} disabled={previewing === v}>
              {previewing === v ? 'Playing…' : 'Preview'}
            </Button>
          </label>
        ))}
      </div>
      <Field label={`Speed: ${speed.toFixed(2)}x`}>
        <input
          class="slider"
          type="range"
          min="0.7"
          max="1.3"
          step="0.01"
          value={speed}
          onInput={(e) => setSpeed(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => props.onChange({ ...props.value, speed: Number((e.target as HTMLInputElement).value) })}
        />
      </Field>
    </div>
  );
}

// ---------- Wake word picker (Wizard step 7 + Settings > Wake word) ----------
export interface WakeValue {
  enabled: boolean;
  phrase: string;
  threshold: number;
  pushToTalk: boolean;
}
const WAKE_PRESETS = [
  { value: 'hey_jarvis', label: 'Hey Jarvis' },
  { value: 'alexa', label: 'Alexa' },
  { value: 'hey_mycroft', label: 'Hey Mycroft' },
  { value: 'custom', label: 'Custom .onnx URL' },
];
export function WakeWordSettings(props: {
  value: WakeValue;
  onChange: (v: WakeValue) => void;
  onTest?: () => void;
  testCount?: number;
  testing?: boolean;
}) {
  const isCustom = !WAKE_PRESETS.some((p) => p.value === props.value.phrase) && props.value.phrase !== '';
  const [customUrl, setCustomUrl] = useState(isCustom ? props.value.phrase : '');
  const [threshold, setThreshold] = useDraft(props.value.threshold);

  return (
    <div class="wake-settings">
      <Toggle checked={props.value.enabled} onChange={(v) => props.onChange({ ...props.value, enabled: v })} label="Wake word enabled" />
      <Field label="Phrase">
        <Select
          value={isCustom ? 'custom' : props.value.phrase}
          onChange={(v) => {
            if (v === 'custom') props.onChange({ ...props.value, phrase: customUrl });
            else props.onChange({ ...props.value, phrase: v });
          }}
          options={WAKE_PRESETS}
        />
      </Field>
      {isCustom && (
        <Field label="Custom .onnx model URL">
          <input
            class="input"
            value={customUrl}
            onInput={(e) => setCustomUrl((e.target as HTMLInputElement).value)}
            onBlur={() => props.onChange({ ...props.value, phrase: customUrl })}
          />
        </Field>
      )}
      <Field label={`Sensitivity: ${threshold.toFixed(2)}`}>
        <input
          class="slider"
          type="range"
          min="0.3"
          max="0.9"
          step="0.01"
          value={threshold}
          onInput={(e) => setThreshold(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => props.onChange({ ...props.value, threshold: Number((e.target as HTMLInputElement).value) })}
        />
      </Field>
      <Toggle
        checked={props.value.pushToTalk}
        onChange={(v) => props.onChange({ ...props.value, pushToTalk: v })}
        label="I will use push-to-talk instead"
      />
      {props.onTest && (
        <div class="wake-test">
          <Button variant="ghost" onClick={props.onTest} disabled={props.testing}>
            {props.testing ? 'Listening… say it 3 times' : 'Test it'}
          </Button>
          {props.testCount !== undefined && props.testCount > 0 && (
            <span class="wake-test-count">{Math.min(props.testCount, 3)} / 3 detected{props.testCount >= 3 ? ' — success!' : ''}</span>
          )}
        </div>
      )}
    </div>
  );
}
