// SKILL.md folders in OPFS /skills/<name>/SKILL.md.
import { opfs } from '../storage/opfs';

export interface SkillMeta {
  name: string;
  description: string;
  triggers: string[];
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function sanitizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

// Tolerates missing/partial frontmatter; `fallbackName` (usually the folder
// name) is used when no `name:` field is present.
export function parseFrontmatter(markdown: string, fallbackName: string): SkillMeta {
  let name = fallbackName;
  let description = '';
  let triggers: string[] = [];
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    const lines = m[1].split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) {
        const [, key, val] = kv;
        if (key === 'name' && val.trim()) name = stripQuotes(val.trim());
        else if (key === 'description' && val.trim()) description = stripQuotes(val.trim());
        else if (key === 'triggers') {
          if (val.trim()) {
            triggers = val
              .trim()
              .split(',')
              .map((s) => stripQuotes(s.trim()))
              .filter(Boolean);
            i++;
            continue;
          }
          const items: string[] = [];
          let j = i + 1;
          while (j < lines.length && /^\s*-\s*/.test(lines[j])) {
            items.push(stripQuotes(lines[j].replace(/^\s*-\s*/, '').trim()));
            j++;
          }
          triggers = items.filter(Boolean);
          i = j;
          continue;
        }
      }
      i++;
    }
  }
  return { name, description, triggers };
}

const STARTERS: Record<string, string> = {
  summarise: `---
name: summarise
description: Give a short spoken summary of the current topic or document
triggers: summarise, summarize, tl;dr
---

When this skill is active, give a 3-sentence spoken summary of the content in
view (the document, search results, or the recent conversation). Lead with
the single most important point, then two supporting details. Keep it short
enough to say out loud in under 15 seconds; the full detail stays on screen.
`,
  translate: `---
name: translate
description: Translate the given text and read the translation back aloud
triggers: translate, in spanish, in french
---

Translate the requested text into the target language named by the user (or
implied by the trigger, e.g. "in spanish" -> Spanish). Say the translation
aloud, then show the original and translated text on screen side by side.
`,
  code_review: `---
name: code_review
description: Run a spoken checklist code review over the current diff
triggers: review the code, review this diff
---

Walk the diff and speak findings against this checklist: correctness bugs,
missed error handling, obvious security issues, dead or duplicated code, and
naming clarity. Report only real issues, one sentence each, worst first.

If an "agents" MCP server is connected, this skill can drive a coding agent
(e.g. Claude Code, opencode) through it to apply the fixes on request instead
of only describing them.
`,
};

async function ensureStarters(): Promise<void> {
  const names = await opfs.list('skills');
  if (names.length) return;
  for (const [name, md] of Object.entries(STARTERS)) {
    await opfs.writeText(`skills/${name}/SKILL.md`, md);
  }
}

function parseGithubUrl(url: string):
  | { kind: 'blob' | 'tree'; owner: string; repo: string; branch: string; path: string }
  | null {
  let m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (m) return { kind: 'blob', owner: m[1], repo: m[2], branch: m[3], path: m[4] };
  m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (m) return { kind: 'tree', owner: m[1], repo: m[2], branch: m[3], path: m[4] };
  return null;
}

export const skills = {
  async list(): Promise<SkillMeta[]> {
    await ensureStarters();
    const names = await opfs.list('skills');
    const out: SkillMeta[] = [];
    for (const name of names) {
      const md = await opfs.readText(`skills/${name}/SKILL.md`);
      if (md == null) continue;
      out.push(parseFrontmatter(md, name));
    }
    return out;
  },

  async get(name: string): Promise<string> {
    const md = await opfs.readText(`skills/${sanitizeName(name)}/SKILL.md`);
    if (md == null) throw new Error(`Skill "${name}" not found`);
    return md;
  },

  async save(name: string, markdown: string): Promise<void> {
    await opfs.writeText(`skills/${sanitizeName(name)}/SKILL.md`, markdown);
  },

  async remove(name: string): Promise<void> {
    await opfs.remove(`skills/${sanitizeName(name)}`);
  },

  async match(text: string): Promise<string[]> {
    const lower = text.toLowerCase();
    const all = await this.list();
    return all
      .filter((s) => s.triggers.some((t) => t && lower.includes(t.toLowerCase())) || lower.includes(s.name.toLowerCase()))
      .map((s) => s.name);
  },

  async installFromUrl(url: string): Promise<string> {
    const gh = parseGithubUrl(url);

    if (gh?.kind === 'tree') {
      const apiUrl = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${gh.path}?ref=${gh.branch}`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`GitHub folder lookup failed: ${res.status}`);
      const listing = (await res.json()) as Array<{ name: string; download_url: string; type: string }>;
      const skillFile = listing.find((f) => f.type === 'file' && f.name.toLowerCase() === 'skill.md');
      if (!skillFile) throw new Error('No SKILL.md found in that folder');
      const markdown = await (await fetch(skillFile.download_url)).text();
      const folderName = gh.path.split('/').filter(Boolean).pop() ?? 'skill';
      const meta = parseFrontmatter(markdown, folderName);
      await skills.save(meta.name, markdown);
      for (const f of listing) {
        if (f.type === 'file' && f.name.toLowerCase().endsWith('.md') && f.name.toLowerCase() !== 'skill.md') {
          const text = await (await fetch(f.download_url)).text();
          await opfs.writeText(`skills/${sanitizeName(meta.name)}/${f.name}`, text);
        }
      }
      return meta.name;
    }

    const rawUrl =
      gh?.kind === 'blob' ? `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/${gh.path}` : url;
    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`Could not fetch skill: ${res.status}`);
    const markdown = await res.text();
    const lastSeg = rawUrl.split('/').filter(Boolean).pop() ?? 'skill';
    const folderName = lastSeg.replace(/\.md$/i, '');
    const meta = parseFrontmatter(markdown, folderName);
    await skills.save(meta.name, markdown);
    return meta.name;
  },
};

if (import.meta.env.DEV) {
  const sample = `---\nname: demo\ndescription: A demo skill\ntriggers:\n  - foo\n  - bar baz\n---\n\nBody text.`;
  const parsed = parseFrontmatter(sample, 'fallback');
  console.assert(parsed.name === 'demo', 'skills: name parse failed', parsed);
  console.assert(parsed.description === 'A demo skill', 'skills: description parse failed', parsed);
  console.assert(parsed.triggers.join(',') === 'foo,bar baz', 'skills: YAML-list triggers parse failed', parsed);

  const inline = parseFrontmatter('---\nname: x\ntriggers: a, b, c\n---\nbody', 'fallback');
  console.assert(inline.triggers.join(',') === 'a,b,c', 'skills: comma triggers parse failed', inline);

  const noFrontmatter = parseFrontmatter('just a body', 'my-folder');
  console.assert(noFrontmatter.name === 'my-folder', 'skills: fallback name failed', noFrontmatter);
}
