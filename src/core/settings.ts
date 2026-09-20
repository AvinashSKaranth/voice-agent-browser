import { DEFAULT_SETTINGS, type Settings } from './types';
import { bus } from './bus';

const KEY = 'va.settings';
let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw)) : structuredClone(DEFAULT_SETTINGS);
  } catch {
    cache = structuredClone(DEFAULT_SETTINGS);
  }
  return cache!;
}

export function saveSettings(patch: Partial<Settings> | ((s: Settings) => Settings)): Settings {
  const cur = getSettings();
  const next = typeof patch === 'function' ? patch(structuredClone(cur)) : { ...cur, ...patch };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('settings save failed', e);
  }
  bus.emit({ type: 'settings:changed', settings: next });
  return next;
}

function deepMerge<T extends Record<string, any>>(base: T, over: Record<string, any>): T {
  for (const k of Object.keys(over)) {
    const b = base[k];
    const o = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o)) (base as any)[k] = deepMerge(b, o);
    else (base as any)[k] = o;
  }
  return base;
}
