// Spoken progress feedback (BRD PF-1..PF-8). Filler text produced here never enters the model transcript.
import { tts } from '../audio/tts';
import { bus } from './bus';
import { getSettings } from './settings';

const SEARCH_RE = /\b(search|look up|find|google)\b/i;
const ACTION_RE = /\b(open|run|create|make|start|send|schedule)\b/i;
const READ_RE = /\b(read|summarise|summarize|describe|look at|what is in)\b/i;
const CALC_RE = /\b(calculate|how much|convert)\b/i;
const DEFAULT_ACKS = ['On it', 'One moment', 'Working on it', 'Sure, one second'];

let defaultIdx = 0;

// Exported for the dev self-check below; pure so it is trivial to assert against.
export function pickAck(input: string): string {
  if (SEARCH_RE.test(input)) return 'Let me search for that';
  if (ACTION_RE.test(input)) return 'On it';
  if (READ_RE.test(input)) return 'Let me look at that';
  if (CALC_RE.test(input)) return 'Let me work that out';
  const phrase = DEFAULT_ACKS[defaultIdx % DEFAULT_ACKS.length];
  defaultIdx++;
  return phrase;
}

const RETRY_DELAYS_MS = [2000, 5000, 10000];

export function createFeedback(turnId: string) {
  let stageName = 'thinking';
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function say(text: string, kind: 'ack' | 'heartbeat' | 'retry' | 'giveup') {
    bus.emit({ type: 'turn:feedback', id: turnId, kind, text });
    tts.say(text);
  }

  return {
    ack(input: string): void {
      // PF-8: quiet mode keeps acknowledgements, only heartbeat/tool narration are dropped.
      say(pickAck(input), 'ack');
    },
    stage(name: string): void {
      stageName = name;
    },
    heartbeatStart(): void {
      if (heartbeatTimer || getSettings().feedback.quiet) return; // PF-8: quiet mode drops heartbeats
      const sec = getSettings().feedback.heartbeatSec;
      heartbeatTimer = setInterval(() => {
        say(`Still working on it, I am ${stageName}`, 'heartbeat');
      }, sec * 1000);
    },
    heartbeatStop(): void {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
    async retry(attempt: number): Promise<void> {
      say('That broke, trying again', 'retry');
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    giveUp(): void {
      say('I will stop trying now. Ask me again when you want me to retry.', 'giveup');
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
