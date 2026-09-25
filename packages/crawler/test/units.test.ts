// Small pure pieces added by the crawler lane: identity rules, places, board lists, hosts, the Job contract mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobSchema, validate } from '@jobleft/contracts';
import { boardFromUrl, parseBoardList } from '../src/boardlist.ts';
import { ConfigError, DEFAULT_USER_AGENT, checkUserAgent, makeConfig, productTokenOf } from '../src/config.ts';
import { ftsQuery, getJobById, jobIdOf } from '../src/contract.ts';
import { forbiddenHostOf, isPrivateAddress } from '../src/hosts.ts';
import { Pacer } from '../src/http.ts';
import { normalizeJob } from '../src/job.ts';
import { parsePlace, splitPlaces, workModelOf } from '../src/places.ts';
import { Store } from '../src/store.ts';
import type { RawJob } from '../src/types.ts';

test('identity: the default names jobleft and its version; browsers, personal mail and other products are refused', () => {
  assert.equal(DEFAULT_USER_AGENT, 'jobleft/0.1 (contact: TBD)');
  assert.equal(makeConfig().userAgent, DEFAULT_USER_AGENT);
  assert.equal(checkUserAgent('jobleft/0.2 (contact: https://jobleft.example/bot)'), 'jobleft/0.2 (contact: https://jobleft.example/bot)');
  assert.equal(productTokenOf('jobleft-build/0.1 (research build; no personal data)'), 'jobleft-build');
  for (const bad of ['', 'Mozilla/5.0 jobleft/0.1', 'jobleft/0.1 (Macintosh; AppleWebKit)', 'jobleft/0.1 (mail: me@gmail.com)', 'Googlebot/2.1', 'jobleft']) {
    assert.throws(() => checkUserAgent(bad), ConfigError, bad);
  }
  assert.throws(() => makeConfig({ minHostIntervalSeconds: 0.5 }), ConfigError, 'never faster than one request a second');
  assert.throws(() => makeConfig({ refreshHour: 3 } as never), /unknown crawler setting/);
});

test('places: every place is kept in its own words; parts are filled only when plainly stated', () => {
  assert.deepEqual(splitPlaces('Austin, TX; Denver, CO | Remote - US'), ['Austin, TX', 'Denver, CO', 'Remote - US']);
  assert.deepEqual(parsePlace('Austin, TX'), { text: 'Austin, TX', city: 'Austin', region: 'TX', country: 'US', placeId: null });
  assert.deepEqual(parsePlace('Toronto, ON, Canada'), { text: 'Toronto, ON, Canada', city: 'Toronto', region: 'ON', country: 'CA', placeId: null });
  assert.deepEqual(parsePlace('Berlin, Germany'), { text: 'Berlin, Germany', city: 'Berlin', region: null, country: 'DE', placeId: null });
  assert.deepEqual(parsePlace('Hybrid - New York, NY'), { text: 'Hybrid - New York, NY', city: 'New York', region: 'NY', country: 'US', placeId: null });
  assert.deepEqual(parsePlace('Remote'), { text: 'Remote', city: null, region: null, country: null, placeId: null });
  assert.equal(parsePlace('Remote - US').country, 'US');
  assert.deepEqual(parsePlace('Springfield'), { text: 'Springfield', city: null, region: null, country: null, placeId: null });
  assert.equal(workModelOf('', ['Austin, TX']).workModel, null, 'a city says nothing about the work model');
  assert.equal(workModelOf('', ['Remote (US only)']).remoteScope?.regions.includes('US'), true);
  assert.equal(workModelOf('hybrid', ['Austin, TX']).workModel, 'hybrid');
});

test('greenhouse offices: used only when the location is empty or generic, and only when they read as places', async () => {
  const { mapGreenhouse } = await import('../src/sources/greenhouse.ts');
  const j = mapGreenhouse({ id: 1, title: 'Teacher', absolute_url: 'https://x.example/1', location: { name: 'Multiple Locations' },
    offices: [{ name: '2026-2027 Openings' }, { name: 'Denver', location: 'Denver, CO, United States' }, { name: 'Brooke Charter Schools' }] },
    { ats: 'greenhouse', board: 'b', company: 'B' })!;
  assert.deepEqual(j.places, ['Denver, CO, United States']);
  const k = mapGreenhouse({ id: 2, title: 'Teacher', absolute_url: 'https://x.example/2', location: { name: 'Boston, MA' }, offices: [{ name: 'Immediate Openings' }] },
    { ats: 'greenhouse', board: 'b', company: 'B' })!;
  assert.deepEqual(k.places, ['Boston, MA']);
});

