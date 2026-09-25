// Controls a running demo (started with run.ts):
//   node apps/ui/mock/ctl.ts status
//   node apps/ui/mock/ctl.ts ai stop|start          the stand-in AI model on this computer
//   node apps/ui/mock/ctl.ts publik stop|start      the stand-in publik API
//   node apps/ui/mock/ctl.ts boards stop|start      the stand-in employer boards ("employer sites are down")
//   node apps/ui/mock/ctl.ts offline on|off         pretend the computer has no network
//   node apps/ui/mock/ctl.ts balance 4.37           set the stand-in publik balance (dollars)
//   node apps/ui/mock/ctl.ts ledger                 print the stand-in publik charge log
//   node apps/ui/mock/ctl.ts board-down <boardId>   make one employer board answer "service unavailable"
//   node apps/ui/mock/ctl.ts board-up <boardId>
//   node apps/ui/mock/ctl.ts remove-posting <jobId>   take one posting off its stand-in employer board (the job id as the API
//                                                     shows it, for example greenhouse:acme:1234); the next refresh closes the job
//   node apps/ui/mock/ctl.ts restore-posting <jobId>  put that posting back on its board
// Add --home DIR when the demo uses another data folder.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS, parseArgs } from './util.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = parseArgs(argv);
const words = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--home');
const home = resolve(String(args.home ?? join(HERE, '..', '.mock-home')));
const demoFile = join(home, 'run', 'demo.json');
const serverFile = join(home, 'run', 'server.json');

const FILES: Record<string, { file: string; args: string[] }> = {
  ai: { file: 'ai.ts', args: ['--traffic', join(home, 'traffic', 'ai.ndjson')] },
  publik: { file: 'publik.ts', args: ['--dir', join(home, 'publik-standin')] },
  boards: { file: 'boards-server.ts', args: ['--home', home] },
};

function demo(): { runner: number; pids: Record<string, number>; home: string } {
  if (!existsSync(demoFile)) { console.error(`No running demo found (${demoFile}). Start it with: pnpm --filter @jobleft/ui demo`); process.exit(1); }
  return JSON.parse(readFileSync(demoFile, 'utf8'));
}

async function main(): Promise<void> {
  const [what, action] = words;
  if (!what || what === 'status') {
    const d = demo();
    for (const [k, pid] of Object.entries(d.pids)) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      console.log(`${k.padEnd(7)} pid ${pid} ${alive ? 'running' : 'stopped'}`);
    }
    return;
  }
  if (FILES[what] && (action === 'stop' || action === 'start')) {
    const d = demo();
    if (action === 'stop') {
      try { process.kill(d.pids[what]!, 'SIGTERM'); console.log(`Stopped the ${what} stand-in.`); } catch { console.log(`The ${what} stand-in was not running.`); }
    } else {
      const c = spawn(process.execPath, [join(HERE, FILES[what]!.file), ...FILES[what]!.args], { detached: true, stdio: 'ignore' });
      c.unref();
      d.pids[what] = c.pid!;
      writeFileSync(demoFile, JSON.stringify(d), { mode: 0o600 });
      console.log(`Started the ${what} stand-in (pid ${c.pid}).`);
    }
    return;
  }
  if (what === 'offline' && (action === 'on' || action === 'off')) {
    const s = JSON.parse(readFileSync(serverFile, 'utf8')) as { port: number; token: string };
    const r = await fetch(`http://127.0.0.1:${s.port}/__mock/offline`, { method: 'POST', headers: { 'x-jobleft-token': s.token, 'content-type': 'application/json' }, body: JSON.stringify({ on: action === 'on' }) });
    console.log(r.ok ? `Offline is ${action}.` : `Could not change offline (${r.status}).`);
    return;
  }
  if (what === 'balance' && action) {
    const r = await fetch(`http://127.0.0.1:${PORTS.publik}/__admin/balance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usd: Number(action) }) });
    console.log(r.ok ? `The stand-in publik balance is now $${Number(action).toFixed(2)}.` : `Could not set the balance (${r.status}).`);
    return;
  }
  if (what === 'ledger') {
    const r = await fetch(`http://127.0.0.1:${PORTS.publik}/__admin/ledger`);
    process.stdout.write(await r.text());
    return;
  }
  if ((what === 'board-down' || what === 'board-up') && action) {
    const f = join(home, 'boards', `${action.replace(':', '__')}.json`);
    if (!existsSync(f)) { console.error(`No board file ${f}`); process.exit(1); }
    const b = JSON.parse(readFileSync(f, 'utf8')) as { down?: boolean };
    b.down = what === 'board-down';
    writeFileSync(f, JSON.stringify(b));
    console.log(`${action} is now ${b.down ? 'down' : 'up'}.`);
    return;
  }
  if ((what === 'remove-posting' || what === 'restore-posting') && action) {
    const [ats, board, ...rest] = action.split(':');
    const externalId = rest.join(':');
    const f = join(home, 'boards', `${ats}__${board}.json`);
    if (!ats || !board || !externalId || !existsSync(f)) { console.error(`No board file for job id "${action}". A job id looks like ashby:acmelogistics:1234abcd.`); process.exit(1); }
    const b = JSON.parse(readFileSync(f, 'utf8')) as { postings: Array<{ externalId: string }>; removed?: Array<{ externalId: string }> };
    const same = (x: { externalId: string }) => x.externalId.toLowerCase() === externalId.toLowerCase();
    if (what === 'remove-posting') {
      const hit = b.postings.find(same);
      if (!hit) { console.error(`That posting is not on ${ats}:${board}.`); process.exit(1); }
      b.postings = b.postings.filter((x) => !same(x));
      b.removed = [...(b.removed ?? []), hit];
      writeFileSync(f, JSON.stringify(b));
      console.log(`Removed ${action} from its board. Press "Refresh now" in the app (or wait for the next refresh) and the job moves to the closed views.`);
    } else {
      const hit = (b.removed ?? []).find(same);
      if (!hit) { console.error(`${action} was not removed with this tool.`); process.exit(1); }
      b.postings.push(hit as never);
      b.removed = (b.removed ?? []).filter((x) => !same(x));
      writeFileSync(f, JSON.stringify(b));
      console.log(`Put ${action} back on its board.`);
    }
    return;
  }
  console.error('Unknown command. See the top of apps/ui/mock/ctl.ts or the README.');
  process.exit(1);
}

void main();
