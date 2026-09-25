// `pnpm app:down`: stops the jobleft server that `pnpm app:up` started (docs/INTERFACES.md section 5.1).
//   1. Reads $JOBLEFT_HOME/run/server.json (default <repo>/.jobleft-dev). With no file: "nothing is running", exit 0.
//   2. Checks that the process is a jobleft server (health answers, and the stored token is accepted), sends SIGTERM,
//      waits up to 10 s, then SIGKILL.
//   3. Removes run/server.json. Exit 0.

import { readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const hi = argv.indexOf('--home');
const home = (hi >= 0 && argv[hi + 1]) || process.env.JOBLEFT_HOME || join(repo, '.jobleft-dev');
const runFile = join(home, 'run', 'server.json');

interface RunInfo { pid: number; port: number; token: string }
let info: RunInfo;
try { info = JSON.parse(readFileSync(runFile, 'utf8')) as RunInfo; } catch {
  process.stdout.write('nothing is running\n');
  process.exit(0);
}

function get(path: string, token?: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: info.port, path, agent: false, timeout: 2000, headers: token ? { 'x-jobleft-token': token } : {} }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const ours = (await get('/api/v1/health')) === 200 && (await get('/api/v1/settings', info.token)) === 200;
if (!ours) {
  process.stdout.write(`No jobleft server answers at port ${info.port}; removing the stale run file.\n`);
  rmSync(runFile, { force: true });
  process.exit(0);
}
try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
const t0 = Date.now();
while (alive(info.pid) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100));
if (alive(info.pid)) {
  try { process.kill(info.pid, 'SIGKILL'); } catch { /* gone */ }
  process.stdout.write(`jobleft (process ${info.pid}) did not stop in 10 s and was killed.\n`);
} else {
  process.stdout.write(`jobleft (process ${info.pid}) stopped.\n`);
}
rmSync(runFile, { force: true });
