// WebSocket client for the optional Rust native bridge (`voicebridge`, ws://127.0.0.1:7711).
// Protocol: {id, cmd, params} requests; {id, result} | {id, error:{message}} | {id, stream} replies.
// See BRD.md "Native bridge" and ARCHITECTURE.md for the exact shape.
import { getSettings, saveSettings } from './settings';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onStream?: (chunk: string) => void;
}

interface ServerMsg {
  id: string;
  result?: unknown;
  error?: { message: string };
  stream?: string;
}

// ponytail: fixed 5-try backoff ladder (last delay repeats); add jitter/unlimited retry only if
// real-world bridge flakiness shows this isn't enough.
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 10000];

let ws: WebSocket | null = null;
let isConnected = false;
let commandList: string[] = [];
let reconnectAttempt = 0;
let lastError: string | undefined;
let inFlight: Promise<boolean> | null = null;
const pending = new Map<string, PendingCall>();
const statusListeners = new Set<(c: boolean) => void>();

function setConnected(c: boolean) {
  if (isConnected === c) return;
  isConnected = c;
  statusListeners.forEach((fn) => fn(c));
}

function handleMessage(raw: string) {
  let msg: ServerMsg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  if (msg.stream !== undefined) {
    p.onStream?.(msg.stream);
    return;
  }
  pending.delete(msg.id);
  if (msg.error) {
    lastError = msg.error.message;
    p.reject(new Error(msg.error.message));
    return;
  }
  p.resolve(msg.result);
}

function rawCall<T>(cmd: string, params?: Record<string, unknown>, onStream?: (chunk: string) => void, signal?: AbortSignal): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Bridge not connected.'));
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  const id = crypto.randomUUID();
  const socket = ws;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      reject(new Error('aborted'));
      try {
        socket.send(JSON.stringify({ id, cmd: 'bridge.cancel', params: { id } }));
      } catch {
        /* best-effort cancel notice; the call is already rejected locally */
      }
    };
    signal?.addEventListener('abort', onAbort);
    pending.set(id, {
      resolve: (v: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        (resolve as (v: unknown) => void)(v);
      },
      reject: (e: Error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
      onStream,
    });
    socket.send(JSON.stringify({ id, cmd, params }));
  });
}

function scheduleReconnect() {
  if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) return;
  const delay = RECONNECT_DELAYS_MS[reconnectAttempt++];
  setTimeout(() => {
    bridge.connect();
  }, delay);
}

function openSocket(): Promise<boolean> {
  const settings = getSettings();
  return new Promise<boolean>((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(settings.bridge.url);
    } catch {
      resolve(false);
      return;
    }
    ws = socket;
    let settled = false;
    socket.addEventListener('message', (ev) => handleMessage(String(ev.data)));
    socket.addEventListener('open', async () => {
      try {
        const result = await rawCall<{ version?: string; commands?: string[] }>('bridge.hello', {
          token: settings.bridge.token,
          origin: location.origin,
        });
        commandList = result.commands ?? [];
        reconnectAttempt = 0;
        setConnected(true);
        settled = true;
        resolve(true);
      } catch {
        settled = true;
        resolve(false);
        socket.close();
      }
    });
    socket.addEventListener('close', () => {
      setConnected(false);
      ws = null;
      for (const p of pending.values()) p.reject(new Error('bridge disconnected'));
      pending.clear();
      if (!settled) {
        settled = true;
        resolve(false);
      }
      scheduleReconnect();
    });
    // 'close' always follows 'error' on WebSocket, so reconnect scheduling lives there only.
    socket.addEventListener('error', () => {});
  });
}

export const bridge = {
  connect(): Promise<boolean> {
    if (inFlight) return inFlight;
    inFlight = openSocket().finally(() => {
      inFlight = null;
    });
    return inFlight;
  },
  connected(): boolean {
    return isConnected;
  },
  call<T = unknown>(cmd: string, params?: Record<string, unknown>, onStream?: (chunk: string) => void, signal?: AbortSignal): Promise<T> {
    return rawCall<T>(cmd, params, onStream, signal);
  },
  onStatus(cb: (c: boolean) => void): () => void {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  },
  // Additive: exact list in ARCHITECTURE.md plus this and pair(), needed for provider.proxy
  // routing (openai-compatible.ts) and the bridge.pair flow (BRD.md "Pairing").
  commands(): string[] {
    return commandList;
  },
  async pair(code: string): Promise<boolean> {
    try {
      const result = await rawCall<{ token?: string }>('bridge.pair', { code });
      if (!result.token) return false;
      const token = result.token;
      saveSettings((s) => ({ ...s, bridge: { ...s.bridge, token } }));
      return true;
    } catch {
      return false;
    }
  },
  lastError(): string | undefined {
    return lastError;
  },
};
