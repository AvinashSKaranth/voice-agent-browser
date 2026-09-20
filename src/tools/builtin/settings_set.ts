import type { Tool } from '../../core/types';
import { saveSettings } from '../../core/settings';
import type { Settings } from '../../core/types';

const WHITELIST = ['wake.enabled', 'wake.pushToTalk', 'feedback.quiet', 'feedback.heartbeatSec', 'mode'] as const;
type WhitelistedKey = (typeof WHITELIST)[number];

function applyPatch(settings: Settings, key: WhitelistedKey, value: unknown): Settings {
  switch (key) {
    case 'wake.enabled':
      return { ...settings, wake: { ...settings.wake, enabled: Boolean(value) } };
    case 'wake.pushToTalk':
      return { ...settings, wake: { ...settings.wake, pushToTalk: Boolean(value) } };
    case 'feedback.quiet':
      return { ...settings, feedback: { ...settings.feedback, quiet: Boolean(value) } };
    case 'feedback.heartbeatSec':
      return { ...settings, feedback: { ...settings.feedback, heartbeatSec: Number(value) } };
    case 'mode':
      return { ...settings, mode: value === 'cloud' ? 'cloud' : 'local' };
  }
}

const settings_set: Tool = {
  spec: {
    name: 'settings_set',
    description: `Change a setting by voice. Allowed keys: ${WHITELIST.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', enum: [...WHITELIST] }, value: {} },
      required: ['key', 'value'],
    },
  },
  spoken: 'Updating that setting',
  async run(args) {
    const key = String(args.key ?? '');
    if (!(WHITELIST as readonly string[]).includes(key)) return { ok: false, content: '', error: `Setting "${key}" cannot be changed by voice` };
    saveSettings((s) => applyPatch(s, key as WhitelistedKey, args.value));
    return { ok: true, content: `Set ${key} to ${JSON.stringify(args.value)}` };
  },
};

export default settings_set;
