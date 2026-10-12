// Saved web searches: when they run, what counts as new, and the one alert per run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MAX_SAVED, WebSavedSearches } from '../src/interim/websaved.ts';
import type { WebReader } from '../src/interim/webreader.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE srv_web_results (url TEXT PRIMARY KEY, state TEXT NOT NULL, job_id TEXT, message TEXT, query TEXT, found_at TEXT NOT NULL, read_at TEXT)');
  db.exec('CREATE TABLE jobs (ats TEXT, board TEXT, job_id TEXT, posted_at TEXT)');
  // Job 2 states a date in the past week; job 4 was posted years ago (an engine found the page again), so it is not new.
  db.exec("INSERT INTO jobs VALUES ('external', 'web', '2', '2026-10-08T12:00:00.000Z'), ('external', 'web', '4', '2022-06-14T12:00:00.000Z')");
  let now = Date.parse('2026-10-10T12:00:00Z');
  const reading = { running: false, queued: 0 };
  const searches: Array<{ q: string; place?: string; tag: string }> = [];
  const alerts: string[] = [];
  let alertsOn = true;
  let fail: string | null = null;
  const saved = new WebSavedSearches({
    db,
    reader: { status: () => ({ ...reading, read: 0, added: 0, closed: 0, failed: 0, jobs: 0 }) } as unknown as WebReader,
    search: async (req, tag) => {
      if (fail) throw new Error(fail);
      searches.push({ q: req.q, ...(req.place ? { place: req.place } : {}), tag });
      // The run's job pages are read later: two new jobs, one the person already had and one posted years ago.
      const at = new Date(now + 60_000).toISOString();
      db.prepare("INSERT INTO srv_web_results VALUES (?, 'job', 'external:web:1', NULL, ?, ?, ?)").run(`https://a.example/${searches.length}/1`, tag, at, at);
      db.prepare("INSERT INTO srv_web_results VALUES (?, 'job', 'external:web:2', NULL, ?, ?, ?)").run(`https://a.example/${searches.length}/2`, tag, at, at);
      db.prepare("INSERT INTO srv_web_results VALUES (?, 'known', 'greenhouse:acme:3', NULL, ?, ?, ?)").run(`https://a.example/${searches.length}/3`, tag, at, at);
      db.prepare("INSERT INTO srv_web_results VALUES (?, 'job', 'external:web:4', NULL, ?, ?, ?)").run(`https://a.example/${searches.length}/4`, tag, at, at);
    },
    ready: () => true,
    alertsOn: () => alertsOn,
    notify: (title) => { alerts.push(title); },
    now: () => now,
  });
  return { db, saved, searches, alerts, reading, tick: async (ms = 0) => { now += ms; await saved.tick(); }, setAlerts: (v: boolean) => { alertsOn = v; }, setFail: (v: string | null) => { fail = v; } };
}

test('a saved web search: its first run is one interval after saving, and only new jobs are counted and alerted (not old postings)', async () => {
  const t = setup();
  const s = t.saved.add({ q: '  SOC   analyst ', place: 'Utrecht', everyHours: 12 });
  assert.equal(s.q, 'SOC analyst');
  await t.tick(3600_000);
  assert.equal(t.searches.length, 0, 'not due yet: the person just saw these results');
  await t.tick(11 * 3600_000);
  assert.equal(t.searches.length, 1);
  assert.equal(t.searches[0]!.tag, `saved:${s.id}`);
  // While the reader works, nothing is counted.
  t.reading.queued = 3;
  await t.tick(5 * 60_000);
  assert.equal(t.alerts.length, 0);
  t.reading.queued = 0;
  await t.tick(5 * 60_000);
  assert.deepEqual(t.alerts, ['2 new web jobs for "SOC analyst, Utrecht"']);
  assert.equal(t.saved.list()[0]!.lastNew, 2);
  // Not due again until 12 hours after the run.
  await t.tick(3600_000);
  assert.equal(t.searches.length, 1);
});

test('saved web searches: duplicates, the limit, off, alerts off and a failed run', async () => {
  const t = setup();
  t.saved.add({ q: 'SOC analyst' });
  assert.throws(() => t.saved.add({ q: 'soc ANALYST' }), /saved already/);
  for (let i = 1; i < MAX_SAVED; i++) t.saved.add({ q: `search ${i}`, everyHours: 0 });
  assert.throws(() => t.saved.add({ q: 'one more' }), /up to 10/);
  assert.throws(() => t.saved.update(t.saved.list()[0]!.id, 6), /12 or 24/);
  const first = t.saved.list()[0]!;
  // Only the first one runs by itself (the others are "only by hand").
  t.setAlerts(false);
  await t.tick(25 * 3600_000);
  await t.tick(60_000);
  assert.equal(t.searches.length, 1);
  assert.equal(t.alerts.length, 0, 'alerts are off');
  t.setFail('Nothing answered at http://127.0.0.1:8888.');
  await t.tick(25 * 3600_000);
  assert.match(t.saved.list()[0]!.lastError ?? '', /Nothing answered/);
  t.saved.remove(first.id);
  assert.equal(t.saved.list().length, MAX_SAVED - 1);
});

test('saved web search routes: save, list, change how often, delete', async () => {
  const { startTest, cleanup } = await import('./helpers.ts');
  const s = await startTest('websaved-routes');
  try {
    const a = await s.call('POST', '/api/v1/websearch/saved', { q: 'SOC analyst', place: 'Utrecht', everyHours: 24 });
    assert.equal(a.status, 200, a.text);
    assert.equal((await s.call('POST', '/api/v1/websearch/saved', { q: 'soc analyst', place: 'utrecht' })).status, 409);
    assert.equal((await s.call('GET', '/api/v1/websearch/saved')).json.length, 1);
    const p = await s.call('PATCH', `/api/v1/websearch/saved/${a.json.id}`, { everyHours: 12 });
    assert.equal(p.json.everyHours, 12);
    assert.equal((await s.call('PATCH', `/api/v1/websearch/saved/${a.json.id}`, { everyHours: 5 })).status, 400);
    assert.equal((await s.call('DELETE', `/api/v1/websearch/saved/${a.json.id}`)).status, 200);
    assert.equal((await s.call('GET', '/api/v1/websearch/saved')).json.length, 0);
    assert.equal((await s.call('DELETE', `/api/v1/websearch/saved/${a.json.id}`)).status, 404);
  } finally { await s.stop(); cleanup(s.home); }
});

test('a web job belongs to a search only when it mentions every search word', async () => {
  const { mentionsAll, searchWords } = await import('../src/interim/webreader.ts');
  const soc = searchWords('SOC analyst');
  assert.deepEqual(soc, ['soc', 'analyst']);
  assert.equal(mentionsAll('SOC-analist bij Gemeente Utrecht', soc), true, 'the Dutch spelling counts');
  assert.equal(mentionsAll('Security Operations (SOC) Analyst', soc), true);
  assert.equal(mentionsAll('Senior Data Analyst', soc), false);
  assert.equal(mentionsAll('Social media analyst', soc), false, 'a short word counts only as a whole word');
  assert.equal(mentionsAll('Junior Cybersecurity Engineer', searchWords('junior cyber security')), true);
  assert.deepEqual(searchWords('junior security analyst'), ['security', 'analyst'], 'a level word is not required');
  assert.deepEqual(searchWords('junior'), ['junior'], 'unless it is the only word');
  assert.equal(mentionsAll('Medewerker IT-beveiliging', searchWords('IT beveiliging')), true);
  assert.deepEqual(searchWords('vacature voor de SOC'), ['soc']);
});
