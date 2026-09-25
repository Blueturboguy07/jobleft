// Integration: the real runner and service against the stand-in feeds (loopback only, no live request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceInfoSchema, validate } from '@jobleft/contracts';
import { SourceService } from '../src/service.ts';
import { refreshSources } from '../src/runner.ts';
import type { JobFeed } from '../src/types.ts';
import { remoteOk } from '../src/feeds/remoteok.ts';
import { readStandinLog, setScenario, startStandin } from '../src/standin.ts';
import { feedJobs, openJobsFor, exportFeedJobs } from '../src/view.ts';
import { DbPacer, MIN_GAP_MS } from '../src/http.ts';
import { cleanup, clock, memorySecrets, noWait, openTestStore, tempDir } from './helpers.ts';

const HOUR = 3_600_000;
const CRAWLED = ['remoteok', 'themuse', 'hn-whoishiring', 'gh-simplify-internships', 'gh-vanshb03-internships', 'gh-vanshb03-newgrad', 'gh-speedyapply-swe', 'gh-speedyapply-ai'];

async function setup(opts: { key?: string; timeoutMs?: number; pacer?: 'none' | 'db' } = {}) {
  const dir = tempDir();
  const standinDir = join(dir, 'standin');
  const standin = await startStandin({ dir: standinDir, basePort: 0 });
  const store = openTestStore(dir);
  const secrets = memorySecrets(opts.key ? { 'jobleft.source.themuse.key': opts.key } : {});
  const c = clock();
  const svc = new SourceService({
    store, secrets, now: c.now, hostMap: standin.hostMap, timeoutMs: opts.timeoutMs ?? 2000,
    pacer: opts.pacer === 'db' ? new DbPacer(store.db) : noWait,
  });
  return {
    dir, standinDir, standin, store, secrets, clock: c, svc,
    async done() { store.close(); await standin.close(); cleanup(dir); },
    log: () => readStandinLog(standinDir),
    editJson(file: string, fn: (d: any) => any) { const p = join(standinDir, file); writeFileSync(p, JSON.stringify(fn(JSON.parse(readFileSync(p, 'utf8'))))); },
  };
}

test('O1/O2/O14: every source adds its fixture jobs with its name, exact link and credit; counts agree with the list', async () => {
  const t = await setup({ key: 'TESTKEY-0000-jordan' });
  try {
    for (const id of CRAWLED) await t.svc.update(id, { enabled: true });
    const rep = await t.svc.refresh();
    const byId = Object.fromEntries(rep.results.map((r) => [r.sourceId, r]));
    for (const id of CRAWLED) assert.equal(byId[id]!.outcome, 'ok', `${id}: ${byId[id]!.message}`);
    const expected: Record<string, number> = { remoteok: 10, themuse: 5, 'hn-whoishiring': 7, 'gh-simplify-internships': 5, 'gh-vanshb03-internships': 3, 'gh-vanshb03-newgrad': 3, 'gh-speedyapply-swe': 9, 'gh-speedyapply-ai': 5 };
    const list = await t.svc.list();
    for (const s of list) assert.ok(validate(SourceInfoSchema, s).ok, `SourceInfo ${s.id} matches the contract`);
    for (const [id, n] of Object.entries(expected)) {
      const jobs = feedJobs(t.store.db, { sourceId: id });
      assert.equal(jobs.length, n, `${id} job count`);
      assert.equal(openJobsFor(t.store.db, id), n, `${id} open count on the source list`);
      assert.equal(list.find((s) => s.id === id)!.status.openJobs, n);
      for (const j of jobs) {
        const src = j.sources.find((s) => s.sourceId === id)!;
        assert.ok(src, `${j.title} names ${id}`);
        assert.ok(src.credit && src.credit.url.startsWith('https://'), `${j.title} carries the credit of ${id}`);
      }
    }
    // Exact links: the Remote OK link is the fixture URL character for character.
    const ro = JSON.parse(readFileSync(join(t.standinDir, 'remoteok.json'), 'utf8')) as Array<{ id?: string; url?: string }>;
    const nurse = feedJobs(t.store.db, { sourceId: 'remoteok' }).find((j) => j.externalId === '900001')!;
    assert.equal(nurse.url, ro.find((x) => x.id === '900001')!.url);
    assert.equal(nurse.sources[0]!.credit!.text, 'Found on Remote OK');
    // Export keeps the credits (O2).
    const lines = [...exportFeedJobs(t.store.db, { status: 'all' })].map((l) => JSON.parse(l));
    assert.ok(lines.length >= 44);
    assert.ok(lines.every((l) => l.sources.length >= 1 && l.sources.every((s: any) => s.url.startsWith('http'))));
    assert.ok(lines.filter((l) => l.sources.some((s: any) => s.sourceId === 'remoteok')).every((l) => /Found on Remote OK/.test(l.creditLine)));
    // Not crawled: nothing was sent to their hosts.
    const hosts = new Set(t.log().map((l) => l.host));
    assert.ok(!hosts.has('remotive.com') && !hosts.has('data.usajobs.gov'));
  } finally { await t.done(); }
});

