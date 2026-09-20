// Skill marketplace search: one API source (SkillsMP), one code-search source
// (GitHub), and four listing sites that block browser fetches with CORS, so
// they fall back to a "open it yourself and paste the link" result.
export interface MarketplaceResult {
  name: string;
  description: string;
  source: string;
  installUrl: string;
  pageUrl: string;
}

function githubBlobToRaw(htmlUrl: string): string {
  const m = htmlUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : htmlUrl;
}

async function searchSkillsMp(q: string): Promise<MarketplaceResult[]> {
  const endpoints = [
    `https://skillsmp.com/api/skills/search?q=${encodeURIComponent(q)}&limit=20`,
    `https://skillsmp.com/api/search?q=${encodeURIComponent(q)}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as unknown;
      const items = Array.isArray(data)
        ? data
        : ((data as any)?.results ?? (data as any)?.items ?? (data as any)?.data ?? []);
      if (!Array.isArray(items) || !items.length) continue;
      return items.map((it: any) => ({
        name: it.name ?? it.title ?? 'Untitled skill',
        description: it.description ?? '',
        source: 'skillsmp',
        installUrl: it.github_url ?? it.url ?? it.repo ?? '',
        pageUrl: it.page_url ?? it.url ?? 'https://skillsmp.com',
      }));
    } catch {
      // try the next endpoint shape
    }
  }
  return [];
}

async function searchGithub(q: string): Promise<MarketplaceResult[]> {
  const url = `https://api.github.com/search/code?q=filename:SKILL.md+${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`github search: ${res.status}`);
  const data = (await res.json()) as { items?: any[] };
  return (data.items ?? []).map((it) => ({
    name: it.repository?.full_name ?? it.name ?? 'SKILL.md',
    description: it.path ?? '',
    source: 'github',
    installUrl: githubBlobToRaw(it.html_url ?? ''),
    pageUrl: it.html_url ?? '',
  }));
}

// These sites serve server-rendered listing pages with no public API and no
// CORS allowance, so a browser fetch fails; hand back a link the user can
// open themselves instead of trying to scrape arbitrary HTML.
async function siteSearchFallback(sourceId: string, label: string, siteSearchUrl: string, q: string): Promise<MarketplaceResult[]> {
  try {
    const res = await fetch(siteSearchUrl, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    // expected: CORS or network failure
  }
  return [
    {
      name: `Open ${label} search for "${q}"`,
      description: 'This site blocks browser search; open it and paste the GitHub link here.',
      source: sourceId,
      installUrl: '',
      pageUrl: siteSearchUrl,
    },
  ];
}

const SOURCE_LIST = [
  { id: 'skillsmp', label: 'SkillsMP', url: 'https://skillsmp.com' },
  { id: 'awesomeskill', label: 'Awesome Skills', url: 'https://awesomeskill.ai' },
  { id: 'skillhub', label: 'SkillHub', url: 'https://www.skill-marketplace.com/marketplace' },
  { id: 'mcpmarket', label: 'MCP Market', url: 'https://mcpmarket.com/tools/skills' },
  { id: 'qoder', label: 'Qoder', url: 'https://qoder.com/en/marketplace' },
  { id: 'github', label: 'GitHub', url: 'https://github.com/search' },
];

function runners(q: string): Record<string, () => Promise<MarketplaceResult[]>> {
  return {
    skillsmp: () => searchSkillsMp(q),
    github: () => searchGithub(q),
    awesomeskill: () => siteSearchFallback('awesomeskill', 'Awesome Skills', `https://awesomeskill.ai/?q=${encodeURIComponent(q)}`, q),
    skillhub: () =>
      siteSearchFallback('skillhub', 'SkillHub', `https://www.skill-marketplace.com/marketplace?q=${encodeURIComponent(q)}`, q),
    mcpmarket: () => siteSearchFallback('mcpmarket', 'MCP Market', `https://mcpmarket.com/tools/skills?q=${encodeURIComponent(q)}`, q),
    qoder: () => siteSearchFallback('qoder', 'Qoder', `https://qoder.com/en/marketplace?q=${encodeURIComponent(q)}`, q),
  };
}

export const marketplace = {
  sources: SOURCE_LIST.map(({ id, label, url }) => ({ id, label, url })),

  async search(q: string, sourceId?: string): Promise<MarketplaceResult[]> {
    const all = runners(q);
    const ids = sourceId ? [sourceId] : Object.keys(all);
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return (await all[id]?.()) ?? [];
        } catch {
          return [];
        }
      })
    );
    return results.flat();
  },
};
