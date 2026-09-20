import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/types';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules(); // settings.ts caches state in a module-level variable; force a fresh instance per test
});

describe('settings', () => {
  it('getSettings returns a deep clone of DEFAULT_SETTINGS when nothing is stored', async () => {
    const { getSettings } = await import('../src/core/settings');
    const s = getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s).not.toBe(DEFAULT_SETTINGS); // must not hand back the shared default object
  });

  it('deepMerge fills in missing nested fields from DEFAULT_SETTINGS on load', async () => {
    localStorage.setItem('va.settings', JSON.stringify({ feedback: { heartbeatSec: 45 } }));
    const { getSettings } = await import('../src/core/settings');
    const s = getSettings();
    expect(s.feedback.heartbeatSec).toBe(45); // overridden
    expect(s.feedback.maxRetries).toBe(DEFAULT_SETTINGS.feedback.maxRetries); // untouched sibling survives the merge
    expect(s.feedback.quiet).toBe(DEFAULT_SETTINGS.feedback.quiet);
  });

  it('saveSettings persists to localStorage and getSettings round-trips it after reload', async () => {
    const mod1 = await import('../src/core/settings');
    mod1.saveSettings({ setupDone: true, mode: 'cloud' });

    const raw = localStorage.getItem('va.settings');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject({ setupDone: true, mode: 'cloud' });

    // Simulate a page reload: fresh module instance, no in-memory cache.
    vi.resetModules();
    const mod2 = await import('../src/core/settings');
    const reloaded = mod2.getSettings();
    expect(reloaded.setupDone).toBe(true);
    expect(reloaded.mode).toBe('cloud');
  });
});