test('O3: limits hold across repeated presses, restarts, two services on one file, and a double trigger', async () => {
  const t = await setup();
  try {
    await t.svc.update('remoteok', { enabled: true });
    assert.equal((await t.svc.refresh({ ids: ['remoteok'] })).results[0]!.outcome, 'ok');
    const sent = t.log().length;
    for (let i = 0; i < 10; i++) {
      const r = await t.svc.refresh({ ids: ['remoteok'] });
      assert.equal(r.results[0]!.skipReason, 'too_early');
      assert.ok(r.nextAllowedAt && Date.parse(r.nextAllowedAt) === t.clock.now() + HOUR);
    }
    // "Restart": a new service on the same database keeps the count.
    const again = new SourceService({ store: t.store, secrets: t.secrets, now: t.clock.now, hostMap: t.standin.hostMap, pacer: noWait });
    assert.equal((await again.refresh({ ids: ['remoteok'] })).results[0]!.skipReason, 'too_early');
    assert.equal(t.log().length, sent, 'no request while too early');
    // Four runs in 24 hours, then the daily limit (rolling window).
    for (let i = 0; i < 3; i++) { t.clock.advance(HOUR); assert.equal((await t.svc.refresh({ ids: ['remoteok'] })).results[0]!.outcome, 'ok'); }
    t.clock.advance(HOUR);
    const fifth = await t.svc.refresh({ ids: ['remoteok'] });
    assert.equal(fifth.results[0]!.skipReason, 'daily_limit');
    t.clock.advance(20 * HOUR + 1);
    assert.equal((await t.svc.refresh({ ids: ['remoteok'] })).results[0]!.outcome, 'ok', 'the oldest run left the 24-hour window');
    // Launch catch-up and a background poll at the same moment: one run only.
    t.clock.advance(2 * HOUR);
    const before = t.log().filter((l) => l.path === '/api').length;
    const [a, b] = await Promise.all([t.svc.runDue('launch'), again.runDue('schedule')]);
    const ran = [...a.results, ...b.results].filter((r) => r.sourceId === 'remoteok' && r.outcome === 'ok').length;
    assert.equal(ran, 1);
    assert.equal(t.log().filter((l) => l.path === '/api').length, before + 1);
  } finally { await t.done(); }
});

test('O3: a failed source is retried later within its limits, and a 429 waits at least an hour', async () => {
  const t = await setup();
  try {
    await t.svc.update('remoteok', { enabled: true });
    setScenario(t.standinDir, 'remoteok', 'http429');
    assert.equal((await t.svc.refresh({ ids: ['remoteok'] })).results[0]!.outcome, 'failed');
    const info = await t.svc.get('remoteok');
    assert.equal(info.status.state, 'rate_limited');
    assert.ok(Date.parse(info.status.nextAllowedAt!) >= t.clock.now() + HOUR);
    t.clock.advance(30 * 60_000);
    assert.equal((await t.svc.runDue()).results.length, 0, 'the scheduler does not retry before the wait');
    t.clock.advance(3 * HOUR);
    setScenario(t.standinDir, 'remoteok', 'ok');
    assert.equal((await t.svc.runDue()).results[0]?.outcome, 'ok');
  } finally { await t.done(); }
});

