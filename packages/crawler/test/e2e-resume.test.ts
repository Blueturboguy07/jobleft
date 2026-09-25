// Outcome O11: the CLI is killed (SIGKILL) in the middle of a crawl; the next start opens the store with no repair
// step, keeps every stored job, crawls only the boards that were not done, and no job is ever half stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startMockBoards, tempDir } from './helpers.ts';
import type { MockServer } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function runCli(args: string[]): { child: ReturnType<typeof spawn>; done: Promise<{ code: number | null; out: string }> } {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JOBLEFT_HOST_MAP: '' } });
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  return { child, done: new Promise((resolve) => child.on('exit', (code) => resolve({ code, out }))) };
}

test('O11: a crawl killed mid-way resumes with the boards it had not finished, and the store is whole', async () => {
  const t = tempDir();
  const db = join(t.dir, 'jobleft.db');
  const servers: MockServer[] = [];
  const boards: Array<Record<string, string>> = [];
  const desc = '<p>' + 'Pick, pack and ship orders. '.repeat(300) + '</p>';
  for (let h = 0; h < 6; h++) {
    const defs: Record<string, { ats: 'greenhouse'; jobs: Array<{ id: string; title: string; location: string; description: string }> }> = {};
    for (let i = 0; i < 5; i++) defs[`h${h}b${i}`] = { ats: 'greenhouse', jobs: Array.from({ length: 40 }, (_, k) => ({ id: `h${h}b${i}-${k}`, title: `Warehouse Associate ${k}`, location: 'Reno, NV', description: desc })) };
    const m = await startMockBoards({ boards: defs });
    servers.push(m);
    for (const k of Object.keys(defs)) boards.push({ ats: 'greenhouse', board: k, company: `Co ${k}`, origin: m.origin });
  }
  const list = join(t.dir, 'boards.json');
  writeFileSync(list, JSON.stringify(boards));
  try {
    const first = runCli(['run', '--boards', list, '--db', db]);
    let done = 0;
    while (done < 10) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const d = new DatabaseSync(db, { readOnly: true });
        done = Number((d.prepare('SELECT max(boards_done) AS n FROM crawler_runs').get() as { n: number | null }).n ?? 0);
        d.close();
      } catch { /* not created yet */ }
    }
    first.child.kill('SIGKILL');
    await first.done;
    await new Promise((r) => setTimeout(r, 300)); // let the mocks log anything still in their sockets
    const counts = servers.map((s) => s.requests.length);
    const boardRequests = (from: number[] | null) => servers.flatMap((s, i) => s.requests.slice(from ? from[i] : 0, from ? undefined : counts[i])
      .filter((r) => r.path.startsWith('/v1')).map((r) => `${s.origin}${r.path}`));
    const before = new Set(boardRequests(null));
    const d = new DatabaseSync(db, { readOnly: true });
    const kept = Number((d.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n);
    const perBoard = d.prepare('SELECT board, count(*) AS n FROM jobs GROUP BY board').all() as Array<{ n: number }>;
    const doneBoards = new Set((d.prepare("SELECT board FROM crawler_run_boards WHERE state = 'done'").all() as Array<{ board: string }>).map((r) => r.board));
    d.close();
    assert.ok(kept >= 400, `the jobs of the finished boards are kept (${kept})`);
    for (const b of perBoard) assert.equal(Number(b.n), 40, 'no board is half stored');
    const second = runCli(['run', '--boards', list, '--db', db]);
    const r2 = await second.done;
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /resuming run #1/);
    const after = boardRequests(counts);
    const boardOf = (u: string) => /\/v1\/boards\/([^/]+)\/jobs/.exec(u)![1]!;
    assert.equal(after.filter((u) => doneBoards.has(boardOf(u))).length, 0, `the restart does not crawl the finished boards again: done ${[...doneBoards].join(',')} after ${after.map(boardOf).join(',')}\n${r2.out}`);
    assert.equal(new Set(after.map(boardOf)).size, 30 - doneBoards.size, 'it crawls every board that was not finished');
    // A board whose reply was in flight at the kill was not stored, so it is read again: that is the only overlap.
    assert.ok(after.filter((u) => before.has(u)).length <= 6, 'only boards in flight at the kill are read twice');
    const verify = runCli(['verify', '--db', db]);
    const v = await verify.done;
    assert.equal(v.code, 0, v.out);
    const d2 = new DatabaseSync(db, { readOnly: true });
    assert.equal(Number((d2.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n), 1200);
    assert.equal(Number((d2.prepare("SELECT count(*) AS n FROM jobs WHERE title = '' OR page_url IS NULL OR description = ''").get() as { n: number }).n), 0);
    d2.close();
  } finally {
    for (const s of servers) await s.close();
    t.cleanup();
  }
});
