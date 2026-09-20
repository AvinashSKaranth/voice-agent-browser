import { useEffect, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import { metrics } from '../core/metrics';
import { tts } from '../audio/tts';
import { stt } from '../audio/stt';
import { wake } from '../audio/wake';
import { localProvider, localLlmReady } from '../providers/local';
import { Button, Card } from './components';

const SENTENCE = 'The quick brown fox jumps over the lazy dog near the riverbank this morning.';
const HAS_GPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

interface TtsRun {
  device: string;
  loadMs: number;
  runs: Array<{ synthMs: number; firstAudioMs: number; audioSec: number; realtime: number }>;
}
interface SttRun {
  device: string;
  loadMs: number;
  transcribeMs: number;
  text: string;
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
  const [lastAudio, setLastAudio] = useState<{ audio: Float32Array; sampleRate: number } | null>(null);
  const [sttResults, setSttResults] = useState<SttRun[] | null>(null);
  const [sttRunning, setSttRunning] = useState(false);
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

  async function runTtsBench() {
    setTtsRunning(true);
    setTtsResults(null);
    try {
      const { id: voice, speed } = getSettings().voice;
      const devices: Array<'wasm' | 'webgpu'> = HAS_GPU ? ['wasm', 'webgpu'] : ['wasm'];
      const out: TtsRun[] = [];
      for (const device of devices) {
        const l0 = performance.now();
        await tts.reloadWith(device);
        const loadMs = performance.now() - l0;
        const runs: TtsRun['runs'] = [];
        for (let i = 0; i < 3; i++) {
          let firstAudioMs = 0;
          const s0 = performance.now();
          const result = await tts.synthToPCM(SENTENCE, voice, speed, (ms) => (firstAudioMs = ms));
          const synthMs = performance.now() - s0;
          const audioSec = result.audio.length / result.sampleRate;
          runs.push({ synthMs, firstAudioMs, audioSec, realtime: audioSec / (synthMs / 1000) });
          setLastAudio(result);
        }
        out.push({ device, loadMs, runs });
        const avgSynth = runs.reduce((a, r) => a + r.synthMs, 0) / runs.length;
        metrics.event(`bench.tts.${device}`, avgSynth, `load=${loadMs.toFixed(0)}ms`);
      }
      setTtsResults(out);
    } catch (e) {
      bus.emit({ type: 'toast', level: 'error', text: `TTS bench failed: ${(e as Error).message}` });
    } finally {
      setTtsRunning(false);
      void tts.load().catch(() => {}); // restore the normal (settings-resolved) device for real speech
    }
  }

  async function runSttBench() {
    if (!lastAudio) {
      bus.emit({ type: 'toast', level: 'warn', text: 'Run the TTS benchmark first - STT reuses that audio.' });
      return;
    }
    setSttRunning(true);
    setSttResults(null);
    try {
      const audio16k = await resampleTo16k(lastAudio.audio, lastAudio.sampleRate);
      const devices: Array<'webgpu' | 'wasm'> = HAS_GPU ? ['webgpu', 'wasm'] : ['wasm'];
      const out: SttRun[] = [];
      for (const device of devices) {
        const l0 = performance.now();
        try {
          await stt.reloadWith(device);
        } catch {
          continue; // device unsupported here; skip it rather than fail the whole run
        }
        const loadMs = performance.now() - l0;
        for (let run = 1; run <= 2; run++) {
          const s0 = performance.now();
          const text = await stt.transcribe(audio16k.slice());
          const transcribeMs = performance.now() - s0;
          out.push({ device: `${device} run ${run}`, loadMs: run === 1 ? loadMs : 0, transcribeMs, text });
          metrics.event(`bench.stt.${device}`, transcribeMs, text.slice(0, 80));
        }
      }
      setSttResults(out);
    } catch (e) {
      bus.emit({ type: 'toast', level: 'error', text: `STT bench failed: ${(e as Error).message}` });
    } finally {
      setSttRunning(false);
      void stt.load(); // restore auto device selection
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
          <h2>TTS (Kokoro)</h2>
          <Button onClick={runTtsBench} disabled={ttsRunning}>
            {ttsRunning ? 'Running…' : 'Run TTS benchmark'}
          </Button>
        </div>
        {ttsResults && (
          <table class="data-table">
            <thead>
              <tr>
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
                  <tr key={`${r.device}-${i}`}>
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
          <h2>STT (Whisper)</h2>
          <Button onClick={runSttBench} disabled={sttRunning}>
            {sttRunning ? 'Running…' : 'Run STT benchmark'}
          </Button>
        </div>
        <p class="field-hint">Reuses the audio synthesised by the TTS benchmark above, resampled to 16 kHz.</p>
        {sttResults && (
          <table class="data-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Load ms</th>
                <th>Transcribe ms</th>
                <th>Transcript</th>
              </tr>
            </thead>
            <tbody>
              {sttResults.map((r) => (
                <tr key={r.device}>
                  <td>{r.device}</td>
                  <td>{r.loadMs.toFixed(0)}</td>
                  <td>{r.transcribeMs.toFixed(0)}</td>
                  <td>{r.text}</td>
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
