import type { Tool, ToolSpec } from '../core/types';
import { bus } from '../core/bus';

const map = new Map<string, Tool>();

export const tools = {
  register(t: Tool): void {
    map.set(t.spec.name, t); // replaces any existing tool with the same name
    bus.emit({ type: 'tools:changed' });
  },
  unregister(name: string): void {
    if (map.delete(name)) bus.emit({ type: 'tools:changed' });
  },
  get(name: string): Tool | undefined {
    return map.get(name);
  },
  list(): Tool[] {
    return [...map.values()];
  },
  specs(): ToolSpec[] {
    return [...map.values()].map((t) => t.spec);
  },
};
