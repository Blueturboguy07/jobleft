// Gate 8 (i-shell), single-builder check written from docs/outcomes/i-shell.md and docs/INTERFACES.md 5.2.
// The REAL bundle (.cache/cargo-target/debug/bundle/macos/jobleft.app, built unsigned by `pnpm --filter @jobleft/shell
// app:build`) is started like a double-click would (its executable, with a scratch data folder), and judged from the
// outside: the files it writes, its processes and port, the window it reports, and a JavaScript probe that runs the
// same measurements inside its WKWebView and inside headless Chromium on the same server.
// Usage: node evals/gate8-shell/run.mjs   (writes evals/gate8-shell/RESULT.md and shots/; exit 1 on a failed MUST)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('./', import.meta.url));
const SHOTS = join(OUT, 'shots');
const APP = join(ROOT, '.cache/cargo-target/debug/bundle/macos/jobleft.app');
const BIN = join(APP, 'Contents/MacOS/jobleft');
const HOME_FRESH = '/private/tmp/jl-gate8-fresh';
const HOME_STORE = '/private/tmp/jl-gate8-store';
const STORE_SRC = '/private/tmp/jl-gate2';
const results = [];
const note = (id, ok, text) => { results.push({ id, ok, text }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const raw = (port, opts) => new Promise((resolve) => { const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {} }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); req.on('error', () => resolve({ status: 0, body: '' })); req.end(); });
const portOpen = async (port) => (await raw(port, { path: '/api/v1/health' })).status !== 0;
const waitFor = async (fn, ms, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

const SHELL_ENV = { JOBLEFT_AUTO_CRAWL: '0', JOBLEFT_SEED_BOARDS: 'none', JOBLEFT_NO_OS_NOTIFY: '1', JOBLEFT_SHELL_PROBE: join(OUT, 'probe.js') };
async function launchShell(home, tag) {
  const t0 = Date.now();
  const child = spawn(BIN, [], { env: { ...process.env, ...SHELL_ENV, JOBLEFT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  // Only a run/shell.json written by THIS process counts (a kill -9 leaves the last one behind).
  const shellJson = await waitFor(() => { const j = readJson(join(home, 'run/shell.json')); return j && j.pid === child.pid ? j : null; }, 25000);
  const ms = Date.now() - t0;
  const server = readJson(join(home, 'run/server.json'));
  return { child, ms, shellJson, server, tag, out: () => out, home };
}
async function quitShell(s) {
  const t0 = Date.now();
  s.child.kill('SIGTERM');
  const exited = await waitFor(() => s.child.exitCode !== null || s.child.signalCode !== null ? true : null, 12000);
  const shellMs = Date.now() - t0;
  const serverGone = await waitFor(() => (s.server?.pid && alive(s.server.pid) ? null : true), 6000);
  const portClosed = s.server?.port ? !(await portOpen(s.server.port)) : true;
  return { exited: !!exited, shellMs, serverGone: !!serverGone, totalMs: Date.now() - t0, portClosed, runFileGone: !existsSync(join(s.home, 'run/server.json')), shellFileGone: !existsSync(join(s.home, 'run/shell.json')) };
}

rmSync(SHOTS, { recursive: true, force: true }); mkdirSync(SHOTS, { recursive: true });
rmSync(HOME_FRESH, { recursive: true, force: true }); rmSync(HOME_STORE, { recursive: true, force: true });
mkdirSync(HOME_FRESH, { recursive: true });
cpSync(STORE_SRC, HOME_STORE, { recursive: true, filter: (p) => !/^(logs|run|tmp)(\/|$)/.test(p.slice(STORE_SRC.length + 1)) });
sh('pkill', ['-f', 'Contents/MacOS/jobleft']); await sleep(500);
let s = null, browser = null;
try {
  // Setup: the bundle exists, is unsigned (no identity), and carries node, the server tree and the UI.
  const sig = sh('codesign', ['-dv', '--verbose=2', APP]).stderr;
  const layout = { node: existsSync(join(APP, 'Contents/MacOS/node')), server: ['Contents/Resources/server/src/main.js', 'Contents/Resources/resources/server/src/main.js'].find((p) => existsSync(join(APP, p))) ?? null, ui: ['Contents/Resources/ui/index.html', 'Contents/Resources/resources/ui/index.html'].find((p) => existsSync(join(APP, p))) ?? null };
  const mb = Number(sh('du', ['-sm', APP]).stdout.split('\t')[0]);
  note('setup.bundle', existsSync(BIN) && layout.node && !!layout.server && !!layout.ui && !/Authority=Developer ID/.test(sig), `${APP.replace(ROOT, '')} (${mb} MB); signature: ${/Signature=adhoc/.test(sig) ? 'ad-hoc' : /not signed/.test(sig) ? 'none' : sig.split('\n').find((l) => /Authority|Signature/.test(l)) ?? 'unknown'}; node: ${layout.node}; server: ${layout.server}; ui: ${layout.ui}`);

  // O1: first launch on a new install: a window within 5 s, and it is the first-run setup; no error page.
  s = await launchShell(HOME_FRESH, 'fresh');
  const probeFresh = await waitFor(() => readJson(join(HOME_FRESH, 'run/probe.json')), 40000);
  const health = s.server ? await raw(s.server.port, { path: '/api/v1/health' }) : { status: 0, body: '' };
  note('O1.first-launch', !!s.shellJson && s.ms <= 5000 && health.status === 200 && /jobleft/.test(health.body) && !!probeFresh && probeFresh.onboarding === true && probeFresh.ua === 'webkit', `window reported ${s.ms} ms after the double-click; server on port ${s.server?.port} healthy: ${health.status === 200}; the window shows: ${probeFresh ? `${probeFresh.onboarding ? 'first-run setup' : probeFresh.hash} in ${probeFresh.ua}, viewport ${probeFresh.viewport?.join('x')}` : 'NO PROBE'}; shell stderr: "${s.out().trim().slice(0, 120)}"`);
  const sidecarLog = existsSync(join(HOME_FRESH, 'logs/sidecar.log')) ? readFileSync(join(HOME_FRESH, 'logs/sidecar.log'), 'utf8') : '';
  note('O12.no-token-in-logs', !sidecarLog.includes(s.server?.token ?? '@@') && !/jordan|testwell/i.test(sidecarLog), `logs/sidecar.log (${sidecarLog.length} bytes) holds neither the launch token nor a person's name`);

  // O11: strangers get nothing (checked from this process, no token / wrong Host / foreign Origin).
  const p0 = s.server.port;
  const noTok = await raw(p0, { path: '/api/v1/profile' });
  const badHost = await raw(p0, { path: '/api/v1/health', headers: { host: '127.0.0.1.attacker.example:' + p0 } });
  const badOrigin = await raw(p0, { path: '/api/v1/profile', headers: { 'x-jobleft-token': s.server.token, origin: 'http://evil.example' } });
  const lan = sh('lsof', ['-nP', '-iTCP:' + p0, '-sTCP:LISTEN']).stdout;
  note('O11.never-answers-strangers', noTok.status === 401 && badHost.status === 403 && badOrigin.status === 403 && /127\.0\.0\.1:/.test(lan) && !/\*:/.test(lan), `no token ${noTok.status}; DNS-rebinding Host ${badHost.status}; foreign Origin ${badOrigin.status}; listening on: ${(lan.split('\n')[1] ?? '').split(/\s+/).slice(-2, -1)[0] ?? '?'}`);

  // O9: quit means quit: SIGTERM (what the menu item and Cmd-Q do) stops the shell and the server, closes the port.
  const q1 = await quitShell(s); s = null;
  note('O9.quit-clean', q1.exited && q1.serverGone && q1.portClosed && q1.runFileGone && q1.shellFileGone && q1.totalMs <= 10000, `shell exited in ${q1.shellMs} ms; server process gone: ${q1.serverGone}; port closed: ${q1.portClosed}; run/server.json removed: ${q1.runFileGone}; run/shell.json removed: ${q1.shellFileGone}; total ${q1.totalMs} ms`);

  // Later launch with a full store (the gate 2 folder: 11,957 real jobs): window fast, feed shown.
  s = await launchShell(HOME_STORE, 'store');
  const probe = await waitFor(() => readJson(join(HOME_STORE, 'run/probe.json')), 40000);
  note('O1.later-launch', !!s.shellJson && s.ms <= 5000 && !!probe && probe.shell && probe.cards?.length > 0 && probe.ua === 'webkit', `window reported ${s.ms} ms after launch (target 2 s, allowed 5 s here: a debug build of the shell); feed in WKWebView: ${probe?.cards?.length ?? 0} cards, first "${probe?.cards?.[0]?.title?.slice(0, 50)}" ${probe?.cards?.[0]?.tile?.replace(/\..*$/, '')}`);

  // O10: a second launch does not make a second copy; the first keeps running.
  const second = spawn(BIN, [], { env: { ...process.env, ...SHELL_ENV, JOBLEFT_HOME: HOME_STORE }, stdio: ['ignore', 'pipe', 'pipe'] });
  let secondOut = ''; second.stderr.on('data', (d) => { secondOut += d; });
  const secondExit = await waitFor(() => (second.exitCode !== null ? second.exitCode + 1 : null), 8000);
  if (secondExit === null) second.kill('SIGKILL');
  const shellNow = readJson(join(HOME_STORE, 'run/shell.json'));
  const procs = sh('pgrep', ['-f', 'Contents/MacOS/jobleft']).stdout.trim().split('\n').filter(Boolean);
  note('O10.single-instance', secondExit !== null && shellNow?.pid === s.shellJson.pid && alive(s.child.pid) && procs.length === 1, `second launch exited with ${secondExit === null ? 'no exit in 8 s (killed)' : secondExit - 1} in time; first shell (pid ${s.shellJson.pid}) still runs: ${alive(s.child.pid)}; jobleft shell processes: ${procs.length}; second's stderr: "${secondOut.trim().slice(0, 100)}"`);

  // WKWebView vs Chromium: the same probe on the same server, same viewport.
  const url = `http://127.0.0.1:${s.server.port}/#token=${s.server.token}`;
  const { launch } = await import(join(ROOT, 'apps/ui/scripts/browser.ts'));
  browser = await launch(); const page = await browser.page();
  await page.size(probe?.viewport?.[0] ?? 1280, probe?.viewport?.[1] ?? 820);
  await page.goto(url);
  await page.waitFor("document.querySelector('.jl-card[data-job-id]')", 20000);
  await page.eval(readFileSync(join(OUT, 'probe.js'), 'utf8'));
  const chromeHash = await waitFor(async () => { const h = await page.eval('location.hash'); return h.startsWith('#probe=') ? h : null; }, 20000);
  const chrome = chromeHash ? JSON.parse(decodeURIComponent(chromeHash.slice(7))) : null;
  await sleep(5000); // both pages have returned to the feed by now (the probe restores the hash after 3 s)
  await page.shot(join(SHOTS, 'chromium-feed.png'));
  const win = sh('swift', [join(OUT, 'winshot.swift'), 'jobleft'], { timeout: 90000 });
  const winId = /window (\d+)/.exec(win.stdout)?.[1];
  const cap = winId ? sh('screencapture', ['-l', winId, '-x', '-o', join(SHOTS, 'wkwebview-feed.png')], { timeout: 20000 }) : null;
  const capSize = existsSync(join(SHOTS, 'wkwebview-feed.png')) ? sh('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(SHOTS, 'wkwebview-feed.png')]).stdout.match(/\d+/g)?.slice(-2).join('x') : 'none';
  const diff = [];
  if (!probe) diff.push('no WKWebView probe');
  if (chrome && probe) {
    if (chrome.hash !== probe.hash) diff.push(`hash ${probe.hash} vs ${chrome.hash}`);
    const n = Math.min(probe.cards.length, chrome.cards.length);
    for (let i = 0; i < n; i++) {
      const a = probe.cards[i], b = chrome.cards[i];
      if (a.id !== b.id) diff.push(`card ${i} id`);
      if (a.title !== b.title) diff.push(`card ${i} title`);
      if (a.tile !== b.tile) diff.push(`card ${i} score`);
      for (const k of ['rect', 'titleRect', 'tileRect']) { const ra = a[k], rb = b[k]; if (ra && rb && ra.some((v, j) => Math.abs(v - rb[j]) > 12)) diff.push(`card ${i} ${k} ${ra.join(',')} vs ${rb.join(',')}`); }
    }
    if (probe.cards.length !== chrome.cards.length) diff.push(`cards ${probe.cards.length} vs ${chrome.cards.length}`);
    for (const k of ['body', 'title', 'tile']) if (probe.fonts[k] !== chrome.fonts[k]) diff.push(`font ${k} "${probe.fonts[k]}" vs "${chrome.fonts[k]}"`);
    if (probe.overflowX || chrome.overflowX) diff.push(`sideways overflow webkit ${probe.overflowX} chromium ${chrome.overflowX}`);
    if (probe.errorsText || chrome.errorsText) diff.push('undefined/NaN text');
  }
  note('O-visual.wkwebview-vs-chromium', !!chrome && !!probe && diff.length === 0, `${probe?.cards?.length ?? 0} cards in WKWebView vs ${chrome?.cards?.length ?? 0} in Chromium at ${probe?.viewport?.join('x')}: ${diff.length ? diff.slice(0, 6).join('; ') : 'same ids, titles, scores, fonts; positions within 12 px; no sideways overflow'}; window: ${win.stdout.trim().split('\n')[0]?.slice(0, 60) || win.stderr.trim().slice(0, 60)}; WKWebView capture ${capSize}${cap?.status ? ' (screencapture exit ' + cap.status + ')' : ''}`);
  writeFileSync(join(SHOTS, 'probe-webkit.json'), JSON.stringify(probe, null, 1));
  writeFileSync(join(SHOTS, 'probe-chromium.json'), JSON.stringify(chrome, null, 1));
  await browser.close(); browser = null;

  // O9: a crash of the shell (kill -9) leaves no server behind; the next launch opens normally.
  const serverPid = s.server.pid, port2 = s.server.port;
  s.child.kill('SIGKILL'); await waitFor(() => (s.child.exitCode !== null || s.child.signalCode !== null ? true : null), 5000);
  const t0 = Date.now();
  const gone = await waitFor(() => (alive(serverPid) ? null : true), 15000);
  const orphanMs = Date.now() - t0;
  const closed = !(await portOpen(port2));
  s = await launchShell(HOME_STORE, 'after-crash');
  const health2 = s.server ? await raw(s.server.port, { path: '/api/v1/health' }) : { status: 0 };
  note('O9.O10.crash-then-relaunch', !!gone && closed && !!s.shellJson && health2.status === 200 && s.ms <= 8000, `after kill -9 of the shell, the server exited by itself in ${orphanMs} ms (parent pid gone): ${!!gone}; port closed: ${closed}; next launch opened a window in ${s.ms} ms and answers health ${health2.status} (no "already running")`);
  const q2 = await quitShell(s); s = null;
  note('O9.quit-again', q2.exited && q2.serverGone && q2.portClosed, `second quit: shell ${q2.shellMs} ms, server gone ${q2.serverGone}, port closed ${q2.portClosed}`);
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  if (s) { try { s.child.kill('SIGKILL'); } catch { /* gone */ } }
  sh('pkill', ['-f', 'Contents/MacOS/jobleft']);
}

const fails = results.filter((r) => !r.ok);
const md = [`# Gate 8 (i-shell) result, ${new Date().toISOString()}`, '', 'The unsigned debug bundle `.cache/cargo-target/debug/bundle/macos/jobleft.app`, launched from its executable with a scratch data folder (a fresh one, then a copy of the gate 2 store with 11,957 jobs), judged from outside: files, processes, port, and a probe that ran inside its WKWebView and inside headless Chromium.', '', '| Check | Result | Evidence |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.text.replace(/\|/g, '/').replace(/\n\s*/g, '<br>')} |`), '', `Verdict: ${fails.length ? `FAIL (${fails.map((m) => m.id).join(', ')})` : 'PASS'}`].join('\n');
writeFileSync(join(OUT, 'RESULT.md'), md);
console.log(`\nVerdict: ${fails.length ? 'FAIL' : 'PASS'} (${results.length - fails.length}/${results.length})`);
process.exit(fails.length ? 1 : 0);