test('O4: a source that needs a key sends nothing without it, says so with steps, and never leaks the key', async () => {
  const t = await setup();
  try {
    await t.svc.update('themuse', { enabled: true });
    await t.svc.update('remoteok', { enabled: true });
    const r1 = await t.svc.refresh();
    assert.equal(r1.results.find((r) => r.sourceId === 'themuse')!.skipReason, 'needs_key');
    assert.equal(r1.results.find((r) => r.sourceId === 'remoteok')!.outcome, 'ok', 'other sources continue');
    assert.equal(t.log().filter((l) => l.host === 'www.themuse.com').length, 0);
    const info = await t.svc.get('themuse');
    assert.equal(info.status.state, 'needs_key');
    assert.match(info.status.lastProblem!, /Register a free app/);
    await assert.rejects(t.svc.setKey('themuse', 'short'), /8 to 200/);
    const saved = await t.svc.setKey('themuse', 'TESTKEY-0000-jordan');
    assert.ok(!JSON.stringify(saved).includes('TESTKEY'), 'the answer never holds the key');
    assert.equal(saved.keySet, true);
    t.clock.advance(7 * HOUR);
    assert.equal((await t.svc.refresh({ ids: ['themuse'] })).results[0]!.outcome, 'ok');
    // A wrong key is a different status from "no jobs".
    setScenario(t.standinDir, 'themuse', 'http401');
    t.clock.advance(7 * HOUR);
    const bad = (await t.svc.refresh({ ids: ['themuse'] })).results[0]!;
    assert.match(bad.message, /refused the key/);
    // The key is in no file jobleft wrote, nor in the stand-in log.
    for (const f of readdirSync(t.dir, { recursive: true }) as string[]) {
      const p = join(t.dir, f);
      let buf: Buffer;
      try { buf = readFileSync(p); } catch { continue; }
      assert.ok(!buf.includes('TESTKEY-0000-jordan'), `key found in ${f}`);
    }
  } finally { await t.done(); }
});

test('O5: 500, renamed fields and a source that never answers each get their own plain status; good sources still arrive', async () => {
  const t = await setup({ timeoutMs: 700 });
  try {
    for (const id of ['remoteok', 'gh-vanshb03-internships', 'gh-vanshb03-newgrad', 'gh-speedyapply-swe', 'hn-whoishiring']) await t.svc.update(id, { enabled: true });
    setScenario(t.standinDir, 'remoteok', 'http500');
    setScenario(t.standinDir, 'gh-vanshb03-internships', 'renamed');
    setScenario(t.standinDir, 'gh-vanshb03-newgrad', 'hang');
    setScenario(t.standinDir, 'hn-whoishiring', 'html');
    const t0 = Date.now();
    const rep = await t.svc.refresh();
    assert.ok(Date.now() - t0 < 8000, 'a silent source does not hold the refresh');
    const by = Object.fromEntries(rep.results.map((r) => [r.sourceId, r]));
    assert.equal(by['gh-speedyapply-swe']!.outcome, 'ok');
    assert.equal(feedJobs(t.store.db, { sourceId: 'gh-speedyapply-swe' }).length, 9);
    const list = Object.fromEntries((await t.svc.list()).map((s) => [s.id, s]));
    const msgs = ['remoteok', 'gh-vanshb03-internships', 'gh-vanshb03-newgrad', 'hn-whoishiring'].map((id) => {
      assert.equal(list[id]!.status.state, 'failing', id);
      assert.match(list[id]!.status.lastProblem!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC: /, 'with a time');
      return list[id]!.status.lastProblem!.replace(/^.*UTC: /, '');
    });
    assert.match(msgs[0]!, /server error \(HTTP 500\)/);
    assert.match(msgs[1]!, /data format changed/);
    assert.match(msgs[2]!, /did not answer within/);
    assert.match(msgs[3]!, /web page instead of job data/);
    assert.equal(new Set(msgs).size, 4);
    // Nothing blank was stored.
    assert.ok(feedJobs(t.store.db, { status: 'all' }).every((j) => j.title && j.title !== 'undefined' && j.title !== 'null' && j.company));
  } finally { await t.done(); }
});

