// Helpers for the lane's own probes: start and stop a demo, call the mock API with the token, and report findings.
// The probes are written from the outcomes in docs/outcomes/ui.md (what a person must see and be able to do),
// not from how the screens are built. Each probe prints PASS or FAIL lines with the evidence.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApiClient, type LocalApiClient } from '@jobleft/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const UI_ROOT = resolve(HERE, '..', '..');

export interface Demo {
  url: string;
  origin: string;
  port: number;
  token: string;
  home: string;
  api: LocalApiClient;
  /** Stops every process of the demo. */
  stop(): Promise<void>;
  /** Kills only the local API mock at once (SIGKILL), like a force-quit. */
  kill9(): void;
  /** Starts the local API mock again on the same port with the same token. */
  relaunchApi(extra?: string[]): Promise<void>;
  log(): string;
}

export async function startDemo(opts: { home: string; reset?: boolean; args?: string[]; wait?: number }): Promise<Demo> {
  const home = resolve(opts.home);
  if (opts.reset !== false && existsSync(home)) rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  let out = '';
  const proc: ChildProcess = spawn(process.execPath, [join(UI_ROOT, 'mock', 'run.ts'), '--home', home, ...(opts.args ?? [])], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
  const t0 = Date.now();
  let m: RegExpExecArray | null = null;
  while (!(m = /Open: (http:\/\/127\.0\.0\.1:(\d+)\/#token=([\w-]+))/.exec(out))) {
    if (Date.now() - t0 > (opts.wait ?? 90_000)) throw new Error(`the demo did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const [, url, port, token] = m;
  const origin = `http://127.0.0.1:${port}`;
  const api = createLocalApiClient({ origin, launchToken: token });
  const demo: Demo = {
    url: url!, origin, port: Number(port), token: token!, home, api,
    log: () => out,
    async stop() {
      // an API that relaunchApi started runs detached: stop it by the pid it wrote, before the runner goes
      try { process.kill((JSON.parse(readFileSync(join(home, 'run', 'server.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* not running */ }
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 900));
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
    },
    kill9() {
      // server.json always holds the pid of the API that is running now (also after relaunchApi)
      const s = JSON.parse(readFileSync(join(home, 'run', 'server.json'), 'utf8')) as { pid: number };
      process.kill(s.pid, 'SIGKILL');
    },
    async relaunchApi(extra = []) {
      const c = spawn(process.execPath, [join(UI_ROOT, 'mock', 'server.ts'), '--home', home, '--port', String(port), '--token', token!, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let o = '';
      c.stdout!.on('data', (d: Buffer) => { o += d.toString(); });
      c.stderr!.on('data', (d: Buffer) => { o += d.toString(); });
      c.unref();
      const s = Date.now();
      // (the limit is generous: the computer may be busy with other work)
      while (!/Open: /.test(o)) { if (Date.now() - s > 60000) throw new Error(`the API did not come back within 60 s. It printed: ${o.slice(-400)}`); await new Promise((r) => setTimeout(r, 100)); }
    },
  };
  return demo;
}

export interface Finding { ok: boolean; name: string; detail?: string }
export const findings: Finding[] = [];

export function check(ok: boolean, name: string, detail = ''): boolean {
  findings.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  return ok;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function summary(): number {
  const bad = findings.filter((f) => !f.ok);
  console.log(`\n${findings.length - bad.length} passed, ${bad.length} failed`);
  return bad.length ? 1 : 0;
}

/** A handle on an already running demo, from the address it printed (no process control). */
export function attachDemo(url: string, home = ''): Demo {
  const m = /^(http:\/\/127\.0\.0\.1:(\d+))\/#token=([\w-]+)$/.exec(url);
  if (!m) throw new Error('Pass the address the demo printed: http://127.0.0.1:<port>/#token=<token>');
  const [, origin, port, token] = m;
  return {
    url, origin: origin!, port: Number(port), token: token!, home, api: createLocalApiClient({ origin: origin!, launchToken: token }),
    log: () => '', stop: async () => undefined, kill9: () => { throw new Error('attached demo: cannot kill'); }, relaunchApi: async () => { throw new Error('attached demo'); },
  };
}

/** Runs the demo's control tool (node mock/ctl.ts ...) against this demo's data folder and returns what it printed. */
export function ctl(demo: Demo, ...words: string[]): string {
  const r = spawnSync(process.execPath, [join(UI_ROOT, 'mock', 'ctl.ts'), ...words, '--home', demo.home], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.trim();
}

/** Starts a refresh through the local API and waits until it is over. Returns false when it did not finish in time. */
export async function refreshAndWait(demo: Demo, timeoutMs = 120_000): Promise<boolean> {
  await demo.api.call('crawlRun', { body: {} });
  const end = Date.now() + timeoutMs;
  await sleep(500);
  while (Date.now() < end) {
    const s = await demo.api.call('crawlStatus');
    if (!s.running) return true;
    await sleep(500);
  }
  return false;
}

/** Fetches a page from the stand-in employer sites (loopback only). */
export async function getPage(url: string): Promise<{ status: number; text: string }> {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1') throw new Error(`the probes only fetch loopback pages: ${url}`);
  const r = await fetch(url);
  return { status: r.status, text: await r.text() };
}

/**
 * Fills a demo the way a person who used the app for a while would have it: publik connected (dollar balance), a base
 * resume, imported connections, liked and applied jobs with a note and a reminder. Used by the probes that look at
 * full screens. Never sends anything anywhere: the demo is on loopback.
 */
export async function seedRich(demo: Demo, opts: { ai?: boolean } = {}): Promise<{ liked: string[]; applied: string[]; resumeId: string }> {
  if (opts.ai !== false) {
    await demo.api.call('connectPublik', { body: { disclosureAccepted: true, disclosureVersion: 1 } });
    await demo.api.call('putAiSettings', { body: { provider: 'publik' } });
  }
  const resumes = await demo.api.call('listResumes');
  const resume = resumes[0] ?? await demo.api.call('createResume', { body: { name: 'Jordan Testwell, software engineer' } });
  const csv = join(demo.home, 'fixtures', 'Connections.csv');
  if (existsSync(csv)) {
    await fetch(`${demo.origin}/api/v1/network/import`, { method: 'POST', headers: { 'content-type': 'text/csv', 'x-jobleft-token': demo.token }, body: readFileSync(csv) });
  }
  const list = await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 12 } });
  const liked: string[] = [], applied: string[] = [];
  for (const [i, it] of list.items.slice(0, 8).entries()) {
    const id = it.job.id;
    if (i < 5) { await demo.api.call('updateTracker', { params: { jobId: id }, body: { liked: true } }); liked.push(id); }
    if (i < 3) { await demo.api.call('updateTracker', { params: { jobId: id }, body: { status: i === 0 ? 'applied' : i === 1 ? 'interviewing' : 'offer_received' } }); applied.push(id); }
  }
  if (applied[0]) await demo.api.call('updateTracker', { params: { jobId: applied[0] }, body: { notes: [{ text: 'Recruiter said the team is hiring two people' }], reminders: [{ at: new Date(Date.now() + 2 * 86_400_000).toISOString(), text: 'Send a follow-up note', done: false }] } });
  return { liked, applied, resumeId: (resume as { id: string }).id };
}
