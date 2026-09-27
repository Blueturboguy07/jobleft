// The CLI as the README uses it: stand-in boards, JOBLEFT_HOST_MAP, crawl, jobs, report. Nothing live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStandin } from '../src/standin.ts';
import { HERE, tmp } from './helpers.ts';

const CLI = join(HERE, '..', 'src', 'cli.ts');

const run = promisify(execFile);
/** Async on purpose: the stand-in servers live in this process and must keep answering while the CLI runs. */
async function cli(args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  return stdout;
}

test('README flow: failed, empty and garbage answers close nothing; a proven absence closes one job (O5, O13)', async () => {
  const t = tmp();
  const dir = join(t.dir, 'standin');
  mkdirSync(join(dir, 'recruitee'), { recursive: true });
  const file = join(dir, 'recruitee', 'five-demo.json');
  const meta = join(dir, 'recruitee', 'five-demo.meta.json');
  const offers = [1, 2, 3, 4, 5].map((i) => ({
    id: i, title: `Role ${i}`, company_name: 'Five Demo', careers_url: `https://five-demo.recruitee.com/o/role-${i}`,
    published_at: '2026-09-01 10:00:00 UTC', description: `<p>Job ${i}</p>`,
  }));
  writeFileSync(file, JSON.stringify({ offers }));
  const s = await startStandin(dir);
  const env = { JOBLEFT_HOST_MAP: JSON.stringify(s.hostMap) };
  const boards = join(t.dir, 'boards.json');
  writeFileSync(boards, JSON.stringify([{ ats: 'recruitee', board: 'five-demo', company: 'Five Demo' }]));
  const db = join(t.dir, 'jobs.db');
  const crawlArgs = ['crawl', '--boards', boards, '--db', db, '--grace-hours', '0'];
  const openIds = async (): Promise<string[]> => (JSON.parse(await cli(['jobs', '--db', db, '--json'])) as Array<{ externalId: string; status: string }>)
    .filter((j) => j.status === 'open').map((j) => j.externalId).sort();
  try {
    assert.match(await cli(crawlArgs, env), /crawl done: 1 of 1 boards ok, 5 jobs read \(5 new\)/);
    for (const [what, m] of [['500', { status: 500 }], ['empty list', { body: '{"offers": []}' }], ['garbage', { body: 'garbage' }]] as const) {
      writeFileSync(meta, JSON.stringify(m));
      const out = await cli(crawlArgs, env);
      assert.deepEqual(await openIds(), ['1', '2', '3', '4', '5'], `after ${what}: ${out}`);
    }
    writeFileSync(meta, '{}');
    writeFileSync(file, JSON.stringify({ offers: offers.slice(0, 4) }));
    const out = await cli([...crawlArgs, '--out', join(t.dir, 'report.json')], env);
    assert.match(out, /closed 1/);
    assert.deepEqual(await openIds(), ['1', '2', '3', '4']);
    const closed = (JSON.parse(await cli(['jobs', '--db', db, '--json', '--status', 'closed'])) as Array<{ externalId: string; closedAt: string; closedReason: string }>);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].externalId, '5');
    assert.equal(closed[0].closedReason, 'unseen');
    assert.match(closed[0].closedAt, /^\d{4}-\d\d-\d\dT/);
    const report = JSON.parse(readFileSync(join(t.dir, 'report.json'), 'utf8'));
    assert.equal(report.health.boards[0].closed, 1);
    assert.equal(report.health.boards[0].read, 4);
    assert.equal(report.userAgent, 'jobleft/0.1.1 (+https://github.com/Blueturboguy07/jobleft; no personal data)');
    // The health report from the database names the board and its counts.
    const rep = JSON.parse(await cli(['report', '--db', db, '--json']));
    assert.deepEqual([rep.boards[0].openJobs, rep.boards[0].closedJobs, rep.boards[0].state], [4, 1, 'ok']);
    // Offline sends nothing.
    const before = s.requests.length;
    assert.match(await cli(crawlArgs, { ...env, JOBLEFT_OFFLINE: '1' }), /offline/);
    assert.equal(s.requests.length, before);
  } finally {
    await s.close(); t.done();
  }
});

test('sources and detect print plain answers and send nothing', async () => {
  const src = await cli(['sources']);
  for (const name of ['Workable', 'Recruitee', 'Personio', 'SmartRecruiters', 'Workday', 'iCIMS', 'LinkedIn', 'Indeed', 'Glassdoor']) assert.ok(src.includes(name), name);
  const json = JSON.parse(await cli(['detect', 'https://acme.jobs.personio.com/job/12', 'https://www.indeed.com/viewjob?jk=1', '--json']));
  assert.equal(json[0].verdict, 'crawlable');
  assert.equal(json[0].detection.region, 'com');
  assert.equal(json[1].verdict, 'never');
});
