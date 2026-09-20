import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '../src/core/types';

beforeEach(() => {
  vi.resetModules(); // registry.ts keeps tools in a module-level Map; isolate each test
});

function makeTool(name: string, description = 'd'): Tool {
  return {
    spec: { name, description, parameters: { type: 'object', properties: {} } },
    async run() {
      return { ok: true, content: '' };
    },
  };
}

describe('tools registry', () => {
  it('registers, lists and returns specs for a tool', async () => {
    const { tools } = await import('../src/tools/registry');
    const t = makeTool('greet');
    tools.register(t);
    expect(tools.get('greet')).toBe(t);
    expect(tools.list()).toEqual([t]);
    expect(tools.specs()).toEqual([t.spec]);
  });

  it('replaces an existing tool registered under the same name', async () => {
    const { tools } = await import('../src/tools/registry');
    tools.register(makeTool('greet', 'first'));
    const second = makeTool('greet', 'second');
    tools.register(second);
    expect(tools.list()).toHaveLength(1);
    expect(tools.get('greet')).toBe(second);
  });

  it('unregisters a tool by name', async () => {
    const { tools } = await import('../src/tools/registry');
    tools.register(makeTool('greet'));
    tools.unregister('greet');
    expect(tools.get('greet')).toBeUndefined();
    expect(tools.list()).toEqual([]);
  });

  it('emits tools:changed on register and unregister, but not on a no-op unregister', async () => {
    const { tools } = await import('../src/tools/registry');
    const { bus } = await import('../src/core/bus');
    const seen: string[] = [];
    bus.on('tools:changed', () => seen.push('changed'));

    tools.register(makeTool('greet'));
    expect(seen).toEqual(['changed']);

    tools.unregister('greet');
    expect(seen).toEqual(['changed', 'changed']);

    tools.unregister('does-not-exist');
    expect(seen).toEqual(['changed', 'changed']); // no event for a name that was never registered
  });
});
