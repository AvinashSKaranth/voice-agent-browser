import { useEffect, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { getSettings, saveSettings } from '../core/settings';
import type { McpServerConfig, Tool, ToolFlags, ToolSpec } from '../core/types';
import { Button, Card, Field, Tabs, Toggle } from './components';
import { skills } from '../extensions/skills';
import { mcp } from '../extensions/mcp';
import { marketplace } from '../extensions/marketplace';
import { customTools } from '../tools/custom';
import { tools } from '../tools/registry';

const TABS = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'custom', label: 'Custom tools' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'tools', label: 'Tools' },
];

export function Extensions() {
  const [active, setActive] = useState('skills');
  return (
    <div>
      <h1>Extensions</h1>
      <Tabs tabs={TABS} active={active} onChange={setActive} />
      {active === 'skills' && <SkillsTab />}
      {active === 'mcp' && <McpTab />}
      {active === 'custom' && <CustomToolsTab />}
      {active === 'marketplace' && <MarketplaceTab />}
      {active === 'tools' && <ToolsTab />}
    </div>
  );
}

const SKILL_TEMPLATE = `---\nname: new-skill\ndescription: What this skill does and when to use it\ntriggers: keyword one, keyword two\n---\n\n# New skill\n\nSteps the agent should follow.\n`;

