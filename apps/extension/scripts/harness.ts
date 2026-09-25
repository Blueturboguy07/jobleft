// Test harness helpers: start the stand-in app and the practice server, launch Chrome with the extension, pair,
// open a page and press Fill the way a person does (toolbar button -> popup -> Fill).

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, type Page } from './cdp.ts';

export const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Stack {
  app: ChildProcess | null;
  appPort: number;
  appToken: string;
  appHome: string;
  practice: ChildProcess;
  practicePort: number;
  browser: Browser;
  extId: string;
}

async function waitLine(p: ChildProcess, re: RegExp, ms = 10000): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re}: ${buf}`)), ms);
    p.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(re);
      if (m) { clearTimeout(t); resolve(m); }
    });
  });
}

export async function startApp(home: string, port?: number): Promise<{ proc: ChildProcess; port: number; token: string }> {
  const args = [join(extRoot, 'scripts/standin-app.ts'), '--home', home];
  if (port) args.push('--port', String(port));
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const m = await waitLine(proc, /127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]+)/);
  return { proc, port: Number(m[1]), token: m[2] as string };
}

export async function startPractice(port = 47900): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [join(extRoot, 'scripts/practice-server.ts'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitLine(proc, /practice pages/);
  return proc;
}

export async function appCall(s: { appPort: number; appToken: string }, method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${s.appPort}${path}`, {
    method, headers: { 'x-jobleft-token': s.appToken, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

export async function launch(opts: { headless?: boolean; distDir?: string; args?: string[] } = {}): Promise<{ browser: Browser; extId: string }> {
  const browser = await Browser.launch({ headless: opts.headless, args: opts.args });
  const r = await browser.send<{ id: string }>('Extensions.loadUnpacked', { path: opts.distDir ?? join(extRoot, 'dist') });
  return { browser, extId: r.id };
}

/** Clicks the toolbar button for the tab (activeTab) and returns the popup page. */
export async function openPopup(browser: Browser, extId: string, tab: Page): Promise<Page> {
  for (const t of await browser.targets()) if (t.url.includes(`${extId}/popup.html`)) await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
  // triggerAction wants the TAB target (type "tab") that holds the page; find it by the page's address.
  const url = await tab.eval<string>('location.href');
  const all = await browser.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets', { filter: [{}] });
  const tabTarget = all.targetInfos.find((t) => t.type === 'tab' && t.url === url);
  if (!tabTarget) throw new Error(`no tab target for ${url}`);
  await browser.send('Extensions.triggerAction', { id: extId, targetId: tabTarget.targetId });
  const t = await browser.waitTarget((x) => x.url.includes(`${extId}/popup.html`));
  const p = await browser.attach(t.targetId);
  await waitFor(() => p.eval<boolean>(`!document.querySelector('#content p.muted') || document.querySelector('#content').textContent.indexOf('Checking') < 0`), 10000);
  return p;
}

export async function waitFor(fn: () => Promise<boolean>, ms = 8000, step = 150): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

export async function pair(s: { browser: Browser; extId: string; appPort: number; appToken: string }, tab: Page): Promise<string> {
  const c = await appCall(s, 'POST', '/api/v1/extension/pairing-code') as { code: string };
  const pop = await openPopup(s.browser, s.extId, tab);
  await pop.eval(`(function(){ var i = document.querySelector('input[aria-label="Pairing code"]'); i.value = ${JSON.stringify(c.code)}; Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent==='Pair'}).click(); return true; })()`);
  await waitFor(() => pop.eval<boolean>(`document.body.textContent.indexOf('Paired with jobleft') >= 0`), 8000);
  return pop.eval<string>('document.body.innerText');
}

export async function pressFill(s: { browser: Browser; extId: string }, tab: Page, resumeId?: string): Promise<string> {
  const pop = await openPopup(s.browser, s.extId, tab);
  await waitFor(() => pop.eval<boolean>(`!!Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent==='Fill this application'}) || document.body.innerText.indexOf('not paired') >= 0 || document.body.innerText.indexOf('not running') >= 0`), 10000);
  const text = await pop.eval<string>('document.body.innerText');
  if (resumeId) await pop.eval(`(function(){ var s = document.querySelector('select'); if (s) s.value = ${JSON.stringify(resumeId)}; return true; })()`);
  const clicked = await pop.eval<boolean>(`(function(){ var b = Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent==='Fill this application'}); if (!b) return false; b.click(); return true; })()`);
  if (!clicked) return text;
  await waitFor(() => pop.eval<boolean>(`document.querySelector('.msg') && document.querySelector('.msg').textContent.length > 0 && document.querySelector('.msg').textContent !== 'Starting…'`), 15000).catch(() => false);
  let msg = '';
  try { msg = await pop.eval<string>(`document.querySelector('.msg').textContent`); } catch { msg = '(popup closed)'; }
  return `${text}\n--> ${msg}`;
}

export async function panelText(tab: Page): Promise<string> {
  const t = await tab.textsDeep('[aria-label="jobleft fill report"]');
  return t.join('\n');
}

export async function dump(tab: Page): Promise<Array<{ id: string; name: string; type: string; value: unknown }>> {
  return tab.eval('window.__practiceDump ? window.__practiceDump() : []');
}

export async function practiceLog(port = 47900): Promise<{ counts: { submit: number; next: number; pageChange: number; requests: number }; entries: Array<{ kind: string; path: string; detail: string }> }> {
  const r = await fetch(`http://127.0.0.1:${port}/__log`);
  return r.json() as Promise<{ counts: { submit: number; next: number; pageChange: number; requests: number }; entries: Array<{ kind: string; path: string; detail: string }> }>;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function readJson<T>(p: string): T { return JSON.parse(readFileSync(p, 'utf8')) as T; }
