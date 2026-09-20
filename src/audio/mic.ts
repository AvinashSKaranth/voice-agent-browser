// Microphone: @ricky0123/vad-web MicVAD for utterance boundaries, plus a raw 16 kHz frame tap
// (AudioWorklet, ScriptProcessor fallback) for the wake-word worker. getUserMedia is called once;
// the same MediaStream feeds both, and VAD's pause/resume never stops the tracks, so the worklet
// (and hence wake-word listening) survives pause/resume and backgrounding (VP-10).
import { MicVAD } from '@ricky0123/vad-web';

interface MicHandlers {
  onSpeechStart?(): void;
  onSpeechEnd?(audio: Float32Array): void;
  onFrame?(frame: Float32Array): void;
}

const FRAME_TAP_SOURCE = `
class FrameTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
      while (this._buf.length >= 1280) {
        this.port.postMessage(new Float32Array(this._buf.splice(0, 1280)));
      }
    }
    return true;
  }
}
registerProcessor('frame-tap', FrameTap);
`;

let stream: MediaStream | null = null;
let vad: MicVAD | null = null;
let frameCtx: AudioContext | null = null;
let frameNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let started = false;

async function setupFrameTap(mediaStream: MediaStream, onFrame: (frame: Float32Array) => void): Promise<void> {
  frameCtx = new AudioContext({ sampleRate: 16000 });
  const src = frameCtx.createMediaStreamSource(mediaStream);
  const sink = frameCtx.createGain();
  sink.gain.value = 0; // keep the graph running without audible feedback
  sink.connect(frameCtx.destination);

  try {
    const blobUrl = URL.createObjectURL(new Blob([FRAME_TAP_SOURCE], { type: 'application/javascript' }));
    await frameCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    const node = new AudioWorkletNode(frameCtx, 'frame-tap');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
    src.connect(node);
    node.connect(sink);
    frameNode = node;
  } catch {
    // ScriptProcessor fallback: buffer is fixed-size, so re-chunk to 1280 samples ourselves.
    const node = frameCtx.createScriptProcessor(2048, 1, 1);
    const acc: number[] = [];
    node.onaudioprocess = (e: AudioProcessingEvent) => {
      const ch = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < ch.length; i++) acc.push(ch[i]);
      while (acc.length >= 1280) onFrame(new Float32Array(acc.splice(0, 1280)));
    };
    src.connect(node);
    node.connect(sink);
    frameNode = node;
  }
}

export const mic = {
  async start(h: MicHandlers): Promise<void> {
    if (started) return;
    started = true;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true },
    });
    vad = await MicVAD.new({
      baseAssetPath: './vad/',
      onnxWASMBasePath: './ort/',
      model: 'v5',
      getStream: async () => stream!,
      pauseStream: async () => {},
      resumeStream: async () => stream!,
      positiveSpeechThreshold: 0.6,
      redemptionMs: 600,
      minSpeechMs: 250,
      onSpeechStart: () => h.onSpeechStart?.(),
      onSpeechEnd: (audio: Float32Array) => h.onSpeechEnd?.(audio),
    });
    await vad.start();
    if (h.onFrame) await setupFrameTap(stream, h.onFrame);
  },

  stop(): void {
    void vad?.destroy();
    vad = null;
    frameNode?.disconnect();
    frameNode = null;
    void frameCtx?.close();
    frameCtx = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    started = false;
  },

  pause(): void {
    void vad?.pause();
  },

  resume(): void {
    void vad?.start();
  },

  active(): boolean {
    return started;
  },
};
