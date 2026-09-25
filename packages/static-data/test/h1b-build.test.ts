// The build pipeline on synthetic LCA files with known counts, and the lookup rules on the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildH1bTable } from '../src/h1b/build.ts';
import { loadH1bIndex } from '../src/h1b/index.ts';
import { buildAliasIndex } from '../src/aliases.ts';
import { writeBundledRecord } from '../src/datasets/store.ts';
import { tempDir, writeXlsx, serial } from './helpers.ts';

const HEADER = ['CASE_NUMBER', 'CASE_STATUS', 'DECISION_DATE', 'VISA_CLASS', 'JOB_TITLE', 'SOC_CODE', 'NEW_EMPLOYMENT', 'CHANGE_EMPLOYER',
  'EMPLOYER_NAME', 'TRADE_NAME_DBA', 'EMPLOYER_CITY', 'EMPLOYER_STATE', 'EMPLOYER_FEIN', 'NAICS_CODE', 'SECONDARY_ENTITY', 'SECONDARY_ENTITY_BUSINESS_NAME'];

type R = [status: string, date: string, visa: string, title: string, soc: string, newEmp: number, name: string, dba: string, city: string, st: string, fein: string, secondary: string, client: string];
let n = 0;
const row = (r: R) => [`I-200-${++n}`, r[0], serial(r[1]), r[2], r[3], r[4], r[5], 0, r[6], r[7], r[8], r[9], r[10], '541511', r[11], r[12]];

async function build() {
  const t = tempDir();
  const q4 = join(t.dir, 'LCA_Disclosure_Data_FY2025_Q4.xlsx');
  const q1 = join(t.dir, 'LCA_Disclosure_Data_FY2026_Q1.xlsx');
  const rows4: R[] = [];
  const rows1: R[] = [];
  // Acme: 12 certified H-1B (4 in FY2025 Q4, 8 in FY2026 Q1), plus rows that must never count.
  for (let i = 0; i < 4; i++) rows4.push(['Certified', '2025-08-15', 'H-1B', 'Software Engineer', '15-1252.00', 1, 'Acme Widgets, Inc.', '', 'Austin', 'TX', '12-3450001', 'No', '']);
  for (let i = 0; i < 8; i++) rows1.push(['Certified', '2025-11-03', 'H-1B', 'Senior Software Engineer', '15-1252.00', i % 2, 'ACME WIDGETS INC', '', 'Austin', 'TX', '12-3450001', 'No', '']);
  rows1.push(['Certified - Withdrawn', '2025-11-04', 'H-1B', 'Engineer', '15-1252.00', 1, 'Acme Widgets, Inc.', '', 'Austin', 'TX', '12-3450001', 'No', '']);
  rows1.push(['Withdrawn', '2025-11-04', 'H-1B', 'Engineer', '15-1252.00', 1, 'Acme Widgets, Inc.', '', 'Austin', 'TX', '12-3450001', 'No', '']);
  rows1.push(['Denied', '2025-11-04', 'H-1B', 'Engineer', '15-1252.00', 1, 'Acme Widgets, Inc.', '', 'Austin', 'TX', '12-3450001', 'No', '']);
  rows1.push(['Certified', '2025-11-04', 'E-3 Australian', 'Engineer', '15-1252.00', 1, 'Acme Widgets, Inc.', '', 'Austin', 'TX', '12-3450001', 'No', '']);
  // A different "Acme Widgets" in another state with another FEIN: 1 filing, never joined.
  rows1.push(['Certified', '2025-12-01', 'H-1B', 'Analyst', '13-1111.00', 1, 'Acme Widgets LLC', '', 'Boise', 'ID', '98-1110001', 'No', '']);
  // A staffing firm placing workers at "Globex Retail" (client site only).
  for (let i = 0; i < 25; i++) rows1.push(['Certified', '2025-12-02', 'H-1B', 'Consultant', '15-1211.00', 1, 'Stafferly Consulting LLC', '', 'Edison', 'NJ', '22-2220002', 'Yes', 'Globex Retail Inc.']);
  // One old, small filer: 2 filings, none recent enough to be "likely".
  rows4.push(['Certified', '2025-07-01', 'H-1B', 'Accountant', '13-2011.00', 1, 'Tinyco LLC', '', 'Reno', 'NV', '33-3330003', 'No', '']);
  rows4.push(['Certified', '2025-07-02', 'H-1B', 'Accountant', '13-2011.00', 1, 'Tinyco LLC', '', 'Reno', 'NV', '33-3330003', 'No', '']);
  // A brand only in TRADE_NAME_DBA.
  for (let i = 0; i < 3; i++) rows1.push(['Certified', '2025-10-10', 'H-1B', 'Designer', '27-1024.00', 1, 'Brightsmith Holdings, Inc.', 'Lumenly', 'Denver', 'CO', '44-4440004', 'No', '']);
  // Two different companies with the same name, similar size: ambiguous.
  for (let i = 0; i < 5; i++) rows1.push(['Certified', '2025-10-11', 'H-1B', 'Engineer', '17-2141.00', 1, 'Twinname Inc', '', 'Dallas', 'TX', '55-5550005', 'No', '']);
  for (let i = 0; i < 4; i++) rows1.push(['Certified', '2025-10-12', 'H-1B', 'Engineer', '17-2141.00', 1, 'TWINNAME, LLC', '', 'Portland', 'ME', '66-6660006', 'No', '']);
  writeXlsx(q4, HEADER, rows4.map(row));
  writeXlsx(q1, HEADER, rows1.map(row));
  const out = join(t.dir, 'dist');
  const r = await buildH1bTable({ files: [q4, q1], outDir: out, builtAt: '2026-01-15T00:00:00.000Z' });
  writeBundledRecord(out, { id: r.meta.id, name: r.meta.name, file: 'h1b-lca.json.gz', sha256: r.sha256, bytes: r.bytes, version: r.meta.version, sequence: r.meta.sequence, dataThrough: r.meta.dataThrough, licence: r.meta.licence, attribution: r.meta.attribution, sourceUrl: r.meta.sourceUrl, builtAt: r.meta.builtAt });
  const aliases = buildAliasIndex({ format: 'jobleft-company-aliases/1', reviewed: 'x', reviewedBy: 'test', entries: [{ group: 'lum', names: ['Lumenly Labs'], filers: ['Brightsmith Holdings, Inc.'], basis: 'test' }] });
  const idx = loadH1bIndex({ dataDir: join(t.dir, 'home'), bundledDir: out, aliases });
  return { t, r, idx };
}