test('O6: an error, an empty answer, a cut-off body or a failed page never closes or deletes saved jobs', async () => {
  const t = await setup({ key: 'TESTKEY-0000-jordan' });
  try {
    await t.svc.update('remoteok', { enabled: true });
    await t.svc.update('themuse', { enabled: true });
    await t.svc.refresh();
    const ids = feedJobs(t.store.db, { sourceId: 'remoteok' }).map((j) => j.id).sort();
    assert.equal(ids.length, 10);
    for (const sc of ['http500', 'empty', 'truncated', 'cutoff', 'notjson', 'redirect', 'http404'] as const) {
      setScenario(t.standinDir, 'remoteok', sc);
      t.clock.advance(7 * HOUR);
      const r = (await t.svc.refresh({ ids: ['remoteok'] })).results[0]!;
      assert.equal(r.closed, 0, `${sc} closed nothing`);
      assert.deepEqual(feedJobs(t.store.db, { sourceId: 'remoteok' }).map((j) => j.id).sort(), ids, `${sc}: all 10 still open`);
      const info = await t.svc.get('remoteok');
      assert.equal(info.status.state, 'failing', `${sc}: the state shows the problem`);
      assert.notEqual(info.status.lastProblem, null, `${sc}: the problem is shown`);
    }
    assert.equal(t.store.count("ats = 'feed:remoteok'"), 10, 'no row was deleted');
    // A paged source that fails on a later page keeps page 1 and closes nothing.
    t.editJson('themuse.json', (d) => ({ results: [...d.results, ...Array.from({ length: 20 }, (_, i) => ({ ...d.results[0], id: 23000000 + i, name: `Extra role ${i}`, refs: { landing_page: `https://www.themuse.com/jobs/x/extra-${i}` } }))] }));
    t.clock.advance(7 * HOUR);
    assert.equal((await t.svc.refresh({ ids: ['themuse'] })).results[0]!.outcome, 'ok');
    const museBefore = feedJobs(t.store.db, { sourceId: 'themuse' }).length;
    assert.equal(museBefore, 25);
    setScenario(t.standinDir, 'themuse', 'page2fail');
    t.clock.advance(7 * HOUR);
    const r = (await t.svc.refresh({ ids: ['themuse'] })).results[0]!;
    assert.equal(r.outcome, 'failed');
    assert.match(r.message, /page 2 of 2 failed/);
    assert.equal(feedJobs(t.store.db, { sourceId: 'themuse' }).length, museBefore);
  } finally { await t.done(); }
});

test('O7: a job the source stops listing closes on the next good answer; a new one appears; a returning one reopens; a mass drop waits', async () => {
  const t = await setup();
  try {
    await t.svc.update('remoteok', { enabled: true });
    await t.svc.refresh({ ids: ['remoteok'] });
    t.editJson('remoteok.json', (d) => [...d.filter((x: any) => x.id !== '900003'), { ...d[1], id: '900011', slug: 'new-900011', position: 'Brand New Role', url: 'https://remoteOK.com/remote-jobs/new-900011', apply_url: 'https://remoteOK.com/remote-jobs/new-900011' }]);
    t.clock.advance(HOUR);
    const r = (await t.svc.refresh({ ids: ['remoteok'] })).results[0]!;
    assert.equal(r.closed, 1);
    assert.equal(r.inserted, 1);
    const open = feedJobs(t.store.db, { sourceId: 'remoteok' });
    assert.ok(!open.some((j) => j.externalId === '900003'));
    assert.ok(open.some((j) => j.title === 'Brand New Role'));
    const closed = feedJobs(t.store.db, { status: 'closed' }).find((j) => j.externalId === '900003')!;
    assert.equal(closed.closedReason, 'source_removed');
    // It comes back.
    t.editJson('remoteok.json', (d) => [...d, { ...d[3], id: '900003', slug: 'back', position: 'Customer Support Specialist', company: 'Dunmore Analytics', location: 'Europe only', url: 'https://remoteOK.com/remote-jobs/remote-customer-support-specialist-dunmore-analytics-900003', apply_url: 'https://remoteOK.com/remote-jobs/remote-customer-support-specialist-dunmore-analytics-900003' }]);
    t.clock.advance(HOUR);
    const back = (await t.svc.refresh({ ids: ['remoteok'] })).results[0]!;
    assert.equal(back.reopened, 1);
    assert.ok(feedJobs(t.store.db, { sourceId: 'remoteok' }).some((j) => j.externalId === '900003'));
    // A drop of more than half waits for a second answer at least 12 hours later.
    t.editJson('remoteok.json', (d) => d.slice(0, 3));
    t.clock.advance(HOUR);
    const held = (await t.svc.refresh({ ids: ['remoteok'] })).results[0]!;
    assert.equal(held.closed, 0);
    assert.match(held.closeHeld ?? '', /more than half/);
    t.clock.advance(22 * HOUR); // at least 12 hours later, and past the 4-a-day window
    const confirmed = (await t.svc.refresh({ ids: ['remoteok'] })).results[0]!;
    assert.equal(confirmed.closed, 9);
    assert.equal(feedJobs(t.store.db, { sourceId: 'remoteok' }).length, 2);
  } finally { await t.done(); }
});

