// End to end: stand-in boards on 127.0.0.1 -> the crawler's HttpClient and crawl() -> SQLite. Nothing live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { USER_AGENT } from '@jobleft/crawler';
import { crawlStandin, rows, STANDIN, tmp } from './helpers.ts';

interface Row {
  ats: string; board: string; job_id: string; title: string; company: string; location: string; remote: number;
  work_mode: string; pay_min: number | null; pay_max: number | null; pay_currency: string | null; pay_period: string | null;
  pay_source: string | null; posted_at: string | null; employment_type: string; department: string; description: string;
  canonical_url: string; apply_url: string; first_seen: string; closed_at: string | null;
}

test('every supported ATS gives the same kind of job from its stand-in board', async () => {
  const t = tmp();
  const run = await crawlStandin(STANDIN, join(t.dir, 'jobs.db'));
  try {
    assert.equal(run.report.boards.length, 5);
    for (const b of run.report.boards) assert.equal(b.status, 'ok', `${b.ats}: ${b.error}`);
    const all = rows<Row>(run.store, 'SELECT * FROM jobs ORDER BY ats, job_id');
    assert.equal(all.length, 15);
    const j = Object.fromEntries(all.map((r) => [`${r.ats}:${r.job_id}`, r]));

    // Workable
    assert.equal(j['workable:NWD0000001'].title, 'Senior Backend Engineer');
    assert.equal(j['workable:NWD0000001'].company, 'Northwind Demo Labs');
    assert.equal(j['workable:NWD0000001'].location, 'Austin, Texas, United States');
    assert.equal(j['workable:NWD0000001'].posted_at, '2026-09-01T12:00:00.000Z');
    assert.equal(j['workable:NWD0000001'].pay_min, 120000); // read from the text, in dollars
    assert.equal(j['workable:NWD0000001'].pay_source, 'text');
    assert.equal(j['workable:NWD0000003'].title, 'R&D Technician');
    assert.equal(j['workable:NWD0000003'].location, 'Zürich, Switzerland');
    assert.equal(j['workable:NWD0000003'].work_mode, 'hybrid');
    assert.equal(j['workable:NWD0000003'].employment_type, 'part_time');

    // Recruitee: structured pay in plain units (not cents)
    const wl = j['recruitee:900001'];
    assert.deepEqual([wl.pay_min, wl.pay_max, wl.pay_currency, wl.pay_period, wl.pay_source], [4000, 5000, 'BRL', 'month', 'api']);
    assert.equal(wl.location, 'São Paulo, Brazil');
    assert.equal(wl.company, 'Zephyr Demo GmbH');
    assert.equal(wl.posted_at, '2026-09-02T09:30:00.000Z');
    assert.equal(j['recruitee:900003'].title, 'ソフトウェアエンジニア');
    assert.match(j['recruitee:900003'].description, /東京のチームで働きます。\n\n- TypeScript/);

    // Personio: sections kept under their own headings, subcompany as employer, .de host
    const pe = j['personio:5000001'];
    assert.equal(pe.company, 'Acme Demo GmbH');
    assert.equal(pe.location, 'Zürich; München');
    assert.equal(pe.posted_at, '2026-09-05T08:15:00.000Z');
    assert.match(pe.description, /^Your role & team\n\nBuild our API & data platform\.\n\n- Go\n- Postgres/);
    assert.equal(pe.canonical_url, 'https://acme-demo.jobs.personio.de/job/5000001');
    assert.equal(j['personio:5000003'].employment_type, 'internship');
    assert.equal(j['personio:5000003'].description, 'About the role\n\nSell to retail chains.');

    // Teamtailor
    const tt = j['teamtailor:4100001'];
    assert.equal(tt.company, 'Acme Demo Retail');
    assert.equal(tt.work_mode, 'onsite');
    assert.equal(tt.posted_at, '2026-09-15T06:30:00.000Z');
    assert.match(tt.description, /- Own the P&L/);
    assert.equal(j['teamtailor:4100002'].work_mode, 'remote');
    assert.equal(j['teamtailor:4100003'].title, 'Barista – Göteborg');

    // Gem
    assert.equal(j['gem:7000000002'].location, 'Denver, Colorado, United States');
    assert.deepEqual([j['gem:7000000002'].pay_min, j['gem:7000000002'].pay_max, j['gem:7000000002'].pay_period], [22, 26, 'hour']);
    assert.equal(j['gem:7000000003'].location, 'Montréal, Québec, Canada');
    assert.equal(j['gem:7000000003'].description, 'Care for patients.\nNight shifts <3 per week.');

    // Every job links to its own posting on the ATS host, with its own id (O14)
    for (const r of all) {
      const host = new URL(r.canonical_url).host;
      const want = { workable: 'apply.workable.com', recruitee: 'zephyr-demo.recruitee.com', personio: 'acme-demo.jobs.personio.de',
        teamtailor: 'acme-demo.teamtailor.com', gem: 'jobs.gem.com' }[r.ats];
      assert.equal(host, want, r.canonical_url);
      assert.ok(r.canonical_url.includes(r.job_id.replace(/^9000+/, '')) || r.ats === 'recruitee', `${r.canonical_url} lacks ${r.job_id}`);
    }
  } finally {
    await run.standin.close(); run.store.close(); t.done();
  }
});

