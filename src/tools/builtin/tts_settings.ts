import type { Tool } from '../../core/types';
import { saveSettings } from '../../core/settings';

export const tts_set_voice: Tool = {
  spec: {
    name: 'tts_set_voice',
    description: "Change the assistant's speaking voice.",
    parameters: { type: 'object', properties: { voice: { type: 'string', description: 'Kokoro voice id, e.g. af_heart' } }, required: ['voice'] },
  },
  spoken: 'Changing my voice',
  async run(args) {
    const voice = String(args.voice ?? '');
    saveSettings((s) => ({ ...s, voice: { ...s.voice, id: voice } }));
    return { ok: true, content: `Voice set to ${voice}` };
  },
};

export const tts_set_rate: Tool = {
  spec: {
    name: 'tts_set_rate',
    description: 'Change the speaking speed (1.0 is normal).',
    parameters: { type: 'object', properties: { rate: { type: 'number' } }, required: ['rate'] },
  },
  spoken: 'Adjusting my speed',
  async run(args) {
    const rate = Number(args.rate);
    saveSettings((s) => ({ ...s, voice: { ...s.voice, speed: rate } }));
    return { ok: true, content: `Speaking speed set to ${rate}` };
  },
};