test('O7: a merged posting closes when the LAST source drops it, in either drop order, and stays closed on later unchanged answers', async () => {
  for (const order of [['gh-simplify-internships', 'gh-vanshb03-internships'], ['gh-vanshb03-internships', 'gh-simplify-internships']] as const) {
    const t = await setup();
    try {
      for (const id of order) await t.svc.update(id, { enabled: true });
      await t.svc.refresh({ ids: [...order] });
      const acme = () => feedJobs(t.store.db, { status: 'all' }).filter((j) => j.company === 'Acme Robotics');
      assert.equal(acme().length, 1);
      assert.equal(acme()[0]!.status, 'open');
      assert.equal(acme()[0]!.sources.length, 2, 'both sources list it');
      const dropped: Record<string, any> = {};
      const drop = (file: string) => t.editJson(file, (d) => { dropped[file] = d.find((x: any) => x.company_name === 'Acme Robotics'); return d.filter((x: any) => x.company_name !== 'Acme Robotics'); });
      // The first source drops it: the other still lists it, so the job stays open.
      drop(`${order[0]}.json`);
      t.clock.advance(2 * HOUR);
      await t.svc.refresh({ ids: [order[0]] });
      assert.equal(acme()[0]!.status, 'open', `${order[0]} dropped it, ${order[1]} still lists it`);
      // The last source drops it: the job closes at THIS refresh, whichever source created the row.
      drop(`${order[1]}.json`);
      t.clock.advance(HOUR);
      const last = (await t.svc.refresh({ ids: [order[1]] })).results[0]!;
      assert.equal(last.closed, 1);
      assert.equal(acme()[0]!.status, 'closed', 'closed when the last source dropped it');
      assert.equal(acme()[0]!.closedReason, 'source_removed');
      assert.ok(!feedJobs(t.store.db, {}).some((j) => j.company === 'Acme Robotics'), 'gone from the default list');
      assert.ok(!feedJobs(t.store.db, { sourceId: order[0] }).some((j) => j.company === 'Acme Robotics'));
      // Later refreshes with unchanged content (a 304) keep it closed and do not fail.
      t.clock.advance(28 * HOUR);
      const again = (await t.svc.refresh({ ids: [...order] })).results;
      for (const r of again) assert.equal(r.outcome, 'ok', r.message);
      assert.equal(acme()[0]!.status, 'closed');
      // It comes back when one source lists it again: one job, reopened.
      t.editJson(`${order[1]}.json`, (d) => [...d, dropped[`${order[1]}.json`]]);
      t.clock.advance(28 * HOUR);
      await t.svc.refresh({ ids: [order[1]] });
      assert.equal(acme().length, 1);
      assert.equal(acme()[0]!.status, 'open', 'reopened by a source that lists it');
    } finally { await t.done(); }
  }
});

