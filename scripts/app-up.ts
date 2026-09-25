// `pnpm app:up`: starts the jobleft server for development and prints the address to open
// (docs/INTERFACES.md section 5.1).
//   1. JOBLEFT_HOME defaults to <repo>/.jobleft-dev (created with mode 0700).
//   2. If run/server.json names a live jobleft server, it prints that server's address and exits 0.
//   3. Otherwise it makes a launch token and starts `node apps/server/src/main.ts` detached, with JOBLEFT_DEV=1 and
//      JOBLEFT_UI_DIR when apps/ui/dist exists. The server's log is $JOBLEFT_HOME/logs/server.log.
//   4. It waits up to 15 s for GET /api/v1/health, then prints http://127.0.0.1:<port>/#token=<token> and exits 0.
//      On time-out it prints the last log lines and exits 1.
//   5. i-core: `--persona nurse-tx|backend-remote` then saves the test persona "Jordan Testwell" as the profile (the
//      same call the preference step makes), so the first-run board choice and the first crawl start at once.
//      `--home <dir>` sets JOBLEFT_HOME for this run.
// Every other JOBLEFT_* variable in your shell (JOBLEFT_HOST_MAP, JOBLEFT_PUBLIK_BASE_URL, JOBLEFT_OFFLINE, ...) is
// passed to the server.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { personaProfile } from '../apps/server/src/core/persona.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1]! : null; };
const persona = flag('--persona');
if (persona && !['nurse-tx', 'backend-remote'].includes(persona)) { process.stderr.write('--persona must be nurse-tx or backend-remote.\n'); process.exit(2); }
if (flag('--home')) process.env.JOBLEFT_HOME = flag('--home')!;
const home = process.env.JOBLEFT_HOME || join(repo, '.jobleft-dev');
const runFile = join(home, 'run', 'server.json');
const logFile = join(home, 'logs', 'server.log');
process.umask(0o077);

interface RunInfo { pid: number; port: number; token: string }

function readRun(): RunInfo | null {
  try { return JSON.parse(readFileSync(runFile, 'utf8')) as RunInfo; } catch { return null; }
}

function get(port: number, path: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false, timeout: 2000, headers: token ? { 'x-jobleft-token': token } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end();
  });
}

async function isJobleft(port: number): Promise<boolean> {
  const r = await get(port, '/api/v1/health');
  try { return r.status === 200 && JSON.parse(r.body).app === 'jobleft'; } catch { return false; }
}

function tail(): string {
  try { return readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n'); } catch { return '(no log yet)'; }
}

function putJson(port: number, token: string, path: string, body: unknown): Promise<number> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'PUT', agent: false, timeout: 10_000,
      headers: { 'x-jobleft-token': token, 'content-type': 'application/json', 'content-length': data.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end(data);
  });
}

async function applyPersona(port: number, token: string): Promise<void> {
  if (!persona) return;
  const status = await putJson(port, token, '/api/v1/profile', personaProfile(persona as 'nurse-tx' | 'backend-remote'));
  process.stdout.write(status === 200 ? `Saved the test persona "Jordan Testwell" (${persona}). The first crawl has started.\n` : `Could not save the persona (HTTP ${status}).\n`);
}

mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });

const live = readRun();
if (live && await isJobleft(live.port)) {
  process.stdout.write(`jobleft is already running (data folder ${home}).\nOpen: http://127.0.0.1:${live.port}/#token=${live.token}\n`);
  await applyPersona(live.port, live.token);
  process.exit(0);
}

const token = randomBytes(32).toString('base64url');
const uiDist = join(repo, 'apps', 'ui', 'dist');
const env: Record<string, string> = { ...process.env as Record<string, string>, JOBLEFT_HOME: home, JOBLEFT_LAUNCH_TOKEN: token, JOBLEFT_DEV: '1', JOBLEFT_QUIET: '1' };
if (existsSync(join(uiDist, 'index.html'))) env.JOBLEFT_UI_DIR = uiDist;
const err = openSync(logFile, 'a', 0o600);
const child = spawn(process.execPath, [join(repo, 'apps', 'server', 'src', 'main.ts')], { detached: true, stdio: ['ignore', 'ignore', err], env });
child.unref();

const t0 = Date.now();
while (Date.now() - t0 < 15_000) {
  const r = readRun();
  if (r && r.pid === child.pid && r.token === token && await isJobleft(r.port)) {
    process.stdout.write(`jobleft is running (data folder ${home}, process ${r.pid}).\nOpen: http://127.0.0.1:${r.port}/#token=${token}\nStop it with: pnpm app:down\n`);
    await applyPersona(r.port, token);
    process.exit(0);
  }
  if (child.exitCode !== null) break;
  await new Promise((res) => setTimeout(res, 150));
}
process.stderr.write(`jobleft did not start within 15 seconds. Last lines of ${logFile}:\n${tail()}\n`);
process.exit(1);
