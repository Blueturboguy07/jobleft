// Test helpers: a scratch data folder under /private/tmp, a server started in this process (memory secrets), a
// server started as a child process (for kill -9 and parent-pid tests), and a small HTTP client that can send any
// header (fetch() refuses to set Host and Origin).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memorySecrets, newLaunchToken, startServer, type RunningServer } from '../src/index.ts';

export const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export function scratchHome(tag: string): string {
  return mkdtempSync(join('/private/tmp', `jl-test-${tag}-`));
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

export async function startTest(tag: string, extra: { home?: string; env?: Record<string, string>; dev?: boolean; offline?: boolean } = {}): Promise<TestServer> {
  const home = extra.home ?? scratchHome(tag);
  const token = newLaunchToken();
  const server = await startServer({
    home, launchToken: token, secrets: memorySecrets(), dev: extra.dev ?? true, offline: extra.offline ?? false,
    // No crawl of real employer boards starts on its own in a test (a test that wants one passes JOBLEFT_AUTO_CRAWL: '1' with its own host map).
    env: { JOBLEFT_LOG_LEVEL: 'debug', JOBLEFT_AUTO_CRAWL: '0', ...(extra.env ?? {}) },
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
}

export function spawnServer(home: string, env: Record<string, string> = {}): { child: ChildProcess; token: string; ready: Promise<{ port: number; pid: number }> } {
  const token = newLaunchToken();
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? '', JOBLEFT_HOME: home, JOBLEFT_LAUNCH_TOKEN: token, JOBLEFT_SECRET_STORE: 'memory', JOBLEFT_QUIET: '1', ...env },
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
