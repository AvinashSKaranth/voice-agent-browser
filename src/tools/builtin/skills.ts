import type { Tool } from '../../core/types';
import { marketplace } from '../../extensions/marketplace';
import { skills } from '../../extensions/skills';

export const skills_search: Tool = {
  spec: {
    name: 'skills_search',
    description: 'Search skill marketplaces for a skill by keyword.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, source: { type: 'string' } }, required: ['query'] },
  },
  spoken: 'Searching for skills',
  async run(args) {
    const query = String(args.query ?? '');
    const source = args.source ? String(args.source) : undefined;
    const results = await marketplace.search(query, source);
    if (!results.length) return { ok: true, content: 'No matching skills found.' };
    return { ok: true, content: results.map((r) => `${r.name} (${r.source}): ${r.description} — ${r.pageUrl}`).join('\n') };
  },
};

export const skills_install: Tool = {
  spec: {
    name: 'skills_install',
    description: 'Install a skill from its source URL.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  flags: { confirm: true },
  spoken: 'Installing that skill',
  async run(args) {
    const url = String(args.url ?? '');
    const name = await skills.installFromUrl(url);
    return { ok: true, content: `Installed skill "${name}"` };
  },
};

export const use_skill: Tool = {
  spec: {
    name: 'use_skill',
    description: 'Load the full body of a named skill into context.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  spoken: 'Loading that skill',
  async run(args) {
    const name = String(args.name ?? '');
    try {
      return { ok: true, content: await skills.get(name) };
    } catch (e) {
      return { ok: false, content: '', error: `No skill named "${name}": ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