test('a missing fact stays missing: no invented pay, date, place or work model (O6)', async () => {
  const t = tmp();
  const run = await crawlStandin(STANDIN, join(t.dir, 'jobs.db'));
  try {
    const j = Object.fromEntries(rows<Row>(run.store, 'SELECT * FROM jobs').map((r) => [`${r.ats}:${r.job_id}`, r]));
    for (const id of ['workable:NWD0000002', 'recruitee:900002', 'teamtailor:4100002', 'gem:7000000002', 'personio:5000002']) {
      assert.equal(j[id].posted_at, null, `${id} got a posted date`);
    }
    for (const r of Object.values(j)) assert.notEqual(r.posted_at, r.first_seen, `${r.ats}:${r.job_id} uses the crawl time`);
    for (const id of ['workable:NWD0000002', 'recruitee:900002', 'teamtailor:4100002', 'personio:5000002']) {
      assert.equal(j[id].location, '', `${id} got a place`);
    }
    // No place and no remote statement: not remote, no work model
    assert.equal(j['workable:NWD0000002'].remote, 0);
    assert.equal(j['workable:NWD0000002'].work_mode, '');
    assert.equal(j['personio:5000002'].work_mode, '');
    for (const id of ['recruitee:900002', 'recruitee:900003', 'gem:7000000001', 'teamtailor:4100002', 'personio:5000002']) {
      assert.equal(j[id].pay_min, null, `${id} got pay`);
      assert.equal(j[id].pay_max, null, `${id} got pay`);
    }
  } finally {
    await run.standin.close(); run.store.close(); t.done();
  }
});

test('markup from a board never survives as markup, links stay http(s), text is clean (O9, O12)', async () => {
  const t = tmp();
  const run = await crawlStandin(STANDIN, join(t.dir, 'jobs.db'));
  try {
    const all = rows<Row>(run.store, 'SELECT * FROM jobs');
    for (const r of all) {
      for (const field of [r.title, r.company, r.location, r.department, r.description]) {
        for (const bad of ['<p>', '<script', '<iframe', '<img', 'onerror', 'javascript:', '127.0.0.1:9', '&amp;', '&lt;', '&gt;', 'CDATA']) {
          assert.ok(!field.includes(bad), `${r.ats}:${r.job_id} holds ${bad}: ${field.slice(0, 80)}`);
        }
      }
      assert.match(r.apply_url, /^https:\/\//, `${r.ats}:${r.job_id} apply url ${r.apply_url}`);
    }
    const nurse = all.find((r) => r.job_id === 'NWD0000002')!;
    assert.equal(nurse.title, 'Night Shift Nurse');
    assert.equal(nurse.description, 'Build things.\n\nApply here');
    // The javascript: apply link was refused; the posting link is used instead.
    assert.equal(nurse.apply_url, 'https://apply.workable.com/northwind-demo/j/NWD0000002/');
    // The stand-in "logging host" 127.0.0.1:9 got nothing: no request ever left for it.
    assert.ok(!run.standin.requests.some((q) => q.port === 9));
  } finally {
    await run.standin.close(); run.store.close(); t.done();
  }
});

test('requests carry only the product User-Agent and go only to the boards (O7, O8)', async () => {
  const t = tmp();
  const run = await crawlStandin(STANDIN, join(t.dir, 'jobs.db'));
  try {
    const reqs = run.standin.requests;
    assert.equal(reqs.length, 10); // robots.txt + one feed request per board
    for (const q of reqs) {
      assert.equal(q.headers['user-agent'], USER_AGENT);
      assert.equal(q.headers.from, undefined);
      assert.equal(q.headers.cookie, undefined);
      assert.equal(q.headers.authorization, undefined);
      assert.ok(!/@|jordan|testwell/i.test(JSON.stringify(q.headers) + q.path), JSON.stringify(q));
    }
    assert.deepEqual([...new Set(reqs.map((q) => q.host))].sort(), [
      'acme-demo.jobs.personio.de', 'acme-demo.teamtailor.com', 'api.gem.com', 'apply.workable.com', 'zephyr-demo.recruitee.com',
    ]);
  } finally {
    await run.standin.close(); run.store.close(); t.done();
  }
});

test('a second crawl adds no copies (O10)', async () => {
  const t = tmp();
  const db = join(t.dir, 'jobs.db');
  const first = await crawlStandin(STANDIN, db);
  try {
    const second = await crawlStandin(STANDIN, db, undefined, { store: first.store, standin: first.standin });
    assert.equal(rows(first.store, 'SELECT id FROM jobs').length, 15);
    for (const b of second.report.boards) assert.equal(b.stats.inserted, 0);
  } finally {
    await first.standin.close(); first.store.close(); t.done();
  }
});
