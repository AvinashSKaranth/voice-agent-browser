import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/extensions/skills';

describe('parseFrontmatter', () => {
  it('parses comma-separated triggers', () => {
    const md = '---\nname: x\ndescription: desc\ntriggers: a, b, c\n---\nbody';
    const meta = parseFrontmatter(md, 'fallback');
    expect(meta).toEqual({ name: 'x', description: 'desc', triggers: ['a', 'b', 'c'] });
  });

  it('parses a YAML-list triggers block', () => {
    const md = '---\nname: demo\ndescription: A demo skill\ntriggers:\n  - foo\n  - bar baz\n---\n\nBody text.';
    const meta = parseFrontmatter(md, 'fallback');
    expect(meta).toEqual({ name: 'demo', description: 'A demo skill', triggers: ['foo', 'bar baz'] });
  });

  it('falls back to the folder name when frontmatter is missing', () => {
    const meta = parseFrontmatter('just a body, no frontmatter here', 'my-folder');
    expect(meta).toEqual({ name: 'my-folder', description: '', triggers: [] });
  });
});