test('board lists: links are recognised without a request; the same board twice is kept once; bad entries say why', () => {
  assert.deepEqual(boardFromUrl('https://job-boards.greenhouse.io/acme/jobs/4001'), { ats: 'greenhouse', board: 'acme' });
  assert.deepEqual(boardFromUrl('https://jobs.eu.lever.co/beta/abc'), { ats: 'lever', board: 'beta', region: 'eu' });
  assert.deepEqual(boardFromUrl('https://jobs.ashbyhq.com/gamma/uuid'), { ats: 'ashby', board: 'gamma' });
  assert.match((boardFromUrl('https://careers.acme.example/jobs?gh_jid=12') as { reason: string }).reason, /Greenhouse board name/);
  const l = parseBoardList(JSON.stringify({ boards: [
    { ats: 'greenhouse', board: 'acme', company: 'Acme' }, { ats: 'greenhouse', board: 'ACME' }, { ats: 'lever', board: '../etc' },
    { ats: 'greenhouse', board: 'x', origin: 'http://192.168.1.10:80' }, { ats: 'workable', board: 'w' }, 'nope',
  ] }));
  assert.deepEqual(l.boards.map((b) => `${b.ats}:${b.board}`), ['greenhouse:acme', 'workable:w']);
  assert.equal(l.duplicates, 1);
  assert.equal(l.skipped.length, 3);
  assert.throws(() => parseBoardList('{'), /not valid JSON/);
});

test('hosts: never-crawl and held-back families, and local addresses', () => {
  assert.equal(forbiddenHostOf('uk.indeed.com')?.kind, 'never');
  assert.equal(forbiddenHostOf('www.glassdoor.co.uk')?.family, 'Glassdoor');
  assert.equal(forbiddenHostOf('nvidia.wd5.myworkdayjobs.com')?.kind, 'held_back');
  assert.equal(forbiddenHostOf('nvidia.wd5.myworkdayjobs.com', ['workday']), null, 'the owner can turn a held-back family on');
  assert.equal(forbiddenHostOf('boards-api.greenhouse.io'), null);
  for (const a of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.1.2.3', '100.64.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '104.18.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
});

test('pacer: the margin keeps the spacing above the interval as the host sees it', async () => {
  const clock = { t: 0 };
  const p = new Pacer(1000, () => clock.t, async (ms) => { clock.t += ms; });
  const starts: number[] = [];
  for (let i = 0; i < 3; i++) { await p.wait('h'); starts.push(clock.t); }
  assert.deepEqual(starts, [0, 1100, 2200]);
  p.blockUntil('h', 10_000);
  await p.wait('h');
  assert.equal(clock.t, 10_000, 'a host that asked to wait gets nothing before that time');
});

test('contract mapping: a crawl row becomes a valid Job with its source, and an unknown id is null', () => {
  const s = new Store(':memory:');
  const raw: RawJob = {
    externalId: 'a1', url: 'https://jobs.lever.co/acme/a1', applyUrl: 'javascript:alert(1)', title: 'Pharmacist', company: 'Acme',
    location: 'Tulsa, OK', descriptionHtml: '<p>Fill prescriptions.</p>', remote: false, workMode: '', countries: [], postedAt: null,
    employmentType: 'part_time', department: '', pay: { min: 60, max: 70, currency: 'USD', period: 'hour' }, payRanges: 1, payEvidence: 'salaryRange',
  };
  const j = normalizeJob({ ats: 'lever', board: 'acme', company: 'Acme' }, raw)!;
  s.upsertJob(j, '2026-09-01T00:00:00.000Z');
  const c = getJobById(s.db, jobIdOf('lever', 'Acme', 'a1'))!;
  const v = validate(JobSchema, c);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(c.applyUrl, null, 'a javascript: apply link is dropped');
  assert.equal(c.employmentType, 'part_time');
  assert.equal(c.sources[0]!.name, 'Acme careers (Lever)');
  assert.equal(getJobById(s.db, 'lever:acme:nope'), null);
  assert.equal(ftsQuery('C++ "senior" OR -x'), '"C++" "senior" "OR" "-x"', 'user words are never FTS syntax');
});