test('O7: a job left with no open posting by an earlier refresh closes at the next refresh of its board, even on a 304', async () => {
  const t = await setup();
  try {
    for (const id of ['gh-simplify-internships', 'gh-vanshb03-internships']) await t.svc.update(id, { enabled: true });
    await t.svc.refresh({ ids: ['gh-simplify-internships', 'gh-vanshb03-internships'] });
    // Put the store in the state the old code left behind: both postings closed, the job row still open.
    t.store.db.exec(`UPDATE feed_postings SET status = 'closed', closed_at = '2026-09-25T13:00:00.000Z', closed_reason = 'source_removed'
      WHERE job_key IN (SELECT job_key FROM feed_postings GROUP BY job_key HAVING count(*) = 2)`);
    const stuck = () => (t.store.db.prepare(`SELECT count(*) AS n FROM jobs j WHERE j.closed_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM feed_postings fp WHERE fp.job_ats = j.ats AND fp.job_board = j.board AND fp.job_ext_id = j.job_id AND fp.status = 'open')`).get() as { n: number }).n;
    assert.equal(stuck(), 1);
    t.clock.advance(30 * HOUR);
    await t.svc.refresh({ ids: ['gh-simplify-internships'] });
    assert.equal(stuck(), 0);
    assert.ok(!feedJobs(t.store.db, {}).some((j) => j.company === 'Acme Robotics'));
  } finally { await t.done(); }
});

test('O10: the same posting from two lists is one job with both credits; different jobs with the same title stay apart', async () => {
  const t = await setup();
  try {
    t.editJson('gh-vanshb03-newgrad.json', (d) => [...d, { ...d[1], id: 'twin-1', title: 'Associate Product Manager', company_name: 'Marlow Retail', url: 'https://jobs.lever.co/marlow-example/2m2m2m2m-0000-4000-8000-00000000aaaa', locations: ['Austin, TX'] }]);
    for (const id of ['gh-simplify-internships', 'gh-vanshb03-internships', 'gh-vanshb03-newgrad']) await t.svc.update(id, { enabled: true });
    await t.svc.refresh();
    const acme = feedJobs(t.store.db, {}).filter((j) => j.company === 'Acme Robotics');
    assert.equal(acme.length, 1, 'one job');
    const credits = acme[0]!.sources.map((s) => s.credit?.text);
    assert.ok(credits.some((c) => /SimplifyJobs/.test(c!)) && credits.some((c) => /vanshb03/.test(c!)), 'both credits kept');
    assert.ok(acme[0]!.sources.every((s) => s.url.startsWith('https://job-boards.greenhouse.io/acmerobotics-example/jobs/7700000001')));
    // Simplify drops it; vanshb03 still lists it: the job stays open with both links.
    t.editJson('gh-simplify-internships.json', (d) => d.filter((x: any) => x.company_name !== 'Acme Robotics'));
    t.clock.advance(2 * HOUR);
    await t.svc.refresh({ ids: ['gh-simplify-internships'] });
    const still = feedJobs(t.store.db, {}).filter((j) => j.company === 'Acme Robotics');
    assert.equal(still.length, 1, 'the job stays open while another source lists it');
    const twins = feedJobs(t.store.db, { sourceId: 'gh-vanshb03-newgrad' }).filter((j) => j.title === 'Associate Product Manager');
    assert.equal(twins.length, 2, 'same title, same company, different posting: two jobs');
  } finally { await t.done(); }
});

test('O11: requests go only to the approved hosts with the fixed identity, and at least 1 second apart per host', async () => {
  const t = await setup({ pacer: 'db' });
  try {
    for (const id of ['gh-speedyapply-swe', 'gh-speedyapply-ai', 'remoteok']) await t.svc.update(id, { enabled: true });
    await t.svc.refresh();
    const log = t.log();
    assert.ok(log.length >= 10);
    const hosts = new Set(log.map((l) => l.host));
    for (const h of hosts) assert.ok(['remoteok.com', 'raw.githubusercontent.com'].includes(String(h)), `unexpected host ${h}`);
    for (const l of log) {
      const ua = String((l.headers as Record<string, string>)['user-agent']);
      assert.equal(ua, 'jobleft-build/0.1 (research build; no personal data)');
      assert.ok(!JSON.stringify(l).includes('Jordan') && !JSON.stringify(l).includes('jordan.testwell'));
    }
    const byHost = new Map<string, number[]>();
    for (const l of log) { const a = byHost.get(String(l.host)) ?? []; a.push(Date.parse(String(l.t))); byHost.set(String(l.host), a); }
    for (const [h, ts] of byHost) for (let i = 1; i < ts.length; i++) assert.ok(ts[i]! - ts[i - 1]! >= 1000, `${h}: gap ${ts[i]! - ts[i - 1]!} ms`);
    assert.ok(MIN_GAP_MS >= 1000);
  } finally { await t.done(); }
});

