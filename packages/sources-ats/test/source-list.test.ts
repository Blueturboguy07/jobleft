import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRAWL_ATS_IDS, validate, SourceInfoSchema } from '@jobleft/contracts';
import { ATS_SOURCES, allSources } from '../src/registry.ts';
import { ATS_SOURCE_DETAILS, ATS_SOURCE_LIST } from '../src/source-list.ts';
import { HERE } from './helpers.ts';

const REPO = join(HERE, '..', '..', '..');

test('every adapter the crawler can run is "crawled" in the list, with public-feed evidence (O2)', () => {
  const registry = allSources();
  for (const ats of Object.keys(registry)) {
    const e = ATS_SOURCE_DETAILS.find((d) => d.ats === ats);
    assert.ok(e, `adapter ${ats} has no source list entry`);
    assert.equal(e.crawled, true, ats);
    assert.match(e.evidenceUrl ?? '', /^https:\/\//, ats);
    assert.ok(e.quote.length > 20, ats);
  }
  for (const ats of ['workable', 'recruitee', 'personio', 'greenhouse', 'lever', 'ashby']) assert.ok(registry[ats as never], ats);
  assert.deepEqual(Object.keys(ATS_SOURCES).sort(), ['gem', 'personio', 'recruitee', 'teamtailor', 'workable']);
});

test('the families jobleft must never crawl are listed as not crawled, with a reason and a date (O2)', () => {
  const must = ['SmartRecruiters', 'Workday', 'iCIMS', 'Oracle Recruiting', 'UKG', 'Taleo', 'LinkedIn', 'Indeed', 'Glassdoor',
    'BambooHR', 'Breezy HR', 'JazzHR', 'Rippling'];
  for (const name of must) {
    const e = ATS_SOURCE_DETAILS.find((d) => d.name === name);
    assert.ok(e, `${name} missing`);
    assert.equal(e.crawled, false, name);
    assert.ok((e.reason ?? '').length > 30, `${name} reason is vague`);
    assert.match(e.checkedOn, /^2026-09-2[45]$/);
    assert.ok(!allSources()[e.ats as never], `${name} is "not crawled" but has an adapter`);
  }
});

test('host restrictions the plan records are in the list (ai-train=no, crawl delay, token deadline)', () => {
  const get = (id: string) => ATS_SOURCE_DETAILS.find((d) => d.id === id)!;
  assert.match(get('ats:workable').limits ?? '', /ai-train=no/);
  assert.match(get('ats:teamtailor').limits ?? '', /ai-train=no/);
  assert.match(get('ats:lever').limits ?? '', /Crawl-delay: 1/);
  assert.match(get('ats:recruitee').limits ?? '', /10 February 2027/);
});

test('every entry is a valid SourceInfo once the server adds its status, and ids are unique', () => {
  const ids = new Set<string>();
  for (const e of ATS_SOURCE_LIST) {
    assert.ok(!ids.has(e.id), `duplicate ${e.id}`);
    ids.add(e.id);
    const full = { ...e, enabled: e.crawled, keySet: false, status: { state: 'never_run', lastSuccessAt: null, openJobs: null, lastProblem: null, nextAllowedAt: null } };
    const v = validate(SourceInfoSchema, full);
    assert.ok(v.ok, `${e.id}: ${JSON.stringify(!v.ok && v.issues)}`);
  }
  for (const ats of CRAWL_ATS_IDS) assert.ok(ids.has(`ats:${ats}`), `contract family ${ats} missing from the list`);
});

test('every entry points at a docs/sources note that exists and states the same decision', () => {
  for (const e of ATS_SOURCE_DETAILS) {
    const p = join(REPO, e.docsFile);
    assert.ok(existsSync(p), `${e.docsFile} missing`);
    const text = readFileSync(p, 'utf8');
    assert.ok(text.includes(e.name), `${e.docsFile} does not name ${e.name}`);
    if (e.docsFile !== 'docs/sources/not-crawled.md' && e.docsFile !== 'docs/sources/never-crawled-sites.md') {
      assert.match(text, e.crawled ? /Decision: \*\*crawled\*\*/ : /Decision: \*\*not crawled\*\*/, e.docsFile);
    }
  }
});