function SkillsTab() {
  const [list, setList] = useState<Array<{ name: string; description: string; triggers: string[] }>>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [installUrl, setInstallUrl] = useState('');

  function refresh() {
    skills.list().then(setList).catch(() => {});
  }
  useEffect(refresh, []);

  async function open(name: string) {
    setEditingName(name);
    setMarkdown(await skills.get(name));
  }

  async function save() {
    if (!editingName) return;
    await skills.save(editingName, markdown);
    bus.emit({ type: 'toast', level: 'info', text: 'Skill saved.' });
    refresh();
  }

  async function remove(name: string) {
    await skills.remove(name);
    if (editingName === name) setEditingName(null);
    refresh();
  }

  async function newSkill() {
    const name = prompt('Skill name (folder, kebab-case)');
    if (!name) return;
    await skills.save(name, SKILL_TEMPLATE.replace('new-skill', name));
    refresh();
    open(name);
  }

  async function installFromUrl() {
    if (!installUrl.trim()) return;
    try {
      const name = await skills.installFromUrl(installUrl.trim());
      setInstallUrl('');
      refresh();
      bus.emit({ type: 'toast', level: 'info', text: `Installed skill "${name}".` });
    } catch (err) {
      bus.emit({ type: 'toast', level: 'error', text: `Install failed: ${(err as Error).message}` });
    }
  }

  return (
    <div>
      <div class="row">
        <Button onClick={newSkill}>New skill</Button>
        <input class="input" placeholder="GitHub raw URL or repo folder URL" value={installUrl} onChange={(e) => setInstallUrl((e.target as HTMLInputElement).value)} />
        <Button variant="ghost" onClick={installFromUrl}>
          Install from URL
        </Button>
      </div>
      <ul class="doc-list">
        {list.map((s) => (
          <li key={s.name}>
            <div>
              <strong>{s.name}</strong> — {s.description}
              <div class="field-hint">Triggers: {s.triggers.join(', ') || 'none'}</div>
            </div>
            <div class="row">
              <Button variant="ghost" onClick={() => open(s.name)}>
                Edit
              </Button>
              <Button variant="danger" onClick={() => remove(s.name)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {editingName && (
        <Card>
          <h3>{editingName}/SKILL.md</h3>
          <textarea class="textarea mono" rows={16} value={markdown} onChange={(e) => setMarkdown((e.target as HTMLTextAreaElement).value)} />
          <div class="row-end">
            <Button variant="ghost" onClick={() => setEditingName(null)}>
              Close
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function McpTab() {
  const [settings, setSettings] = useState(getSettings());
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; tools: string[]; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function update(servers: McpServerConfig[]) {
    setSettings(saveSettings({ mcp: servers }));
  }

  function startNew() {
    setTestResult(null);
    setEditing({ id: `mcp-${Date.now()}`, label: '', url: '', token: '', enabled: true });
  }

  function startAgentsPreset() {
    setTestResult(null);
    setEditing({ id: 'agents-mcp', label: 'agents-mcp', url: 'http://localhost:3720/mcp', token: '', enabled: true });
  }

  async function save() {
    if (!editing) return;
    const cfg = editing;
    const exists = settings.mcp.some((m) => m.id === cfg.id);
    update(exists ? settings.mcp.map((m) => (m.id === cfg.id ? cfg : m)) : [...settings.mcp, cfg]);
    setEditing(null);
    await mcp.disconnect(cfg.id);
    if (cfg.enabled) {
      try {
        const res = await mcp.connect(cfg);
        bus.emit({ type: 'toast', level: 'info', text: `"${cfg.label}" connected: ${res.tools} tool(s).` });
      } catch (err) {
        bus.emit({ type: 'toast', level: 'error', text: `MCP server "${cfg.label}" failed to connect: ${(err as Error).message}` });
      }
    }
  }

  async function remove(id: string) {
    await mcp.disconnect(id);
    update(settings.mcp.filter((m) => m.id !== id));
  }

  async function test() {
    if (!editing) return;
    setTesting(true);
    try {
      setTestResult(await mcp.test(editing));
    } catch (err) {
      setTestResult({ ok: false, tools: [], error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <ul class="doc-list">
        {settings.tinyfishKey && (
          <li>
            <span>TinyFish search and fetch (REST API, from your TinyFish key). Its MCP endpoint is not browser-reachable, so browser automation needs the bridge.</span>
            <span class="badge">web_search, web_fetch</span>
          </li>
        )}
        {settings.mcp.map((m) => (
          <li key={m.id}>
            <div>
              <strong>{m.label}</strong> — {m.url}
              <div class="field-hint">{m.enabled ? mcp.status(m.id) : 'off'}</div>
            </div>
            <div class="row">
              <Button
                variant="ghost"
                onClick={() => {
                  setTestResult(null);
                  setEditing(m);
                }}
              >
                Edit
              </Button>
              <Button variant="danger" onClick={() => remove(m.id)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div class="row">
        <Button onClick={startNew}>Add server</Button>
        <div class="card preset-card" onClick={startAgentsPreset} role="button" tabIndex={0}>
          <strong>Coding agents</strong>
          <p class="field-hint">Prefills http://localhost:3720/mcp — run `npx agents-mcp` first.</p>
        </div>
      </div>
      {editing && (
        <Card>
          <Field label="Label">
            <input class="input" value={editing.label} onChange={(e) => setEditing({ ...editing, label: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label="URL">
            <input class="input" value={editing.url} onChange={(e) => setEditing({ ...editing, url: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label="Bearer token">
            <input class="input" type="password" value={editing.token || ''} onChange={(e) => setEditing({ ...editing, token: (e.target as HTMLInputElement).value })} />
          </Field>
          <Toggle checked={editing.enabled} onChange={(v) => setEditing({ ...editing, enabled: v })} label="Enabled" />
          <div class="row">
            <Button variant="ghost" onClick={test} disabled={testing}>
              {testing ? 'Testing…' : 'Test'}
            </Button>
          </div>
          {testResult && (
            <p class={testResult.ok ? 'test-ok' : 'test-error'}>
              {testResult.ok ? `Tools: ${testResult.tools.join(', ') || 'none'}` : `Failed: ${testResult.error}`}
            </p>
          )}
          <div class="row-end">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

const WORD_COUNT_EXAMPLE = {
  name: 'word_count',
  description: 'Counts words in a piece of text.',
  parameters: JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, null, 2),
  handler: `export default async function run(args, ctx) {\n  const words = String(args.text || '').trim().split(/\\s+/).filter(Boolean);\n  return { ok: true, content: String(words.length) };\n}\n`,
};

function CustomToolsTab() {
  const [list, setList] = useState<Array<{ name: string; spec: ToolSpec; flags: ToolFlags; handler: string }>>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [paramsText, setParamsText] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const [handler, setHandler] = useState('');
  const [flags, setFlags] = useState<ToolFlags>({});
  const [paramsError, setParamsError] = useState<string | null>(null);

  function refresh() {
    customTools.list().then(setList).catch(() => {});
  }
  useEffect(refresh, []);

  function loadExample() {
    setName(WORD_COUNT_EXAMPLE.name);
    setDescription(WORD_COUNT_EXAMPLE.description);
    setParamsText(WORD_COUNT_EXAMPLE.parameters);
    setHandler(WORD_COUNT_EXAMPLE.handler);
    setFlags({ custom: true });
  }

  function edit(t: { name: string; spec: ToolSpec; flags: ToolFlags; handler: string }) {
    setName(t.name);
    setDescription(t.spec.description);
    setParamsText(JSON.stringify(t.spec.parameters, null, 2));
    setHandler(t.handler);
    setFlags(t.flags);
  }

  async function save() {
    let parameters;
    try {
      parameters = JSON.parse(paramsText);
      setParamsError(null);
    } catch {
      setParamsError('Invalid JSON');
      return;
    }
    if (!name) {
      bus.emit({ type: 'toast', level: 'error', text: 'Tool name is required.' });
      return;
    }
    const spec: ToolSpec = { name, description, parameters };
    await customTools.save(name, spec, { ...flags, custom: true }, handler);
    bus.emit({ type: 'toast', level: 'info', text: 'Custom tool saved.' });
    refresh();
  }

  async function remove(n: string) {
    await customTools.remove(n);
    refresh();
  }

  return (
    <div>
      <ul class="doc-list">
        {list.map((t) => (
          <li key={t.name}>
            <div>
              <strong>{t.name}</strong> — {t.spec.description}
            </div>
            <div class="row">
              <Button variant="ghost" onClick={() => edit(t)}>
                Edit
              </Button>
              <Button variant="danger" onClick={() => remove(t.name)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Card>
        <div class="row">
          <h3>Editor</h3>
          <Button variant="ghost" onClick={loadExample}>
            Load word_count example
          </Button>
        </div>
        <Field label="Name (snake_case)">
          <input class="input" value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Description">
          <input class="input" value={description} onChange={(e) => setDescription((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Parameters (JSON schema)" hint={paramsError || undefined}>
          <textarea class={`textarea mono ${paramsError ? 'has-error' : ''}`} rows={6} value={paramsText} onChange={(e) => setParamsText((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <div class="row">
          <Toggle checked={!!flags.confirm} onChange={(v) => setFlags({ ...flags, confirm: v })} label="Confirm before running" />
          <Toggle checked={!!flags.remote} onChange={(v) => setFlags({ ...flags, remote: v })} label="Makes network calls" />
          <Toggle checked={!!flags.bridge} onChange={(v) => setFlags({ ...flags, bridge: v })} label="Needs bridge" />
        </div>
        <Field label="handler.js">
          <textarea class="textarea mono" rows={10} value={handler} onChange={(e) => setHandler((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <Button onClick={save}>Save</Button>
      </Card>
    </div>
  );
}

function MarketplaceTab() {
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [results, setResults] = useState<Array<{ name: string; description: string; source: string; installUrl: string; pageUrl: string }>>([]);
  const [searching, setSearching] = useState(false);

  async function search() {
    setSearching(true);
    try {
      setResults(await marketplace.search(q, source || undefined));
    } catch (err) {
      bus.emit({ type: 'toast', level: 'error', text: `Search failed: ${(err as Error).message}` });
    } finally {
      setSearching(false);
    }
  }

  async function install(installUrl: string) {
    try {
      await skills.installFromUrl(installUrl);
      bus.emit({ type: 'toast', level: 'info', text: 'Installed.' });
    } catch (err) {
      bus.emit({ type: 'toast', level: 'error', text: `Install failed: ${(err as Error).message}` });
    }
  }

  return (
    <div>
      <div class="row">
        <input class="input" placeholder="Search skills…" value={q} onChange={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <select class="select" value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value)}>
          <option value="">All sources</option>
          {marketplace.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <Button onClick={search} disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </Button>
      </div>
      <ul class="doc-list">
        {results.map((r) => (
          <li key={r.installUrl}>
            <div>
              <strong>{r.name}</strong> — {r.description}
              <div class="field-hint">{r.source}</div>
            </div>
            <div class="row">
              <a class="btn btn-ghost" href={r.pageUrl} target="_blank" rel="noreferrer">
                Open
              </a>
              <Button onClick={() => install(r.installUrl)}>Install</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolsTab() {
  const [list, setList] = useState<Tool[]>([]);
  useEffect(() => {
    setList(tools.list());
    return bus.on('tools:changed', () => setList(tools.list()));
  }, []);
  return (
    <ul class="doc-list">
      {list.map((t) => (
        <li key={t.spec.name}>
          <div>
            <strong>{t.spec.name}</strong> — {t.spec.description}
          </div>
          <div>
            {t.flags?.confirm && <span class="badge">confirm</span>}
            {t.flags?.remote && <span class="badge">remote</span>}
            {t.flags?.bridge && <span class="badge">bridge</span>}
            {t.flags?.custom && <span class="badge">custom</span>}
            {t.flags?.mcp && <span class="badge">mcp:{t.flags.mcp}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
