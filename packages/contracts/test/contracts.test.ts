import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatStreamEventSchema, CompanySchema, EXPERIENCE_LEVELS, FillRequestSchema, FillResponseSchema, JobSchema,
  JobSearchResponseSchema, LOCAL_API, MatchResultSchema, NetworkContactSchema, PairRequestSchema, ProfileSchema,
  PublikWalletSchema, ResumeSchema, ReviewResultSchema, SCHEMAS, TrackerEntrySchema, bandFor, buildPath,
  experienceLevelOf, formatDollars, LEVELS, matchRoute, nowMs, parseDuration, summarizeMatch, validate,
  type JsonSchema, type RouteSpec,
} from '../src/index.ts';
import * as fx from './fixtures.ts';

const pairs: Array<[string, JsonSchema, unknown]> = [
  ['Job', JobSchema, fx.job], ['Profile', ProfileSchema, fx.profile], ['MatchResult', MatchResultSchema, fx.match],
  ['TrackerEntry', TrackerEntrySchema, fx.tracker], ['NetworkContact', NetworkContactSchema, fx.contact],
  ['PublikWallet', PublikWalletSchema, fx.wallet], ['Company', CompanySchema, fx.company], ['Resume', ResumeSchema, fx.resume],
  ['JobSearchResponse', JobSearchResponseSchema, fx.searchResponse], ['PairRequest', PairRequestSchema, fx.pairRequest],
  ['FillRequest', FillRequestSchema, fx.fillRequest], ['FillResponse', FillResponseSchema, fx.fillResponse],
  ['ReviewResult', ReviewResultSchema, fx.reviewResult],
];

test('every typed fixture also validates at run time against its schema', () => {
  for (const [name, schema, value] of pairs) {
    const r = validate(schema, value);
    assert.equal(r.ok, true, `${name}: ${r.ok ? '' : JSON.stringify(r.issues)}`);
  }
  for (const e of fx.chatEvents) assert.equal(validate(ChatStreamEventSchema, e).ok, true);
});

