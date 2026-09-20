// Pre-synthesises every fixed feedback phrase (acks, heartbeat prefix, retry/give-up lines, the
// local-model-loading line) into raw PCM so they play back instantly instead of queueing behind
// Kokoro's (slow, on WASM) synthesis. Persisted in the Cache API so a repeat visit doesn't need to
// re-synthesise before the first ack can play.
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import { player } from './player';
import { tts } from './tts';
import { allCacheablePhrases } from '../core/feedback';

const CACHE_NAME = 'va-ack-v1';

interface Entry {
  audio: Float32Array;
  sampleRate: number;
}

const mem = new Map<string, Entry>(); // ack:// key -> decoded PCM
let warmPromise: Promise<void> | null = null;
let activeResolve: (() => void) | null = null; // mirrors tts.ts's runSay pattern, for stop()

function keyFor(text: string): string {
  const { id, speed } = getSettings().voice;
  const engine = getSettings().local.ttsEngine;
  return `ack://${engine}/${id}/${speed}/${encodeURIComponent(text)}`;
}

// Cache.put()/match() only accept http(s) request URLs, so the ack:// key (used as the in-memory
// Map key, matching the format this module is specified against) is mapped to a fake https URL
// under a reserved local host purely for Cache API storage.
function toCacheUrl(key: string): string {
  return key.replace(/^ack:\/\//, 'https://va-ack.local/');
}
function fromCacheUrl(url: string): string {
  return url.replace(/^https:\/\/va-ack\.local\//, 'ack://');
}

async function loadFromCacheApi(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      const sampleRate = Number(res.headers.get('x-sample-rate') ?? '24000');
      const audio = new Float32Array(await res.arrayBuffer());
      mem.set(fromCacheUrl(req.url), { audio, sampleRate });
    }
  } catch (e) {
    console.warn('ackcache: reading Cache API failed', e);
  }
}
void loadFromCacheApi(); // startup: load whatever a previous session already synthesised

async function storeToCacheApi(key: string, entry: Entry): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const body = new Uint8Array(entry.audio.slice().buffer);
    await cache.put(toCacheUrl(key), new Response(new Blob([body]), { headers: { 'x-sample-rate': String(entry.sampleRate), 'content-type': 'application/octet-stream' } }));
  } catch (e) {
    console.warn('ackcache: writing Cache API failed', e);
  }
}

async function invalidateAll(): Promise<void> {
  mem.clear();
  warmPromise = null;
  if (typeof caches !== 'undefined') {
    try {
      await caches.delete(CACHE_NAME);
    } catch {
      /* best-effort */
    }
  }
}

// Re-synthesise everything when the voice, speed, or engine changes - cached PCM for the old voice/engine is wrong audio.
let lastVoiceKey = `${getSettings().voice.id}/${getSettings().voice.speed}/${getSettings().local.ttsEngine}`;
bus.on('settings:changed', (e) => {
  const key = `${e.settings.voice.id}/${e.settings.voice.speed}/${e.settings.local.ttsEngine}`;
  if (key === lastVoiceKey) return;
  lastVoiceKey = key;
  void invalidateAll().then(() => warm());
});

async function warm(): Promise<void> {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    const { id: voice, speed } = getSettings().voice;
    for (const text of allCacheablePhrases()) {
      const key = keyFor(text);
      if (mem.has(key)) continue;
      // Back off while a real say() is mid-synthesis - warming is background work and must not
      // steal worker time from an actual answer (capped so a stuck flag can't stall warm() forever).
      for (let waited = 0; tts.isSynthesizing() && waited < 20; waited++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      try {
        const entry = await tts.synthToPCM(text, voice, speed);
        mem.set(key, entry);
        void storeToCacheApi(key, entry);
      } catch (e) {
        console.warn('ackcache: warm failed for', text, e);
      }
    }
  })();
  return warmPromise;
}

/** Plays `text` from cache if present; fires and forgets the returned playback promise. */
function playAndWait(text: string): Promise<void> | null {
  const entry = mem.get(keyFor(text));
  if (!entry) return null;
  bus.emit({ type: 'tts:start', text }); // pipeline.ts owns audio:state transitions, not this module
  const done = new Promise<void>((resolve) => {
    activeResolve = resolve;
    void player.enqueue(entry.audio, entry.sampleRate).then(() => {
      if (activeResolve === resolve) activeResolve = null;
      resolve();
    });
  });
  return done.finally(() => bus.emit({ type: 'tts:end' }));
}

export const ackCache = {
  /** Plays `text` instantly if cached. Returns false (no side effect) when not cached. */
  play(text: string): boolean {
    return playAndWait(text) !== null;
  },
  /** Same as play(), but returns the playback promise (used by tts.say() so `await tts.say()` still works for cached lines). */
  playAndWait,
  warm,
  /** Cancels whatever cached ack is currently playing (tts.stop() calls this too). */
  stop(): void {
    activeResolve?.();
    activeResolve = null;
  },
};
