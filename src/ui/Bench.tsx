import { useEffect, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import { metrics } from '../core/metrics';
import { tts } from '../audio/tts';
import { stt } from '../audio/stt';
import { wake } from '../audio/wake';
import { localProvider, localLlmReady } from '../providers/local';
import { Button, Card, Toggle } from './components';
import { STT_MODELS } from '../audio/stt-models';
import { TTS_ENGINES } from '../audio/tts-engines';
import type { SttModelId, TtsEngine } from '../core/types';

const STT_MODEL_IDS = Object.keys(STT_MODELS) as SttModelId[];
const TTS_ENGINE_IDS = Object.keys(TTS_ENGINES) as TtsEngine[];

const SENTENCE = 'The quick brown fox jumps over the lazy dog near the riverbank this morning.';
const HAS_GPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

interface TtsRun {
  engine: TtsEngine;
  device: string;
  loadMs: number;
  runs: Array<{ synthMs: number; firstAudioMs: number; audioSec: number; realtime: number }>;
}
type SttDevice = 'webgpu' | 'hybrid' | 'wasm';
const STT_DEVICE_IDS: SttDevice[] = ['webgpu', 'hybrid', 'wasm'];
interface SttRun {
  model: SttModelId;
  device: SttDevice;
  loadMs: number | null; // null when the load itself failed
  run1Ms: number | null;
  run2Ms: number | null;
  transcript: string; // transcript text, or "Error: ..." when a run failed
}
interface LlmRun {
  firstTokenMs: number;
  totalMs: number;
  text: string;
}
interface WakeRun {
  frames: number;
  ms: number;
  framesPerSec: number;
}

async function resampleTo16k(audio: Float32Array, sourceRate: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil((audio.length * 16000) / sourceRate), 16000);
  const buf = ctx.createBuffer(1, audio.length, sourceRate);
  buf.copyToChannel(new Float32Array(audio), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export function Bench() {
  const [gpuAdapter, setGpuAdapter] = useState<string>('checking…');
  const [ttsResults, setTtsResults] = useState<TtsRun[] | null>(null);
  const [ttsRunning, setTtsRunning] = useState(false);
  const [ttsEngineChecks, setTtsEngineChecks] = useState<Record<TtsEngine, boolean>>(
    () => Object.fromEntries(TTS_ENGINE_IDS.map((id) => [id, true])) as Record<TtsEngine, boolean>,
  );
  const [lastAudio, setLastAudio] = useState<{ audio: Float32Array; sampleRate: number } | null>(null);
  const [sttResults, setSttResults] = useState<SttRun[] | null>(null);
  const [sttRunning, setSttRunning] = useState(false);
  const [sttModelChecks, setSttModelChecks] = useState<Record<SttModelId, boolean>>(
    () => Object.fromEntries(STT_MODEL_IDS.map((id) => [id, true])) as Record<SttModelId, boolean>,
  );
  const [sttDeviceChecks, setSttDeviceChecks] = useState<Record<SttDevice, boolean>>({ webgpu: true, hybrid: true, wasm: false });
  const [llmResult, setLlmResult] = useState<LlmRun | null>(null);
  const [llmRunning, setLlmRunning] = useState(false);
  const [wakeResult, setWakeResult] = useState<WakeRun | null>(null);
  const [wakeRunning, setWakeRunning] = useState(false);

  useEffect(() => {
    if (!HAS_GPU) {
      setGpuAdapter('not available');
      return;
    }
    (navigator as unknown as { gpu: { requestAdapter(): Promise<{ info?: unknown } | null> } }).gpu
      .requestAdapter()
      .then((adapter) => setGpuAdapter(adapter ? JSON.stringify((adapter as { info?: unknown }).info ?? 'present, no .info') : 'requestAdapter() returned null'))
      .catch((e) => setGpuAdapter(`error: ${(e as Error).message}`));
  }, []);

  function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function runTtsBench() {
    tts.setBenchMode(true);
    const engines = TTS_ENGINE_IDS.filter((id) => ttsEngineChecks[id]);
    if (engines.length === 0) {
      bus.emit({ type: 'toast', level: 'warn', text: 'Tick at least one TTS engine to benchmark.' });
      return;
    }
    setTtsRunning(true);
    setTtsResults(null);
    try {
      const { speed } = getSettings().voice;
      const out: TtsRun[] = [];
      for (const engine of engines) {
        const def = TTS_ENGINES[engine];
        const voice = def.defaultVoice;
        const devices: Array<'wasm' | 'webgpu'> = HAS_GPU && def.webgpu ? ['wasm', 'webgpu'] : ['wasm'];
        for (const device of devices) {
          const l0 = performance.now();
          const runs: TtsRun['runs'] = [];
          try {
            // A hung engine (network, wasm init) must not block the whole bench: 120 s per step.
            await withTimeout(tts.reloadWith(device, engine), 120000, `${engine} load on ${device}`);
            const loadMs = performance.now() - l0;
            for (let i = 0; i < 3; i++) {
              let firstAudioMs = 0;
              const s0 = performance.now();
              const result = await withTimeout(tts.synthToPCM(SENTENCE, voice, speed, (ms) => (firstAudioMs = ms)), 120000, `${engine} synth on ${device}`);
              const synthMs = performance.now() - s0;
              const audioSec = result.audio.length / result.sampleRate;
              runs.push({ synthMs, firstAudioMs, audioSec, realtime: audioSec / (synthMs / 1000) });
              setLastAudio(result);
            }
            out.push({ engine, device, loadMs, runs });
          } catch (e) {
            bus.emit({ type: 'toast', level: 'error', text: `TTS bench: ${(e as Error).message}` });
            out.push({ engine, device, loadMs: performance.now() - l0, runs });
            setTtsResults([...out]);
            continue;
          }
          setTtsResults([...out]);
          const avgSynth = runs.reduce((a, r) => a + r.synthMs, 0) / runs.length;
          metrics.event(`bench.tts.${engine}.${device}`, avgSynth, `load=${out[out.length - 1].loadMs.toFixed(0)}ms`);
        }
      }
    } catch (e) {
      bus.emit({ type: 'toast', level: 'error', text: `TTS bench failed: ${(e as Error).message}` });
    } finally {
      setTtsRunning(false);
      tts.setBenchMode(false);
      void tts.reloadWith().catch(() => {}); // restore the normal (settings-resolved) engine/device for real speech
    }
  }

  async function runSttBench() {
    if (!lastAudio) {
      bus.emit({ type: 'toast', level: 'warn', text: 'Run the TTS benchmark first - STT reuses that audio.' });
      return;
    }
    const models = STT_MODEL_IDS.filter((id) => sttModelChecks[id]);
    if (models.length === 0) {
      bus.emit({ type: 'toast', level: 'warn', text: 'Tick at least one STT model to benchmark.' });
      return;
    }
    const devices = STT_DEVICE_IDS.filter((d) => sttDeviceChecks[d] && (d === 'wasm' || HAS_GPU));
    if (devices.length === 0) {
      bus.emit({ type: 'toast', level: 'warn', text: 'Tick at least one STT device to benchmark.' });
      return;
    }
    setSttRunning(true);
    setSttResults([]);
    try {
      const audio16k = await resampleTo16k(lastAudio.audio, lastAudio.sampleRate);
      const out: SttRun[] = [];
      for (const model of models) {
        for (const device of devices) {
          if (device === 'hybrid' && !STT_MODELS[model].hybridDevice) {
            out.push({ model, device, loadMs: null, run1Ms: null, run2Ms: null, transcript: 'Error: hybrid unsupported for this model' });
            setSttResults([...out]);
            continue;
          }
          let loadMs: number | null = null;
          try {
            const l0 = performance.now();
            await stt.reloadWith(device, model);
            loadMs = performance.now() - l0;
          } catch (e) {
            out.push({ model, device, loadMs: null, run1Ms: null, run2Ms: null, transcript: `Error: ${(e as Error).message}` });
            setSttResults([...out]);
            continue; // this model/device combo failed to load; keep going with the rest
          }
          let run1Ms: number | null = null;
          let run2Ms: number | null = null;
          let transcript = '';
          try {
            const s1 = performance.now();
            transcript = await stt.transcribe(audio16k.slice());
            run1Ms = performance.now() - s1;
            const s2 = performance.now();
            transcript = await stt.transcribe(audio16k.slice());
            run2Ms = performance.now() - s2;
            metrics.event(`bench.stt.${model}.${device}`, run2Ms, transcript.slice(0, 80));
          } catch (e) {
            transcript = `Error: ${(e as Error).message}`;
          }
          out.push({ model, device, loadMs, run1Ms, run2Ms, transcript });
          setSttResults([...out]);
        }
      }
    } catch (e) {
      bus.emit({ type: 'toast', level: 'error', text: `STT bench failed: ${(e as Error).message}` });
    } finally {
      setSttRunning(false);
      void stt.load(); // restore auto device + settings-selected model
    }
  }

  async function runLlmBench() {
    setLlmRunning(true);
    setLlmResult(null);
    try {
      const t0 = performance.now();
      let firstTokenMs = 0;
      const result = await localProvider.generate({
        messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
        tools: [],
        signal: new AbortController().signal,
        onToken: () => {
          if (!firstTokenMs) firstTokenMs = performance.now() - t0;
        },
      });
      const totalMs = performance.now() - t0;
      metrics.event('bench.llm', totalMs, `first_token=${firstTokenMs.toFixed(0)}ms`);
      setLlmResult({ firstTokenMs, totalMs, text: result.text });
    } catch (e) {
      bus.emit({ type: 'toast', level: 'error', text: `LLM bench failed: ${(e as Error).message}` });
    } finally {
      setLlmRunning(false);
    }
  }

  async function runWakeBench() {
    setWakeRunning(true);
    setWakeResult(null);
    try {
      await wake.load(getSettings().wake.phrase);
      if (!wake.ready()) {
        bus.emit({ type: 'toast', level: 'warn', text: 'Wake model did not load; nothing to benchmark.' });
        return;
      }
      const FRAME = 512;
      const frames = Math.floor((16000 * 3) / FRAME);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) wake.feed(new Float32Array(FRAME));
      const ms = performance.now() - t0;
      const framesPerSec = frames / (ms / 1000);
      metrics.event('bench.wake', framesPerSec, `${frames} frames`);
      setWakeResult({ frames, ms, framesPerSec });
    } catch (e) {
      bus.emit({ type: 'toast', level: 'error', text: `Wake bench failed: ${(e as Error).message}` });
    } finally {
      setWakeRunning(false);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ deviceInfo: { hasGpu: HAS_GPU, gpuAdapter, hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent }, tts: ttsResults, stt: sttResults, llm: llmResult, wake: wakeResult }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bench-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <h1>Bench</h1>
        <Button variant="ghost" onClick={exportJson}>
          Export JSON
        </Button>
      </div>

      <Card>
        <h2>Device</h2>
        <p>WebGPU: {HAS_GPU ? 'available' : 'not available'}</p>
        {HAS_GPU && <p>Adapter info: {gpuAdapter}</p>}
        <p>Hardware concurrency: {navigator.hardwareConcurrency}</p>
        <p class="field-hint">User agent: {navigator.userAgent}</p>
        <p class="field-hint">
          WASM and WebGPU are two execution backends for the same underlying model - the model architecture and weights are identical, but each backend loads a different quantised weight file (dtype):
          WASM runs the int8-ish "q8" (or "q4") weights on the CPU through onnxruntime-web, while WebGPU runs full-precision "fp32" weights on the GPU. That is why a benchmark run has to reload the model
          between backends instead of just flipping a flag - it is genuinely a different set of weight files being loaded and executed differently.
        </p>
      </Card>

      <Card>
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <h2>TTS</h2>
          <Button onClick={runTtsBench} disabled={ttsRunning}>
            {ttsRunning ? 'Running…' : 'Run TTS benchmark'}
          </Button>
        </div>
        <p class="field-hint">Runs each ticked engine on WebGPU (when the engine supports it) and on WASM.</p>
        <div class="row">
          {TTS_ENGINE_IDS.map((id) => (
            <Toggle
              key={id}
              checked={ttsEngineChecks[id]}
              onChange={(v) => setTtsEngineChecks((c) => ({ ...c, [id]: v }))}
              label={TTS_ENGINES[id].label}
            />
          ))}
        </div>
        {ttsResults && (
          <table class="data-table">
            <thead>
              <tr>
                <th>Engine</th>
                <th>Device</th>
                <th>Load ms</th>
                <th>Run</th>
                <th>Synth ms</th>
                <th>First audio ms</th>
                <th>Audio sec</th>
                <th>Realtime factor</th>
              </tr>
            </thead>
            <tbody>
              {ttsResults.flatMap((r) =>
                r.runs.map((run, i) => (
                  <tr key={`${r.engine}-${r.device}-${i}`}>
                    <td>{i === 0 ? TTS_ENGINES[r.engine].label : ''}</td>
                    <td>{i === 0 ? r.device : ''}</td>
                    <td>{i === 0 ? r.loadMs.toFixed(0) : ''}</td>
                    <td>{i + 1}</td>
                    <td>{run.synthMs.toFixed(0)}</td>
                    <td>{run.firstAudioMs.toFixed(0)}</td>
                    <td>{run.audioSec.toFixed(2)}</td>
                    <td>{run.realtime.toFixed(2)}x</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <h2>STT</h2>
          <Button onClick={runSttBench} disabled={sttRunning}>
            {sttRunning ? 'Running…' : 'Run STT benchmark'}
          </Button>
        </div>
        <p class="field-hint">Reuses the audio synthesised by the TTS benchmark above, resampled to 16 kHz. Runs each ticked model on each ticked device, two runs each; a combo that fails to load or transcribe still shows a row with the error in the transcript column.</p>
        <div class="row">
          {STT_MODEL_IDS.map((id) => (
            <Toggle
              key={id}
              checked={sttModelChecks[id]}
              onChange={(v) => setSttModelChecks((c) => ({ ...c, [id]: v }))}
              label={STT_MODELS[id].label}
            />
          ))}
        </div>
        <div class="row">
          <Toggle checked={sttDeviceChecks.webgpu} onChange={(v) => setSttDeviceChecks((c) => ({ ...c, webgpu: v }))} label="WebGPU" />
          <Toggle checked={sttDeviceChecks.hybrid} onChange={(v) => setSttDeviceChecks((c) => ({ ...c, hybrid: v }))} label="Hybrid" />
          <Toggle checked={sttDeviceChecks.wasm} onChange={(v) => setSttDeviceChecks((c) => ({ ...c, wasm: v }))} label="WASM" />
        </div>
        {sttResults && sttResults.length > 0 && (
          <table class="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Device</th>
                <th>Load ms</th>
                <th>Run 1 ms</th>
                <th>Run 2 ms</th>
                <th>Transcript</th>
              </tr>
            </thead>
            <tbody>
              {sttResults.map((r, i) => (
                <tr key={`${r.model}-${r.device}-${i}`}>
                  <td>{STT_MODELS[r.model].label}</td>
                  <td>{r.device}</td>
                  <td>{r.loadMs === null ? '—' : r.loadMs.toFixed(0)}</td>
                  <td>{r.run1Ms === null ? '—' : r.run1Ms.toFixed(0)}</td>
                  <td>{r.run2Ms === null ? '—' : r.run2Ms.toFixed(0)}</td>
                  <td>{r.transcript}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {localLlmReady() && (
        <Card>
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <h2>Local LLM</h2>
            <Button onClick={runLlmBench} disabled={llmRunning}>
              {llmRunning ? 'Running…' : 'Run LLM benchmark'}
            </Button>
          </div>
          {llmResult && (
            <table class="data-table">
              <thead>
                <tr>
                  <th>First token ms</th>
                  <th>Total ms</th>
                  <th>Reply</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{llmResult.firstTokenMs.toFixed(0)}</td>
                  <td>{llmResult.totalMs.toFixed(0)}</td>
                  <td>{llmResult.text}</td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Card>
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <h2>Wake word</h2>
          <Button onClick={runWakeBench} disabled={wakeRunning}>
            {wakeRunning ? 'Running…' : 'Run wake benchmark'}
          </Button>
        </div>
        <p class="field-hint">Feeds 3 s of silence frames through the wake model and times how fast they can be dispatched.</p>
        {wakeResult && (
          <table class="data-table">
            <thead>
              <tr>
                <th>Frames</th>
                <th>ms</th>
                <th>Frames/s</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{wakeResult.frames}</td>
                <td>{wakeResult.ms.toFixed(0)}</td>
                <td>{wakeResult.framesPerSec.toFixed(0)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
