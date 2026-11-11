// Test helpers: a scratch data folder under the temp folder (/private/tmp on macOS, the system temp folder elsewhere), a server started in this process (memory secrets), a
// server started as a child process (for kill -9 and parent-pid tests), and a small HTTP client that can send any
// header (fetch() refuses to set Host and Origin).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PublikSignIn, PublikSignInCredential } from '@jobleft/ai-engine';
import { memorySecrets, newLaunchToken, startServer, type RunningServer, type ServerOptions } from '../src/index.ts';
import { tmpdir } from 'node:os';
// Scratch folders: /private/tmp on macOS (short paths, no symlink games), the system temp folder elsewhere (Windows).
const TMP = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

export const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export function scratchHome(tag: string): string {
  return mkdtempSync(join(TMP, `jl-test-${tag}-`));
}

export interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any; body: Buffer }

export function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; host?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, body });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export interface TestServer {
  home: string;
  token: string;
  port: number;
  server: RunningServer;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  stop(): Promise<void>;
}

/**
 * Sign in with publik, as a test does it: the publik module's credential file is this computer's and no test may
 * touch it, so a test server keeps its credential next to its scratch data folder (<home>.publik-signin.json: it
 * survives a restart on the same folder, like the real file). provision() stands in for the module's: POST /installs
 * at the stand-in, only with an app token and a loopback publik address (the old gate G-publik rule, kept for the
 * tests that check it).
 */
export function testPublikSignIn(home: string, env: Record<string, string | undefined>): PublikSignIn {
  const file = `${home}.publik-signin.json`;
  const read = (): PublikSignInCredential | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as PublikSignInCredential; } catch { return null; } };
  const write = (c: PublikSignInCredential) => writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
  return {
    credential: read,
    setChoice(choice) { const c = read(); if (c) write({ ...c, choice }); },
    async provision() {
      const base = (env.JOBLEFT_PUBLIK_BASE_URL ?? '').replace(/\/+$/, '');
      const token = env.JOBLEFT_PUBLIK_APP_TOKEN;
      let loopback = false;
      try { loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname); } catch { loopback = false; }
      if (!token || !loopback) throw new Error('Connecting to publik is not available in this build yet (it has no publik app token). Choose a local model or your own key instead.');
      const installId = randomUUID();
      const res = await fetch(`${base}/installs`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ app_token: token, app_slug: 'jobleft', app_version: '0.0.0-test', os: 'macos', install_id: installId, disclosure_version: 1, dialects: ['chat_completions'] }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (res.status !== 201 || typeof body.key !== 'string') throw new Error(body.error?.message ?? `publik did not accept this build (HTTP ${res.status}).`);
      const c: PublikSignInCredential = { key: body.key, baseUrl: typeof body.base_url === 'string' ? body.base_url : base, installId: body.install_id ?? installId, claimUrl: body.claim_url ?? null, choice: null };
      write(c);
      return c;
    },
  };
}

export async function startTest(tag: string, extra: { home?: string; env?: Record<string, string>; dev?: boolean; offline?: boolean; secrets?: ServerOptions['secrets']; publikSignIn?: PublikSignIn } = {}): Promise<TestServer> {
  const home = extra.home ?? scratchHome(tag);
  const token = newLaunchToken();
  const env = { JOBLEFT_LOG_LEVEL: 'debug', JOBLEFT_AUTO_CRAWL: '0', ...(extra.env ?? {}) };
  const server = await startServer({
    home, launchToken: token, secrets: extra.secrets ?? memorySecrets(), dev: extra.dev ?? true, offline: extra.offline ?? false,
    publikSignIn: extra.publikSignIn ?? testPublikSignIn(home, env),
    // No crawl of real employer boards starts on its own in a test (a test that wants one passes JOBLEFT_AUTO_CRAWL: '1' with its own host map).
    env,
  });
  const port = server.port;
  return {
    home, token, port, server,
    call(method, path, body, headers = {}) {
      const h: Record<string, string> = { 'x-jobleft-token': token, ...headers };
      let payload: string | Buffer | undefined;
      if (body !== undefined) {
        if (Buffer.isBuffer(body)) payload = body;
        else { payload = JSON.stringify(body); h['content-type'] ??= 'application/json'; }
      }
      return raw(port, { method, path, headers: h, body: payload });
    },
    async stop() { await server.close(); },
  };
}

export function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
  rmSync(`${home}.publik-signin.json`, { force: true });
}

/** The smallest environment a child Node process needs: PATH, plus what Windows cannot run without (SystemRoot, temp, profile). */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC', 'ComSpec', 'PROGRAMDATA'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  if (!env.PATH) env.PATH = '';
  return { ...env, ...extra };
}

export function spawnServer(home: string, env: Record<string, string> = {}): { child: ChildProcess; token: string; ready: Promise<{ port: number; pid: number }> } {
  const token = newLaunchToken();
  const child = spawn(process.execPath, [MAIN], {
    env: childEnv({ JOBLEFT_HOME: home, JOBLEFT_LAUNCH_TOKEN: token, JOBLEFT_SECRET_STORE: 'memory', JOBLEFT_QUIET: '1', ...env }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr!.on('data', (d) => { err += String(d); });
  const ready = new Promise<{ port: number; pid: number }>((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try {
        const info = JSON.parse(readFileSync(join(home, 'run', 'server.json'), 'utf8')) as { port: number; pid: number };
        if (info.pid === child.pid) {
          const r = await raw(info.port, { path: '/api/v1/health' });
          if (r.status === 200) { resolve(info); return; }
        }
      } catch { /* not yet */ }
      if (child.exitCode !== null) { reject(new Error(`server exited ${child.exitCode}: ${err}`)); return; }
      if (Date.now() - t0 > 15000) { reject(new Error(`server did not start: ${err}`)); return; }
      setTimeout(poll, 50);
    };
    void poll();
  });
  return { child, token, ready };
}

/** Stops a spawned server the way each system does it: SIGTERM on Unix; the shutdown route on Windows (no signals there). */
export async function stopServer(child: ChildProcess, port: number, token: string): Promise<number | null> {
  if (process.platform === 'win32') {
    await raw(port, { method: 'POST', path: '/api/v1/shutdown', headers: { 'x-jobleft-token': token, 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  } else process.kill(child.pid!, 'SIGTERM');
  return waitExit(child);
}

export function waitExit(child: ChildProcess, ms = 15000): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const t = setTimeout(() => resolve(null), ms);
    child.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

export const PERSONA = {
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 0100', addressLine: '1 Test Way', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US', links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/jordan-testwell-example' }, { label: 'Portfolio', url: 'https://example.com/jordan' }] },
  summary: 'Data analyst. Ünïcödé, 日本語 and emoji 🎯 stay as written.',
  education: [], work: [], projects: [], certifications: [], skills: [{ name: 'SQL', years: 3, source: 'user' }],
  preferences: { jobFunctions: [], targetTitles: ['Data Analyst'], employmentTypes: [], workModels: [], levels: [], countries: ['US'], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: 'decline', gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};
