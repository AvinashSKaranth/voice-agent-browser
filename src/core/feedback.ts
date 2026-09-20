// Spoken progress feedback (BRD PF-1..PF-8). Filler text produced here never enters the model transcript.
import { tts } from '../audio/tts';
import { ackCache } from '../audio/ackcache';
import { bus } from './bus';
import { getSettings } from './settings';
import { metrics } from './metrics';

const SEARCH_RE = /\b(search|look up|find|google)\b/i;
const ACTION_RE = /\b(open|run|create|make|start|send|schedule)\b/i;
const READ_RE = /\b(read|summarise|summarize|describe|look at|what is in)\b/i;
const CALC_RE = /\b(calculate|how much|convert)\b/i;

export const SEARCH_ACK = 'Let me search for that';
export const ACTION_ACK = 'On it';
export const READ_ACK = 'Let me look at that';
export const CALC_ACK = 'Let me work that out';
export const DEFAULT_ACKS = ['On it', 'One moment', 'Working on it', 'Sure, one second'];
export const HEARTBEAT_PREFIX = 'Still working on it, I am';
export const RETRY_LINE = 'That broke, trying again';
export const GIVEUP_LINE = 'I will stop trying now. Ask me again when you want me to retry.';
export const LOCAL_LOADING_LINE = 'The local model is still loading. I will answer as soon as it is ready.';

/** Every fixed phrase feedback.ts (or orchestrator.ts, for the loading line) can speak - what ackcache.ts pre-synthesises. */
export function allCacheablePhrases(): string[] {
  return Array.from(new Set([SEARCH_ACK, ACTION_ACK, READ_ACK, CALC_ACK, ...DEFAULT_ACKS, HEARTBEAT_PREFIX, RETRY_LINE, GIVEUP_LINE, LOCAL_LOADING_LINE]));
}

let defaultIdx = 0;

// Exported for the dev self-check below; pure so it is trivial to assert against.
export function pickAck(input: string): string {
  if (SEARCH_RE.test(input)) return SEARCH_ACK;
  if (ACTION_RE.test(input)) return ACTION_ACK;
  if (READ_RE.test(input)) return READ_ACK;
  if (CALC_RE.test(input)) return CALC_ACK;
  const phrase = DEFAULT_ACKS[defaultIdx % DEFAULT_ACKS.length];
  defaultIdx++;
  return phrase;
}

const RETRY_DELAYS_MS = [2000, 5000, 10000];

// Set by pipeline.ts's 'turn:ack' event when it already played a cached ack at speech-end, before
// transcription even started; consumed once so a later text turn isn't accidentally skipped too.
let earlyVoiceAckAt = 0;
bus.on('turn:ack', () => {
  earlyVoiceAckAt = Date.now();
});

export function createFeedback(turnId: string) {
  let stageName = 'thinking';
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function say(text: string, kind: 'ack' | 'heartbeat' | 'retry' | 'giveup') {
    bus.emit({ type: 'turn:feedback', id: turnId, kind, text });
    tts.say(text); // tts.say() itself checks ackCache first, so cached lines never enter the worker queue
  }

  return {
    ack(input: string, opts?: { source?: 'voice' | 'text' }): void {
      // Voice turns: pipeline.ts already played a generic ack at speech-end, before STT even ran.
      if (opts?.source === 'voice' && Date.now() - earlyVoiceAckAt < 10000) {
        earlyVoiceAckAt = 0; // consume - don't skip the next text turn's ack too
        return;
      }
      // PF-8: quiet mode keeps acknowledgements, only heartbeat/tool narration are dropped.
      const t0 = performance.now();
      const phrase = pickAck(input);
      bus.emit({ type: 'turn:feedback', id: turnId, kind: 'ack', text: phrase });
      if (!ackCache.play(phrase)) tts.say(phrase);
      // ponytail: measures dispatch latency, not true first-audio time when falling back to the
      // worker queue (that path is covered by the tts.first_audio metric instead).
      metrics.event('ack.latency', performance.now() - t0, phrase, turnId);
    },
    stage(name: string): void {
      stageName = name;
    },
    heartbeatStart(): void {
      if (heartbeatTimer || getSettings().feedback.quiet) return; // PF-8: quiet mode drops heartbeats
      const sec = getSettings().feedback.heartbeatSec;
      heartbeatTimer = setInterval(() => {
        say(`${HEARTBEAT_PREFIX} ${stageName}`, 'heartbeat');
      }, sec * 1000);
    },
    heartbeatStop(): void {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
    async retry(attempt: number): Promise<void> {
      say(RETRY_LINE, 'retry');
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    giveUp(): void {
      say(GIVEUP_LINE, 'giveup');
    },
    dispose(): void {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  };
}

if (import.meta.env.DEV) {
  console.assert(pickAck('search for cats') === 'Let me search for that', 'feedback: search ack');
  console.assert(pickAck('open the terminal') === 'On it', 'feedback: action ack');
  console.assert(pickAck('summarize this document') === 'Let me look at that', 'feedback: read ack');
}