test('Job: unknown facts are null, never defaults; bad links and missing sources are refused', () => {
  const unknown = { ...fx.job, pay: null, workModel: null, places: [], levels: [], level: null, postedAt: null, isUs: null };
  assert.equal(validate(JobSchema, unknown).ok, true);
  assert.equal(validate(JobSchema, { ...fx.job, applyUrl: 'javascript:alert(1)' }).ok, false);
  assert.equal(validate(JobSchema, { ...fx.job, url: 'file:///etc/passwd' }).ok, false);
  assert.equal(validate(JobSchema, { ...fx.job, sources: [] }).ok, false, 'a job always names its source');
  assert.equal(validate(JobSchema, { ...fx.job, workModel: 'Onsite' }).ok, false);
  assert.equal(validate(JobSchema, { ...fx.job, pay: { ...fx.job.pay, period: 'yr' } }).ok, false);
  const r = validate(JobSchema, { ...fx.job, status: 'ghost' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.issues[0]?.path, '/status');
});

test('MatchResult: percent 0 to 100, a known band, a sub-score may be null (not scored) but never out of range', () => {
  assert.equal(validate(MatchResultSchema, { ...fx.match, percent: 140 }).ok, false);
  assert.equal(validate(MatchResultSchema, { ...fx.match, band: 'great' }).ok, false);
  const s = { ...fx.match.subScores, skills: { percent: 101, reasons: [] } };
  assert.equal(validate(MatchResultSchema, { ...fx.match, subScores: s }).ok, false);
  assert.deepEqual(summarizeMatch(fx.match), { percent: 88, band: 'strong', whyFit: fx.match.whyFit.slice(0, 2) });
});

test('bands: STRONG 85 and above, GOOD 70 to 84, FAIR below 70', () => {
  assert.equal(bandFor(100), 'strong');
  assert.equal(bandFor(85), 'strong');
  assert.equal(bandFor(84), 'good');
  assert.equal(bandFor(70), 'good');
  assert.equal(bandFor(69), 'fair');
  assert.equal(bandFor(0), 'fair');
});

test('levels: every fine-grained level maps to one of the six filter buckets', () => {
  for (const l of LEVELS) assert.ok((EXPERIENCE_LEVELS as readonly string[]).includes(experienceLevelOf(l)), l);
  assert.equal(experienceLevelOf('intern'), 'intern_new_grad');
  assert.equal(experienceLevelOf('staff'), 'lead_staff');
  assert.equal(experienceLevelOf('vp'), 'director_exec');
});

test('formatDollars: dollars and cents, floors, never $0.00 while money is left', () => {
  assert.equal(formatDollars(4_970_000), '$4.97');
  assert.equal(formatDollars(4_979_999), '$4.97');
  assert.equal(formatDollars(250_000), '$0.25');
  assert.equal(formatDollars(0), '$0.00');
  assert.equal(formatDollars(4_000), '<$0.01');
  assert.equal(formatDollars(1_234_560_000), '$1,234.56');
  assert.equal(formatDollars(-500_000), '-$0.50');
});

test('clock: JOBLEFT_NOW freezes time, JOBLEFT_CLOCK_OFFSET moves it, bad values throw', () => {
  assert.equal(nowMs({ JOBLEFT_NOW: '2026-10-01T00:00:00Z' }), Date.parse('2026-10-01T00:00:00Z'));
  const ahead = nowMs({ JOBLEFT_CLOCK_OFFSET: '72h' }) - Date.now();
  assert.ok(ahead > 72 * 3600_000 - 5000 && ahead < 72 * 3600_000 + 5000);
  assert.equal(parseDuration('-30m'), -1_800_000);
  assert.equal(parseDuration('3d'), 259_200_000);
  assert.throws(() => parseDuration('soon'));
  assert.throws(() => nowMs({ JOBLEFT_NOW: 'tomorrow' }));
});

test('local API table: unique method+path, launch token everywhere but health and pair, params match paths', () => {
  const seen = new Set<string>();
  for (const [name, r] of Object.entries(LOCAL_API) as Array<[string, RouteSpec]>) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate route ${key}`);
    seen.add(key);
    assert.ok(r.path.startsWith('/api/v1/'), name);
    if (r.auth === 'none') assert.ok(name === 'health' || name === 'pair', `${name} must not be public`);
    if (r.method === 'GET' || r.method === 'DELETE') assert.equal(r.body, undefined, `${name}: ${r.method} has no body`);
    const m = matchRoute(r.method, buildPath(r.path, Object.fromEntries((r.path.match(/:[A-Za-z]+/g) ?? []).map((p) => [p.slice(1), 'x y']))));
    assert.equal(m?.name, name, `matchRoute finds ${name}`);
  }
  for (const r of Object.values(LOCAL_API) as RouteSpec[]) {
    if (r.auth === 'pairing') assert.ok(r.path.startsWith('/api/v1/extension/'), 'pairing tokens only open extension routes');
  }
});

test('matchRoute: literal segments win over params, params are decoded, unknown paths give null', () => {
  assert.deepEqual(matchRoute('POST', '/api/v1/jobs/search'), { name: 'searchJobs', params: {} });
  assert.deepEqual(matchRoute('POST', '/api/v1/jobs/external'), { name: 'addExternalJob', params: {} });
  assert.deepEqual(matchRoute('GET', '/api/v1/jobs/greenhouse%3Aacme%3A1'), { name: 'getJob', params: { jobId: 'greenhouse:acme:1' } });
  assert.deepEqual(matchRoute('GET', '/api/v1/boards/export'), { name: 'exportBoards', params: {} });
  assert.equal(matchRoute('GET', '/api/v1/nothing'), null);
  assert.equal(matchRoute('PUT', '/api/v1/health'), null);
  assert.equal(buildPath('/api/v1/jobs/:jobId', { jobId: 'a/b' }), '/api/v1/jobs/a%2Fb');
  assert.throws(() => buildPath('/api/v1/jobs/:jobId', {}));
});

test('schema registry: every schema has a title and is an object or a union', () => {
  for (const [name, s] of Object.entries(SCHEMAS)) {
    assert.ok(s.title, `${name} has a title`);
    assert.ok(s.type === 'object' || Array.isArray(s.anyOf), `${name} is an object or a union`);
  }
});
