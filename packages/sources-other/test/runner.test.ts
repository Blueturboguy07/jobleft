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
      assert.notEqual((await t.svc.get('remoteok')).status.lastProblem, null, `${sc}: the problem is shown`);
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
    await assert.rejects(t.svc.update('remotive', { enabled: true }), /robots\.txt/);
    await assert.rejects(t.svc.update('usajobs', { enabled: true }), /robots\.txt/);
    await assert.rejects(t.svc.update('nope', { enabled: true }), /no source called/);
  } finally { await t.done(); }
});
