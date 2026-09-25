// Helpers for the lane's own probes: start and stop a demo, call the mock API with the token, and report findings.
// The probes are written from the outcomes in docs/outcomes/ui.md (what a person must see and be able to do),
// not from how the screens are built. Each probe prints PASS or FAIL lines with the evidence.

import { spawn, type ChildProcess } from 'node:child_process';
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
      c.unref();
      const s = Date.now();
      while (!/Open: /.test(o)) { if (Date.now() - s > 20000) throw new Error('the API did not come back'); await new Promise((r) => setTimeout(r, 100)); }
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