test('only Certified H-1B rows count, per file and per fiscal year; the partial year is marked (O1, O7)', async () => {
  const { t, r, idx } = await build();
  try {
    assert.equal(r.report.caseNumbersInTwoFiles, 0);
    const a = idx.lookup('Acme Widgets');
    assert.equal(a.status, 'found');
    assert.equal(a.summary!.certifiedFilings, 12);
    assert.deepEqual(a.summary!.byYear.map((y) => [y.year, y.count, y.partial, y.yearKind]), [[2025, 4, true, 'fiscal'], [2026, 8, true, 'fiscal']]);
    assert.deepEqual(a.summary!.window, { from: '2025-07-01', to: '2025-12-02' });
    assert.equal(a.summary!.dataThrough, '2025-12-02');
    assert.deepEqual(a.summary!.entities.map((e) => [e.name, e.certifiedFilings]), [['ACME WIDGETS INC', 8], ['Acme Widgets, Inc.', 4]]);
    assert.equal(a.summary!.status, 'likely');
    assert.match(a.summary!.note, /not a promise/);
    assert.doesNotMatch(JSON.stringify(a), /will sponsor|sponsors h-?1b|guaranteed/i);
    // The different Acme in Idaho is left out and named as left out.
    assert.deepEqual(a.summary!.excludedEntities.map((e) => e.name), ['Acme Widgets LLC']);
  } finally { t.done(); }
});

test('a small or thin history is "some history", not "likely" (O1)', async () => {
  const { t, idx } = await build();
  try {
    const s = idx.lookup('Tinyco').summary!;
    assert.equal(s.certifiedFilings, 2);
    assert.equal(s.status, 'some_history');
    assert.equal(s.label, 'Some H-1B history');
  } finally { t.done(); }
});

test('client-site names are never indexed; unknown is never "no" (O2, O6)', async () => {
  const { t, idx } = await build();
  try {
    for (const name of ['Globex Retail', 'Qxlorvane Widgets LLC', 'Acme', 'Acme Widgets Group']) {
      const r = idx.lookup(name);
      assert.equal(r.status, 'unknown', name);
      assert.equal(r.summary, null);
      assert.doesNotMatch(JSON.stringify(r), /\bno h-?1b\b|does not sponsor|non-?sponsor|"status":"no"|:false/i);
    }
    const staff = idx.lookup('Stafferly Consulting').summary!;
    assert.equal(staff.clientSiteShare, 1);
  } finally { t.done(); }
});

test('two similar-size companies with one name are unknown, not merged (O5)', async () => {
  const { t, idx } = await build();
  try {
    const r = idx.lookup('Twinname');
    assert.equal(r.status, 'unknown');
    assert.match(r.reason!, /Several different employers/);
  } finally { t.done(); }
});

test('trade names match, and a reviewed alias maps a brand to its filer (O4)', async () => {
  const { t, idx } = await build();
  try {
    assert.equal(idx.lookup('Lumenly').summary!.matchedBy, 'trade_name');
    assert.equal(idx.lookup('Lumenly').summary!.certifiedFilings, 3);
    assert.equal(idx.lookup('Lumenly Labs').summary!.matchedBy, 'alias');
    assert.equal(idx.lookup('Lumenly Labs').summary!.certifiedFilings, 3);
  } finally { t.done(); }
});

test('the role family share uses the job title (O7)', async () => {
  const { t, idx } = await build();
  try {
    const eng = idx.lookup('Acme Widgets', { jobTitle: 'Staff Software Engineer, Payments' }).summary!;
    assert.equal(eng.roleFamily, 'Computer and Mathematical occupations (SOC 15)');
    assert.equal(eng.similarRoleShare, 1);
    const sales = idx.lookup('Acme Widgets', { jobTitle: 'Account Executive' }).summary!;
    assert.equal(sales.roleFamily, 'Sales and Related occupations (SOC 41)');
    assert.equal(sales.similarRoleShare, 0);
  } finally { t.done(); }
});

test('missing sponsor data makes every company unknown, never "no" (O2)', () => {
  const t = tempDir();
  try {
    const idx = loadH1bIndex({ dataDir: join(t.dir, 'home'), bundledDir: join(t.dir, 'nothing-here'), aliases: buildAliasIndex({ format: 'jobleft-company-aliases/1', reviewed: '', reviewedBy: '', entries: [] }) });
    const r = idx.lookup('Stripe');
    assert.equal(r.status, 'unknown');
    assert.match(idx.dataset().lastUpdateError ?? '', /missing/);
  } finally { t.done(); }
});
