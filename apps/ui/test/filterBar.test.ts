// JL-feed-1: an Apply in one filter-bar popover must keep every filter set in the other popovers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobFilter } from '@jobleft/contracts';
import { applySection, resetSection, sameFilter } from '../src/lib/filters.ts';

test('an Apply keeps the filters of the other popovers, even from a draft copied from an older filter', () => {
  // The person has United States and Entry Level; the Job type popover still holds a draft made before either was set.
  const current: JobFilter = { countries: ['US'], levels: ['entry'] };
  const staleDraft: JobFilter = { employmentTypes: ['full_time'] };
  const next = applySection(current, staleDraft, 'type');
  assert.ok(sameFilter(next, { countries: ['US'], levels: ['entry'], employmentTypes: ['full_time'] }), JSON.stringify(next));
  // Then Work model, Date posted, Years and Pay, each from a draft that knows nothing of the others.
  let f = next;
  f = applySection(f, { workModels: ['remote'] }, 'model');
  f = applySection(f, { postedWithin: '7d' }, 'posted');
  f = applySection(f, { maxYearsRequired: 3 }, 'years');
  f = applySection(f, { minAnnualPayUsd: 80000 }, 'pay');
  assert.ok(sameFilter(f, {
    countries: ['US'], levels: ['entry'], employmentTypes: ['full_time'], workModels: ['remote'], postedWithin: '7d', maxYearsRequired: 3, minAnnualPayUsd: 80000,
  }), JSON.stringify(f));
});

test('an Apply changes and clears only its own fields and its own "include unknown" boxes', () => {
  const current: JobFilter = { countries: ['US'], levels: ['entry', 'mid'], includeUnknown: ['place', 'level'] };
  // The level popover: Mid unticked, "include jobs with no level" unticked.
  const f = applySection(current, { ...current, levels: ['entry'], includeUnknown: ['place'] }, 'level');
  assert.ok(sameFilter(f, { countries: ['US'], levels: ['entry'], includeUnknown: ['place'] }), JSON.stringify(f));
  // Location set to "Any country" (no countries) with a stale draft: the level stays.
  const g = applySection(f, { levels: ['senior'] }, 'location');
  assert.ok(sameFilter(g, { levels: ['entry'] }), JSON.stringify(g));
  // Reset of one popover leaves the others.
  assert.ok(sameFilter(resetSection({ countries: ['US'], postedWithin: '24h', includeUnknown: ['postedAt', 'place'] }, 'posted'), { countries: ['US'], includeUnknown: ['place'] }));
});

test('JL-feed-7: filters on facts no job has (industry, company stage, staffing agency) are named and can be removed', async () => {
  const { noDataFilters, withoutNoDataFilters } = await import('../src/lib/filters.ts');
  const f: JobFilter = { countries: ['US'], industries: ['Health Care'], companyStages: ['public'], excludeStaffingAgencies: true };
  assert.deepEqual(noDataFilters(f), ['industry', 'company stage', 'staffing agencies']);
  assert.ok(sameFilter(withoutNoDataFilters(f), { countries: ['US'] }));
  assert.deepEqual(noDataFilters({ countries: ['US'] }), []);
});

test('JL-feed-5: towns with the same name read apart in the place list', async () => {
  const { placeLabel } = await import('../src/lib/filters.ts');
  assert.equal(placeLabel({ text: 'Austin', city: 'Austin', region: 'TX', country: 'US' }), 'Austin, TX');
  assert.equal(placeLabel({ text: 'Austin', city: 'Austin', region: 'MN', country: 'US' }), 'Austin, MN');
  assert.equal(placeLabel({ text: 'Portland', city: 'Portland', region: 'Victoria', country: 'AU' }), 'Portland, Victoria, Australia');
  assert.equal(placeLabel({ text: 'Toronto', city: null, region: null, country: null }), 'Toronto');
});

test('JL-feed-25: the pay filter says that the top of a stated range counts', async () => {
  const { PAY_FILTER_NOTE } = await import('../src/lib/filters.ts');
  assert.match(PAY_FILTER_NOTE, /top of its stated pay range/);
});

test('JL-onboarding-28: the starting filters keep the jobs that do not state a fact they filter on', async () => {
  const { filterFromProfile, unstatedLeftOut } = await import('../src/lib/filters.ts');
  const preferences = {
    jobFunctions: ['Software Engineering'], targetTitles: [], employmentTypes: ['full_time' as const], workModels: ['remote' as const],
    levels: ['entry' as const], countries: ['US'], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [],
  };
  const f = filterFromProfile({ preferences } as never);
  assert.deepEqual(f.employmentTypes, ['full_time']);
  assert.deepEqual(new Set(f.includeUnknown), new Set(['employmentType', 'workModel', 'level', 'place']));
  assert.deepEqual(unstatedLeftOut(f), [], 'no hidden strictness in the starting filters');
  // only the facts the person chose: no job type chosen, no "include jobs with no job type" either
  const g = filterFromProfile({ preferences: { ...preferences, employmentTypes: [], levels: [], countries: [] } } as never);
  assert.deepEqual(g.includeUnknown, ['workModel']);
  assert.deepEqual(filterFromProfile({ preferences: { ...preferences, employmentTypes: [], workModels: [], levels: [], countries: [] } } as never), { jobFunctions: ['Software Engineering'] });
});

test('JL-onboarding-28: the empty feed names the filters that are on and offers the jobs that do not state them', async () => {
  const { emptyFeedText, withAllUnknown } = await import('../src/lib/filters.ts');
  const strict: JobFilter = { jobFunctions: ['Software Engineering'], employmentTypes: ['full_time'], workModels: ['remote'] };
  const e = emptyFeedText(strict, '');
  assert.match(e.text, /these filters: Software Engineering, Full-time, Remote\./);
  assert.match(e.text, /leave out every job that does not state its job type or work model\./);
  assert.deepEqual(e.leftOut, ['employmentType', 'workModel']);
  const open = withAllUnknown(strict);
  assert.deepEqual(open.includeUnknown, ['employmentType', 'workModel']);
  assert.deepEqual(emptyFeedText(open, '').leftOut, []);
  assert.doesNotMatch(emptyFeedText(open, '').text, /leave out every job/);
  assert.equal(emptyFeedText({}, 'rust').text, 'Nothing matches “rust”.');
});