test('O13: a feed whose terms forbid storage is never saved', async () => {
  const t = await setup();
  try {
    const perQuery: JobFeed = { ...remoteOk, id: 'perquery', info: { ...remoteOk.info, id: 'perquery', name: 'Per-query partner' }, storable: false };
    const res = await refreshSources({ store: t.store, keys: async () => null, reason: 'manual', feeds: [perQuery], now: t.clock.now, hostMap: t.standin.hostMap, pacer: noWait });
    t.store.db.prepare("INSERT OR REPLACE INTO source_state (source_id, enabled) VALUES ('perquery', 1)").run();
    const res2 = await refreshSources({ store: t.store, keys: async () => null, reason: 'manual', feeds: [perQuery], now: t.clock.now, hostMap: t.standin.hostMap, pacer: noWait });
    assert.equal(res[0]!.skipReason, 'off');
    assert.equal(res2[0]!.skipReason, 'per_query_only');
    assert.equal(t.store.count("ats = 'feed:perquery'"), 0);
    assert.equal(t.log().length, 0);
  } finally { await t.done(); }
});

test('O14: a source turned off gets no request, its jobs are hidden from the source filter, and not-crawled sources cannot be turned on', async () => {
  const t = await setup();
  try {
    await t.svc.update('remoteok', { enabled: true });
    await t.svc.refresh({ ids: ['remoteok'] });
    await t.svc.update('remoteok', { enabled: false });
    t.clock.advance(5 * HOUR);
    const before = t.log().length;
    const r = (await t.svc.refresh()).results.find((x) => x.sourceId === 'remoteok')!;
    assert.equal(r.skipReason, 'off');
    assert.equal(t.log().length, before);
    assert.equal((await t.svc.get('remoteok')).status.state, 'off');
    assert.equal(feedJobs(t.store.db, { sourceId: 'remoteok' }).length, 0, 'hidden while off');
    assert.equal((await t.svc.get('remoteok')).status.openJobs, 0, 'the count agrees with the list');
    assert.equal(feedJobs(t.store.db, { sourceId: 'remoteok', includeOff: true }).length, 10, 'nothing was deleted');
    assert.equal(t.store.count("ats = 'feed:remoteok'"), 10);
    await t.svc.update('remoteok', { enabled: true });
    assert.equal(feedJobs(t.store.db, { sourceId: 'remoteok' }).length, 10, 'back when turned on');
    await assert.rejects(t.svc.update('remotive', { enabled: true }), /robots\.txt/);
    await assert.rejects(t.svc.update('usajobs', { enabled: true }), /robots\.txt/);
    await assert.rejects(t.svc.update('nope', { enabled: true }), /no source called/);
  } finally { await t.done(); }
});

test('O9: remote jobs open to US applicants: US-only and worldwide by default, unstated regions only on request', async () => {
  const t = await setup();
  try {
    await t.svc.update('remoteok', { enabled: true });
    await t.svc.refresh({ ids: ['remoteok'] });
    const titles = (q: Parameters<typeof feedJobs>[1]) => feedJobs(t.store.db, q).map((j) => j.title).sort();
    const us = titles({ remote: true, openToUs: true });
    assert.ok(us.includes('Registered Nurse Telehealth'), 'USA only');
    assert.ok(us.includes('Senior Backend Engineer'), 'worldwide');
    assert.ok(!us.includes('Customer Support Specialist'), 'Europe only never looks open to US applicants');
    assert.ok(!us.includes('Frontend Engineer'), 'Germany only');
    assert.ok(!us.includes('Data Annotator'), 'region not stated is left out by default');
    assert.ok(titles({ remote: true, openToUs: true, includeUnknownRegion: true }).includes('Data Annotator'));
    const unknown = feedJobs(t.store.db, { sourceId: 'remoteok' }).find((j) => j.title === 'Data Annotator')!;
    assert.equal(unknown.remoteScope, null);
    assert.equal(unknown.isUs, null);
  } finally { await t.done(); }
});

