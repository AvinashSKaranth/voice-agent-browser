// Web Audio playback queue: schedules Float32Array PCM chunks back-to-back on one AudioContext.
// Used by src/audio/tts.ts (Kokoro chunks) and src/audio/pipeline.ts (wake beep).
let ctx: AudioContext | null = null;
let nextStartTime = 0;
let sources: AudioBufferSourceNode[] = [];
let gestureBound = false;

function ensureContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (!gestureBound) {
    gestureBound = true;
    const resume = () => void ctx?.resume();
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
  }
  return ctx;
}

export const player = {
  init(): void {
    const c = ensureContext();
    void c.resume(); // must run synchronously inside the caller's user gesture to unlock audio
  },

  // Queues one PCM chunk after whatever is already scheduled; resolves when that chunk finishes playing.
  enqueue(audio: Float32Array, sampleRate: number): Promise<void> {
    const c = ensureContext();
    void c.resume();
    const buffer = c.createBuffer(1, audio.length, sampleRate);
    buffer.copyToChannel(new Float32Array(audio), 0);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    const startAt = Math.max(c.currentTime, nextStartTime);
    src.start(startAt);
    nextStartTime = startAt + buffer.duration;
    sources.push(src);
    return new Promise((resolve) => {
      src.onended = () => {
        sources = sources.filter((s) => s !== src);
        resolve();
      };
    });
  },

  stop(): void {
    for (const s of sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    sources = [];
    nextStartTime = ctx?.currentTime ?? 0;
  },

  playing(): boolean {
    return sources.length > 0;
  },
};
