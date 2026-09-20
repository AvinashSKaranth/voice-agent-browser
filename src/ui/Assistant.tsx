import { useEffect, useRef, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { getSettings, saveSettings } from '../core/settings';
import type { AppEvent, ChatMessage, ModelName, Settings } from '../core/types';
import { orchestrator, resumeSession } from '../core/orchestrator';
import { pipeline } from '../audio/pipeline';
import { player } from '../audio/player';
import { stt } from '../audio/stt';
import { tts } from '../audio/tts';
import { loadLocalLlm, localLlmReady } from '../providers/local';
import { transcripts } from '../storage/transcripts';
import { Button, ProgressBar, Select } from './components';

type AudioState = Extract<AppEvent, { type: 'audio:state' }>['state'];

type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; status: 'start' | 'done' | 'error'; result?: string }
  | { kind: 'feedback'; id: string; text: string }
  | { kind: 'error'; id: string; text: string };

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

export function Assistant() {
  const [audioState, setAudioState] = useState<AudioState>('idle');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const [settings, setSettings] = useState<Settings>(getSettings());
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [loadProgress, setLoadProgress] = useState<Partial<Record<ModelName, { loaded: number; total: number; status: string; error?: string }>>>({});
  const transcriptRef = useRef<HTMLDivElement>(null);
  const banner = fixItBanner(settings);

  useEffect(() => {
    const offs = [
      bus.on('audio:state', (e) => setAudioState(e.state)),
      bus.on('stt:final', (e) => setEntries((en) => [...en, { kind: 'user', id: `u-${Date.now()}`, text: e.text }])),
      bus.on('turn:token', (e) =>
        setEntries((en) => {
          const idx = en.findIndex((x) => x.kind === 'assistant' && x.id === e.id);
          if (idx === -1) return [...en, { kind: 'assistant', id: e.id, text: e.text }];
          const copy = en.slice();
          copy[idx] = { kind: 'assistant', id: e.id, text: (copy[idx] as { text: string }).text + e.text };
          return copy;
        }),
      ),
      bus.on('turn:tool', (e) =>
        setEntries((en) => {
          if (e.status !== 'start') {
            const idx = [...en].reverse().findIndex((x) => x.kind === 'tool' && x.id === e.id && x.name === e.name && x.status === 'start');
            if (idx !== -1) {
              const realIdx = en.length - 1 - idx;
              const copy = en.slice();
              copy[realIdx] = { kind: 'tool', id: e.id, name: e.name, args: e.args, status: e.status, result: e.result };
              return copy;
            }
          }
          return [...en, { kind: 'tool', id: e.id, name: e.name, args: e.args, status: e.status, result: e.result }];
        }),
      ),
      bus.on('turn:feedback', (e) => setEntries((en) => [...en, { kind: 'feedback', id: `${e.id}-${en.length}`, text: e.text }])),
      bus.on('turn:end', (e) => {
        if (e.error) setEntries((en) => [...en, { kind: 'error', id: `${e.id}-err`, text: e.error! }]);
      }),
      bus.on('settings:changed', (e) => setSettings(e.settings)),
      bus.on('model:progress', (e) =>
        setLoadProgress((p) => ({ ...p, [e.model]: { loaded: e.loaded, total: e.total, status: e.status, error: e.error } })),
      ),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  // Load prior messages of the current session.
  useEffect(() => {
    transcripts
      .load(orchestrator.sessionId())
      .then((msgs) => {
        const loaded: Entry[] = msgs
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m, i) => ({ kind: m.role === 'user' ? 'user' : 'assistant', id: `hist-${i}`, text: contentToText(m.content) }) as Entry);
        setEntries(loaded);
      })
      .catch(() => {});
    refreshSessions();
  }, []);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [entries]);

  // Load models on first mount if not ready.
  useEffect(() => {
    if (!stt.ready()) stt.load().catch((err) => bus.emit({ type: 'toast', level: 'error', text: `STT load failed: ${err.message}` }));
    if (!tts.ready()) tts.load().catch((err) => bus.emit({ type: 'toast', level: 'error', text: `TTS load failed: ${err.message}` }));
    if (settings.mode === 'local' && !localLlmReady())
      loadLocalLlm().catch((err: Error) => bus.emit({ type: 'toast', level: 'error', text: `Local model load failed: ${err.message}` }));
  }, []);

  function refreshSessions() {
    transcripts.sessions().then(setSessions).catch(() => {});
  }

  function send() {
    const t = text.trim();
    if (!t && images.length === 0) return;
    setEntries((en) => [...en, { kind: 'user', id: `u-${Date.now()}`, text: t }]);
    orchestrator.runTurn(t, images.length ? { images } : undefined).catch((err) => bus.emit({ type: 'toast', level: 'error', text: err.message }));
    setText('');
    setImages([]);
  }

  function onImageFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImages((im) => [...im, reader.result as string]);
    reader.readAsDataURL(file);
  }

  async function toggleMic() {
    player.init(); // synchronously unlock AudioContext inside this click gesture
    if (micOn) {
      pipeline.stop();
      setMicOn(false);
    } else {
      try {
        await pipeline.start();
        setMicOn(true);
      } catch (err) {
        bus.emit({ type: 'toast', level: 'error', text: `Could not start listening: ${(err as Error).message}` });
      }
    }
  }

  async function switchSession(id: string) {
    resumeSession(id);
    try {
      const msgs = await transcripts.load(id);
      const loaded: Entry[] = msgs
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m, i) => ({ kind: m.role === 'user' ? 'user' : 'assistant', id: `hist-${i}`, text: contentToText(m.content) }) as Entry);
      setEntries(loaded);
    } catch {
      setEntries([]);
    }
  }

  async function newSession() {
    await orchestrator.newSession();
    setEntries([]);
    refreshSessions();
  }

  async function exportSession() {
    const md = await transcripts.exportMarkdown(orchestrator.sessionId());
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${orchestrator.sessionId()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function switchProvider(id: string) {
    if (id === 'local') saveSettings({ mode: 'local' });
    else saveSettings({ mode: 'cloud', activeProviderId: id });
  }

  const providerOptions = [
    { value: 'local', label: 'Local' },
    ...settings.providers.filter((p) => p.enabled).map((p) => ({ value: p.id, label: p.label })),
  ];
  const activeProviderValue = settings.mode === 'local' ? 'local' : settings.activeProviderId;

  const stateLabel: Record<AudioState, string> = {
    idle: 'Mic off',
    wake: `Say ${settings.wake.phrase.replace(/\.onnx$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`,
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
  };

  const loadingModels = Object.entries(loadProgress).filter(([, p]) => p && p.status !== 'ready');

  return (
    <div class="assistant">
      {banner && (
        <div class="banner">
          <span>{banner.text}</span>
          <a class="btn btn-ghost" href={banner.href}>
            Fix it
          </a>
        </div>
      )}

      {loadingModels.length > 0 && (
        <div class="card">
          {loadingModels.map(([name, p]) =>
            p!.status === 'error' ? (
              <p class="test-error" key={name}>{name}: {p!.error || 'load failed'}</p>
            ) : (
              <ProgressBar key={name} value={p!.loaded} max={p!.total || 1} label={`Loading ${name}…`} />
            ),
          )}
        </div>
      )}

      <div class="orb-wrap">
        <div class={`orb ${audioState}`} />
        <div class="orb-state-label">{stateLabel[audioState]}</div>
      </div>

      <div class="controls-row">
        <div class="controls-left">
          <Button onClick={toggleMic}>{micOn ? 'Stop mic' : 'Start mic'}</Button>
          <Button variant="ghost" onClick={() => orchestrator.abort()}>
            Stop
          </Button>
          <Select value={activeProviderValue} onChange={switchProvider} options={providerOptions} />
        </div>
        <div class="controls-right">
          <Select
            value={orchestrator.sessionId()}
            onChange={switchSession}
            options={sessions.map((s) => ({ value: s.id, label: s.title || s.id }))}
          />
          <Button variant="ghost" onClick={newSession}>
            New session
          </Button>
          <Button variant="ghost" onClick={exportSession}>
            Export
          </Button>
        </div>
      </div>

      <div class="transcript" ref={transcriptRef}>
        {entries.map((e) => {
          if (e.kind === 'user') return <div class="msg msg-user" key={e.id}>{e.text}</div>;
          if (e.kind === 'assistant') return <div class="msg msg-assistant" key={e.id}>{e.text}</div>;
          if (e.kind === 'feedback') return <div class="msg-feedback" key={e.id}>{e.text}</div>;
          if (e.kind === 'error') return <div class="msg-error" key={e.id}>Error: {e.text}</div>;
          return (
            <div class="tool-chip" key={e.id}>
              {e.name}({summarizeArgs(e.args)}) — {e.status}
              {e.result ? `: ${e.result.slice(0, 120)}` : ''}
            </div>
          );
        })}
      </div>

      <div class="composer">
        <input
          class="input"
          placeholder="Type instead of speaking…"
          value={text}
          onInput={(ev) => setText((ev.target as HTMLInputElement).value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              send();
            }
          }}
        />
        <input type="file" accept="image/*" onChange={onImageFile} />
        <button
          class="btn btn-ghost"
          onPointerDown={() => {
            setRecording(true);
            void pipeline.pushToTalkStart();
          }}
          onPointerUp={() => {
            setRecording(false);
            pipeline.pushToTalkStop();
          }}
          onPointerLeave={() => {
            setRecording(false);
            pipeline.pushToTalkStop();
          }}
          onPointerCancel={() => {
            setRecording(false);
            pipeline.pushToTalkStop();
          }}
        >
          {recording ? 'Recording…' : 'Push to talk'}
        </button>
        <Button onClick={send}>Send</Button>
      </div>
      {images.length > 0 && <p class="field-hint">{images.length} image(s) attached</p>}
    </div>
  );
}

function fixItBanner(settings: Settings): { text: string; href: string } | null {
  if (!settings.setupDone) return null;
  if (settings.mode === 'local' && !(navigator as unknown as { gpu?: unknown }).gpu) {
    return { text: 'Local mode needs WebGPU, which this browser does not have.', href: '#/setup?step=2' };
  }
  if (settings.mode === 'cloud') {
    const active = settings.providers.find((p) => p.id === settings.activeProviderId && p.enabled);
    if (!active) return { text: 'No cloud provider is configured yet.', href: '#/setup?step=3' };
  }
  return null;
}
