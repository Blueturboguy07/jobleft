// Starts the whole UI demo: the stand-in employer boards, the stand-in publik API, the stand-in AI model and the
// local API mock (which serves the built UI). Each runs as its own process, so one can be stopped on its own
// (node apps/ui/mock/ctl.ts ai stop). Ctrl+C stops them all.
// Run: node apps/ui/mock/run.ts [--home DIR] [--balance 4.37] [--persona] [--jobs 50000] [--reset] [...server options]

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './util.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, '..');
const argv = process.argv.slice(2);
const args = parseArgs(argv);
const home = resolve(String(args.home ?? join(UI, '.mock-home')));
mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });

if (!existsSync(join(UI, 'dist', 'index.html')) || args.build) {
  console.log('Building the UI (vite build)...');
  const r = spawnSync(process.execPath, [join(UI, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: UI, stdio: 'inherit' });
  if (r.status !== 0) { console.error('The UI build failed.'); process.exit(1); }
}

const node = process.execPath;
const children = new Map<string, ChildProcess>();

function start(name: string, file: string, extra: string[]): void {
  const c = spawn(node, [join(HERE, file), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (s: Buffer) => s.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  c.stdout!.on('data', (d: Buffer) => process.stdout.write(prefix(d)));
  c.stderr!.on('data', (d: Buffer) => process.stderr.write(prefix(d)));
  c.on('exit', (code) => { if (children.get(name) === c) console.log(`[${name}] stopped (${code ?? 'signal'})`); });
  children.set(name, c);
}

const pass = argv.filter((a, i) => !['--balance', '--price', '--legacy-wording', '--build'].includes(a) && !(['--balance', '--price'].includes(argv[i - 1] ?? '')));
start('boards', 'boards-server.ts', ['--home', home]);
start('publik', 'publik.ts', ['--dir', join(home, 'publik-standin'), ...(args.balance !== undefined ? ['--balance', String(args.balance)] : []), ...(args.price !== undefined ? ['--price', String(args.price)] : []), ...(args['legacy-wording'] ? ['--legacy-wording'] : [])]);
start('ai', 'ai.ts', []);
setTimeout(() => {
  start('api', 'server.ts', [...pass.filter((a) => a !== '--home' && a !== home && a !== String(args.home)), '--home', home]);
  const pids = Object.fromEntries([...children].map(([k, c]) => [k, c.pid]));
  writeFileSync(join(home, 'run', 'demo.json'), JSON.stringify({ runner: process.pid, pids, home }), { mode: 0o600 });
}, 400);

function stopAll(): void {
  for (const c of children.values()) try { c.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
