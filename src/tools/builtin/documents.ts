import type { Tool } from '../../core/types';
import { documents } from '../documents';

export const read_document: Tool = {
  spec: {
    name: 'read_document',
    description: 'Return the text of an uploaded document by name or id. With no argument, lists the uploaded documents.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Document name (as shown in the Documents list)' },
        id: { type: 'string', description: 'Document id' },
      },
    },
  },
  spoken: 'Let me look at that',
  async run(args) {
    const key = args.id ? String(args.id) : args.name ? String(args.name) : undefined;
    if (!key) {
      const list = await documents.list();
      if (!list.length) return { ok: true, content: 'No documents uploaded yet.' };
      return { ok: true, content: list.map((d) => `${d.name} (${d.id})`).join('\n') };
    }
    try {
      return { ok: true, content: await documents.get(key) };
    } catch (e) {
      return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const search_documents: Tool = {
  spec: {
    name: 'search_documents',
    description: 'Semantic search across uploaded documents; returns matching snippets with document names.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  spoken: 'Searching your documents',
  async run(args) {
    const query = String(args.query ?? '');
    const results = await documents.search(query);
    if (!results.length) return { ok: true, content: 'No matching documents.' };
    return { ok: true, content: results.map((r) => `${r.name}: ${r.snippet}`).join('\n---\n') };
  },
};
