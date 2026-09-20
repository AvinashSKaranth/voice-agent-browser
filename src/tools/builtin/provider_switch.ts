import type { Tool } from '../../core/types';
import { saveSettings } from '../../core/settings';

const provider_switch: Tool = {
  spec: {
    name: 'provider_switch',
    description: 'Switch which model answers the conversation: "local", "cloud", a specific provider id, or a specific model name.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: '"local", "cloud", a provider id, or a model name' } },
      required: ['target'],
    },
  },
  spoken: 'Switching',
  async run(args, ctx) {
    const target = String(args.target ?? '').trim();
    if (!target) return { ok: false, content: '', error: 'No target given' };

    if (target === 'local' || target === 'cloud') {
      saveSettings({ mode: target });
      return { ok: true, content: `Switched to ${target}` };
    }

    const provider = ctx.settings.providers.find((p) => p.id === target || p.model === target || p.label.toLowerCase() === target.toLowerCase());
    if (!provider) return { ok: false, content: '', error: `No provider or model named "${target}"` };
    saveSettings({ mode: 'cloud', activeProviderId: provider.id });
    return { ok: true, content: `Switched to ${provider.label}` };
  },
};

export default provider_switch;
