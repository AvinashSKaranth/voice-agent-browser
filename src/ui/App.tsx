import { useEffect, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { getSettings } from '../core/settings';
import type { Settings } from '../core/types';
import { initDb } from '../storage/db';
import { registerBuiltinTools } from '../tools/builtin';
import { customTools } from '../tools/custom';
import { scheduler } from '../tools/schedule';
import { mcp } from '../extensions/mcp';
import { Landing } from './Landing';
import { Wizard } from './Wizard';
import { Assistant } from './Assistant';
import { Settings as SettingsPage } from './Settings';
import { Extensions } from './Extensions';
import { Documents } from './Documents';
import { Button, Modal, ToastHost } from './components';

function parseHash(): { path: string; query: URLSearchParams } {
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs) };
}

export function App() {
  const [route, setRoute] = useState(parseHash());
  const [settings, setSettings] = useState<Settings>(getSettings());
  const [confirmReq, setConfirmReq] = useState<{ id: string; question: string } | null>(null);

  // Boot sequence + live routing/settings subscriptions.
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    const offSettings = bus.on('settings:changed', (e) => setSettings(e.settings));
    const offConfirm = bus.on('confirm:request', (e) => setConfirmReq({ id: e.id, question: e.question }));

    async function boot() {
      const steps: Array<[string, () => Promise<unknown> | unknown]> = [
        ['Database', () => initDb()],
        ['Tools', () => registerBuiltinTools()],
        ['Custom tools', () => customTools.loadAll()],
        ['Scheduler', () => scheduler.start()],
        ['MCP', () => mcp.connectAll()],
      ];
      for (const [label, fn] of steps) {
        try {
          await fn();
        } catch (err) {
          bus.emit({ type: 'toast', level: 'error', text: `${label} failed to start: ${(err as Error).message}` });
        }
      }
    }
    boot();

    return () => {
      window.removeEventListener('hashchange', onHash);
      offSettings();
      offConfirm();
    };
  }, []);

  // Landing → Assistant redirect once setup is complete.
  useEffect(() => {
    if (route.path === '/' && settings.setupDone) location.hash = '#/assistant';
  }, [route.path, settings.setupDone]);

  // Setup not done: every route except landing and setup itself redirects to landing (deep links
  // like #/assistant must not mount and start downloading models before setup has run).
  useEffect(() => {
    if (!settings.setupDone && route.path !== '/' && route.path !== '/setup') location.hash = '#/';
  }, [route.path, settings.setupDone]);

  function answerConfirm(ok: boolean) {
    if (!confirmReq) return;
    bus.emit({ type: 'confirm:answer', id: confirmReq.id, ok });
    setConfirmReq(null);
  }

  // Guarded path: same as route.path, except any route besides '/' and '/setup' collapses to '/'
  // until setup is done, so gated pages (Assistant etc.) never mount and kick off model loads.
  const path = !settings.setupDone && route.path !== '/' && route.path !== '/setup' ? '/' : route.path;

  let page;
  if (path === '/setup') {
    const stepParam = route.query.get('step');
    page = <Wizard initialStep={stepParam ? Number(stepParam) : undefined} />;
  } else if (path === '/assistant') page = <Assistant />;
  else if (path === '/settings') page = <SettingsPage />;
  else if (path === '/extensions') page = <Extensions />;
  else if (path === '/documents') page = <Documents />;
  else page = settings.setupDone ? <Assistant /> : <Landing />;

  return (
    <div class="app-shell">
      {settings.setupDone && (
        <nav class="topnav">
          <a href="#/assistant" class={route.path === '/assistant' || route.path === '/' ? 'active' : ''}>
            Assistant
          </a>
          <a href="#/documents" class={route.path === '/documents' ? 'active' : ''}>
            Documents
          </a>
          <a href="#/extensions" class={route.path === '/extensions' ? 'active' : ''}>
            Extensions
          </a>
          <a href="#/settings" class={route.path === '/settings' ? 'active' : ''}>
            Settings
          </a>
        </nav>
      )}
      <main class="app-main">{page}</main>
      <ToastHost />
      <Modal open={!!confirmReq} onClose={() => answerConfirm(false)} title="Confirm">
        <p>{confirmReq?.question}</p>
        <div class="row-end">
          <Button variant="ghost" onClick={() => answerConfirm(false)}>
            No
          </Button>
          <Button onClick={() => answerConfirm(true)}>Yes</Button>
        </div>
      </Modal>
    </div>
  );
}
