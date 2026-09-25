// A browser walk through the Network screens, in headless Chrome with a scratch profile (never your own Chrome).
// It starts a dev server on a fresh data folder under /private/tmp, imports the demo fixture through the file picker,
// opens each screen, drafts with the local mock AI, edits one word, copies, and checks that the clipboard holds
// exactly the edited text. Screenshots go to --out (default /private/tmp/jobleft-network-ui).
//   node packages/network/scripts/ui-check.ts [--out <dir>] [--keep]

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDevServer } from '../src/dev/server.ts';
import { startMockAi } from '../src/dev/mock-ai.ts';
import { demoFixture } from '../src/dev/fixture.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1]! : '/private/tmp/jobleft-network-ui';
const keep = args.includes('--keep');
const home = `/private/tmp/jobleft-network-ui-home-${process.pid}`;
const profile = `/private/tmp/jobleft-network-ui-chrome-${process.pid}`;

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };

class Cdp {
  private ws: WebSocket;
  private next = 1;
  private waiting = new Map<number, (m: Msg) => void>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as Msg;
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id); }
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.ws.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const fixture = join(outDir, 'Connections.csv');
  writeFileSync(fixture, demoFixture(Date.now()).text);
  process.env.JOBLEFT_NO_OS_NOTIFY = '1';
  const mock = await startMockAi({ port: 0 });
  const server = await startDevServer({ home, port: 0, osNotifications: false });
  // Stand-in setup through the API (the screens use the same routes).
  const h = { 'x-jobleft-token': server.token, 'content-type': 'application/json' };
  await fetch(`${server.origin}/api/v1/network-dev/ai`, { method: 'PUT', headers: h, body: JSON.stringify({ provider: 'local', baseUrl: mock.origin }) });
  await fetch(`${server.origin}/api/v1/network-dev/jobs`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Backend Engineer', company: 'Stripe', department: 'Engineering', liked: true }) });
  await fetch(`${server.origin}/api/v1/network-dev/jobs`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Designer', company: 'Figma', liked: true }) });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--window-size=1200,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    chrome.stderr!.on('data', (d) => { buf += String(d); const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]!); });
    setTimeout(() => reject(new Error('Chrome did not start')), 20000);
  });
  const cdp = await Cdp.connect(wsUrl);
  const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => { results.push({ check: name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
  try {
    await cdp.send('Browser.grantPermissions', { origin: server.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const s = (m: string, p: Record<string, unknown> = {}) => cdp.send(m, p, sessionId);
    await s('Page.enable'); await s('Runtime.enable'); await s('DOM.enable'); await s('Network.enable');
    const requests: string[] = [];
    // Record every URL the page asks for (no request may leave 127.0.0.1).
    const ws = (cdp as unknown as { ws: WebSocket }).ws;
    ws.addEventListener('message', (ev) => { const m = JSON.parse(String(ev.data)) as Msg; if (m.method === 'Network.requestWillBeSent') requests.push(String((m.params as { request: { url: string } }).request.url)); });
    const evaluate = async (expr: string) => {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }) as { result: { value: unknown }; exceptionDetails?: unknown };
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
      return r.result.value;
    };
    const shot = async (name: string) => {
      const r = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }) as { data: string };
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'));
    };
    const waitFor = async (expr: string, ms = 5000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(100); }
      return false;
    };
    const clickText = (text: string) => evaluate(`(() => { const b = [...document.querySelectorAll('main button, dialog button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
    const tab = (name: string) => evaluate(`(() => { document.querySelector('#tabs button[data-tab="${name}"]').click(); return true; })()`);

    await s('Page.navigate', { url: server.uiUrl });
    await waitFor(`!!document.querySelector('#file')`);
    check('token leaves the address bar', String(await evaluate('location.href')).indexOf('token') === -1);
    check('import screen names the three limits', !!(await evaluate(`/first-degree/.test(document.body.innerText) && /email addresses are blank/i.test(document.body.innerText) && /garbled/.test(document.body.innerText)`)));
    await shot('01-import');

    const doc = await s('DOM.getDocument', {}) as { root: { nodeId: number } };
    const q = await s('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' }) as { nodeId: number };
    await s('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [fixture] });
    await clickText('Import');
    await waitFor(`/people imported from this file/.test(document.body.innerText)`);
    const summary = String(await evaluate(`(document.querySelector('.stats') || document.querySelector('main')).innerText`));
    check('import summary shows 31 imported and 2 skipped', /31\s+people imported/.test(summary) && /2\s+rows skipped/.test(summary), summary.replace(/\s+/g, ' ').slice(0, 120));
    check('skipped rows name their lines and reasons', !!(await evaluate(`/Line 36: Duplicate/.test(document.body.innerText) && /Line 37: Broken row/.test(document.body.innerText)`)));
    await shot('02-import-summary');

    await tab('people');
    await waitFor(`document.querySelectorAll('[data-contact]').length > 0`);
    check('people list shows 31 people', !!(await evaluate(`/31 people/.test(document.body.innerText)`)));
    check('a garbled name is marked, not changed', !!(await evaluate(`/JosÃ©/.test(document.body.innerText) && /name may be garbled/.test(document.body.innerText)`)));
    check('the accent and comma in a position show as in the file', !!(await evaluate(`document.body.innerText.includes('Directora de Ingeniería, Pagos')`)));
    check('no profile link is an anchor (nothing prefetches it)', !(await evaluate(`[...document.querySelectorAll('a[href]')].some((a) => /linkedin/.test(a.href))`)));
    await shot('03-people');

    await tab('jobs');
    await waitFor(`/You know 4 people at Stripe/.test(document.body.innerText)`);
    check('the Stripe job card says 4 people', !!(await evaluate(`/You know 4 people at Stripe/.test(document.body.innerText)`)));
    check('the Figma job card shows no count', !(await evaluate(`/at Figma/.test(document.body.innerText)`)));
    await shot('04-jobs');
    await evaluate(`(() => { [...document.querySelectorAll('.count-line button')][0].click(); return true; })()`);
    await waitFor(`/How this count was made/.test(document.body.innerText)`);
    check('job detail explains the count and the near name not counted', !!(await evaluate(`/Stripe Partners Ltd/.test(document.body.innerText) && /Not counted/.test(document.body.innerText)`)));
    check('job detail lists exactly 4 people', Number(await evaluate(`document.querySelectorAll('[data-contact]').length`)) === 4);
    await shot('05-job-detail');

    // Draft for the first-ranked person, edit one word, copy.
    await evaluate(`(() => { document.querySelector('[data-contact] button.primary').click(); return true; })()`);
    await waitFor(`document.querySelector('dialog[open]') !== null`);
    await sleep(300);
    await evaluate(`(() => { [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Draft').click(); return true; })()`);
    await waitFor(`!!document.querySelector('dialog textarea')`, 8000);
    const draft = String(await evaluate(`document.querySelector('dialog textarea').value`));
    check('the draft greets the ranked contact and is ready', /^Hi Devon,/.test(draft) && !!(await evaluate(`/Ready: no unsupported claim/.test(document.querySelector('dialog').innerText)`)), draft.slice(0, 60));
    const edited = draft.replace('perspective', 'advice');
    await evaluate(`(() => { const t = document.querySelector('dialog textarea'); t.value = ${JSON.stringify(edited)}; t.dispatchEvent(new Event('input')); return true; })()`);
    await evaluate(`(() => { [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Copy').click(); return true; })()`);
    await sleep(400);
    const clip = String(await evaluate(`navigator.clipboard.readText()`));
    check('the clipboard holds exactly the edited text', clip === edited, clip === edited ? undefined : JSON.stringify(clip).slice(0, 120));
    await shot('06-draft');
    await evaluate(`document.querySelector('dialog').close()`);

    await tab('targets');
    await waitFor(`/No one yet/.test(document.body.innerText)`);
    check('targets: Stripe known, Figma "no one yet"', !!(await evaluate(`/You know someone \\(1\\)/.test(document.body.innerText) && /No one yet \\(1\\)/.test(document.body.innerText)`)));
    await clickText('Add top 2 to plan');
    await sleep(400);
    await shot('07-targets');
    await tab('plan');
    await waitFor(`/Coffee-chat plan/.test(document.body.innerText)`);
    check('the plan shows two people in To contact', Number(await evaluate(`document.querySelectorAll('main ol li').length`)) === 2 && !!(await evaluate(`/To contact/.test(document.body.innerText)`)));
    await shot('08-plan');

    await tab('privacy');
    await waitFor(`/Delete all network data/.test(document.body.innerText)`);
    await evaluate(`(() => { const i = document.querySelector('input[aria-label="Type DELETE to confirm"]'); i.value = 'DELETE'; return true; })()`);
    await clickText('Delete all network data');
    await waitFor(`/The delete is complete/.test(document.body.innerText)`);
    check('delete all says it is complete', !!(await evaluate(`/The delete is complete: 31 people/.test(document.body.innerText)`)));
    await shot('09-deleted');
    await tab('jobs');
    await waitFor(`/Backend Engineer/.test(document.body.innerText)`);
    check('after delete, no job card says "You know"', !(await evaluate(`/You know/.test(document.body.innerText)`)));

    const outside = requests.filter((u) => !u.startsWith(server.origin) && !u.startsWith('data:') && u !== 'about:blank');
    check('the page made no request outside 127.0.0.1', outside.length === 0, outside.slice(0, 3).join(' '));
  } finally {
    try { await Promise.race([cdp.send('Browser.close'), sleep(2000)]); } catch { /* already closing */ }
    cdp.close();
    chrome.kill('SIGTERM');
    for (let i = 0; i < 20 && chrome.exitCode === null && chrome.signalCode === null; i++) await sleep(100);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
    await sleep(300);
    await server.close();
    await mock.close();
    if (!keep) { rmSync(home, { recursive: true, force: true }); }
    rmSync(profile, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${results.length - failed} of ${results.length} checks passed. Screenshots: ${outDir}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
