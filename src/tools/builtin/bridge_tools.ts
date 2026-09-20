// Tools that need the native Rust bridge. Registered only while bridge.connected(), unregistered on disconnect.
import type { Tool } from '../../core/types';
import { bridge } from '../../core/bridge';
import { tools } from '../registry';

const shell_run: Tool = {
  spec: {
    name: 'shell_run',
    description: 'Run a shell command on the paired machine and stream its output back.',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  },
  flags: { bridge: true, confirm: true },
  spoken: 'Running that command',
  async run(args) {
    let out = '';
    const result = await bridge.call<{ output?: string }>('shell.run', { cmd: String(args.cmd ?? '') }, (chunk) => {
      out += chunk;
    });
    return { ok: true, content: (out || result?.output || '').slice(0, 8000) };
  },
};

const terminal_open: Tool = {
  spec: {
    name: 'terminal_open',
    description: "Open the default terminal window at a path on the paired machine.",
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  flags: { bridge: true },
  spoken: 'Opening a terminal',
  async run(args, ctx) {
    await bridge.call('terminal.open', { path: args.path ? String(args.path) : undefined, cmd: ctx.settings.terminal });
    return { ok: true, content: 'Terminal opened' };
  },
};

const app_open: Tool = {
  spec: {
    name: 'app_open',
    description: 'Launch an application by name on the paired machine.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  flags: { bridge: true },
  spoken: 'Opening that app',
  async run(args) {
    await bridge.call('app.open', { name: String(args.name ?? '') });
    return { ok: true, content: `Opened ${args.name}` };
  },
};

const fs_list: Tool = {
  spec: {
    name: 'fs_list',
    description: 'List files in a directory on the paired machine (allowlisted root only).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  flags: { bridge: true },
  spoken: 'Listing files',
  async run(args) {
    const result = await bridge.call<{ entries: string[] }>('fs.list', { path: String(args.path ?? '') });
    return { ok: true, content: (result.entries ?? []).join('\n').slice(0, 8000) };
  },
};

const fs_read: Tool = {
  spec: {
    name: 'fs_read',
    description: 'Read a text file on the paired machine (allowlisted root only).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  flags: { bridge: true },
  spoken: 'Reading that file',
  async run(args) {
    const result = await bridge.call<{ content: string }>('fs.read', { path: String(args.path ?? '') });
    return { ok: true, content: (result.content ?? '').slice(0, 8000) };
  },
};

const fs_write: Tool = {
  spec: {
    name: 'fs_write',
    description: 'Write a text file on the paired machine (allowlisted root only).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  flags: { bridge: true, confirm: true },
  spoken: 'Writing that file',
  async run(args) {
    await bridge.call('fs.write', { path: String(args.path ?? ''), content: String(args.content ?? '') });
    return { ok: true, content: `Wrote ${args.path}` };
  },
};

const screen_capture: Tool = {
  spec: {
    name: 'screen_capture',
    description: 'Take a screenshot on the paired machine, for use with describe_image.',
    parameters: { type: 'object', properties: {} },
  },
  flags: { bridge: true },
  spoken: 'Taking a screenshot',
  async run() {
    const result = await bridge.call<{ images: string[] }>('screen.capture', {});
    return { ok: true, content: 'Captured screen', images: result.images };
  },
};

const BRIDGE_TOOLS = [shell_run, terminal_open, app_open, fs_list, fs_read, fs_write, screen_capture];

export function registerBridgeTools(): void {
  const sync = (connected: boolean) => {
    for (const t of BRIDGE_TOOLS) {
      if (connected) tools.register(t);
      else tools.unregister(t.spec.name);
    }
  };
  sync(bridge.connected());
  bridge.onStatus(sync);
}