test('O9: remote jobs that bar the US ("excluding US", "except USA", "Not US", "Non-US") never look open to US applicants', async () => {
  const t = await setup();
  try {
    await t.svc.update('remoteok', { enabled: true });
    const labels = ['Worldwide (excluding US)', 'Anywhere except USA', 'Remote (Not US)', 'Non-US'];
    t.editJson('remoteok.json', (d) => [...d, ...labels.map((location, i) => ({
      ...d[1], id: `9100${i}`, slug: `neg-${i}`, position: `Negated Role ${i}`, location,
      url: `https://remoteOK.com/remote-jobs/neg-${i}`, apply_url: `https://remoteOK.com/remote-jobs/neg-${i}`,
    }))]);
    await t.svc.refresh({ ids: ['remoteok'] });
    const q = (extra: object) => feedJobs(t.store.db, { remote: true, openToUs: true, ...extra }).map((j) => j.title);
    for (const includeUnknownRegion of [false, true]) {
      const shown = q({ includeUnknownRegion });
      assert.ok(!shown.some((x) => x.startsWith('Negated Role')), `none is open to US (includeUnknownRegion ${includeUnknownRegion}): ${shown.join(', ')}`);
    }
    // They are still listed as remote jobs, with the words kept and no US region.
    const all = feedJobs(t.store.db, { sourceId: 'remoteok' }).filter((j) => j.title.startsWith('Negated Role'));
    assert.equal(all.length, 4);
    for (const j of all) {
      assert.equal(j.isUs, false);
      assert.ok(labels.includes(j.remoteScope!.text));
      assert.ok(!j.remoteScope!.regions.some((r) => r === 'US' || r === 'WORLDWIDE' || r === 'NA'));
    }
    // The fixtures' other jobs are unchanged.
    assert.ok(q({}).includes('Senior Backend Engineer'));
  } finally { await t.done(); }
});

test('O8: a level shows only when the source or the title states it; titles are plain text', async () => {
  const t = await setup();
  try {
    t.editJson('remoteok.json', (d) => [d[0], { ...d[1], id: '910001', position: 'Clinic &amp; Care <b>Nurse</b>', description: '<p>You need 8+ years of experience in clinics.</p>', url: 'https://remoteOK.com/remote-jobs/910001', apply_url: 'https://remoteOK.com/remote-jobs/910001' }, { ...d[2], id: '910002', position: 'Senior Nurse', url: 'https://remoteOK.com/remote-jobs/910002', apply_url: 'https://remoteOK.com/remote-jobs/910002' }]);
    await t.svc.update('remoteok', { enabled: true });
    await t.svc.refresh({ ids: ['remoteok'] });
    const jobs = feedJobs(t.store.db, { sourceId: 'remoteok' });
    const coord = jobs.find((j) => j.externalId === '910001')!;
    assert.equal(coord.title, 'Clinic & Care Nurse');
    assert.equal(coord.level, null, 'not inferred from "8+ years"');
    assert.deepEqual(coord.levels, []);
    const senior = jobs.find((j) => j.externalId === '910002')!;
    assert.equal(senior.level, 'senior');
    assert.equal(senior.evidence.level?.source, 'title');
  } finally { await t.done(); }
});

test('a run lease left by a process that is gone is taken over; a live one is respected', async () => {
  const t = await setup();
  try {
    await t.svc.update('remoteok', { enabled: true });
    const far = Date.now() + 3_600_000;
    t.store.db.prepare('UPDATE source_state SET lease_until_ms = ?, lease_owner = ? WHERE source_id = ?').run(far, '999999:gone', 'remoteok');
    assert.equal((await t.svc.refresh({ ids: ['remoteok'] })).results[0]!.outcome, 'ok', 'dead owner: taken over');
    t.clock.advance(2 * HOUR);
    t.store.db.prepare('UPDATE source_state SET lease_until_ms = ?, lease_owner = ? WHERE source_id = ?').run(far, '1:launchd', 'remoteok');
    assert.equal((await t.svc.refresh({ ids: ['remoteok'] })).results[0]!.skipReason, 'running', 'live owner: respected');
  } finally { await t.done(); }
});
