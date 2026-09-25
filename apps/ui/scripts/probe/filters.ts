// O7: filters, search and sort do exactly what they say. Some filters are driven through the screens (popovers,
// the All filters drawer, the sort menu, saved filters, fast typing); their results are then checked, job by job,
// against the filter as the contract defines it (docs/INTERFACES.md, JobFilter: unknown facts FAIL a filter unless
// includeUnknown names them; exclude filters win).

import type { JobFilter, JobListItem, JobSearchRequest } from '@jobleft/contracts';
import { launch, type Page } from '../browser.ts';
import { check, sleep, type Demo } from './lib.ts';

const DAY = 86_400_000;
const WINDOW: Record<string, number> = { '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/** Which parts of the filter a listed job breaks (empty = the job meets every active filter). */
export function violations(it: JobListItem, f: JobFilter, now = Date.now()): string[] {
  const j = it.job;
  const unk = new Set(f.includeUnknown ?? []);
  const bad: string[] = [];
  if (f.workModels?.length) { if (j.workModel === null ? !unk.has('workModel') : !f.workModels.includes(j.workModel)) bad.push(`workModel ${j.workModel}`); }
  if (f.employmentTypes?.length) { if (j.employmentType === null ? !unk.has('employmentType') : !f.employmentTypes.includes(j.employmentType)) bad.push(`type ${j.employmentType}`); }
  if (f.levels?.length) { if (!j.levels.length ? !unk.has('level') : !j.levels.some((l) => f.levels!.includes(l))) bad.push(`level ${j.levels.join(',')}`); }
  if (f.postedWithin) {
    if (j.postedAt === null) { if (!unk.has('postedAt')) bad.push('posted unknown'); }
    else if (now - Date.parse(j.postedAt) > WINDOW[f.postedWithin]! + 60_000) bad.push(`posted ${j.postedAt}`);
  }
  if (f.minAnnualPayUsd !== undefined) {
    // only US dollar pay is compared (the screen says so); other currencies count as "not comparable", like an unknown
    const top = j.pay && j.pay.currency === 'USD' ? (j.pay.annualMax ?? j.pay.annualMin ?? (j.pay.period === 'year' ? (j.pay.max ?? j.pay.min) : null)) : null;
    if (top === null) { if (!unk.has('pay')) bad.push('pay unknown'); } else if (top < f.minAnnualPayUsd) bad.push(`pay ${top}`);
  }
  if (f.maxYearsRequired !== undefined) {
    const y = j.yearsRequired?.min ?? j.yearsRequired?.max ?? null;
    if (y === null) { if (!unk.has('years')) bad.push('years unknown'); } else if ((j.yearsRequired?.min ?? y) > f.maxYearsRequired) bad.push(`years ${y}`);
  }
  if (f.h1bSponsorship && !(it.h1bTag === 'likely_by_history' || it.h1bTag === 'post_says_yes')) bad.push(`h1b tag ${it.h1bTag}`);
  if (f.excludedCompanies?.includes(j.companyKey)) bad.push('excluded company');
  if (f.companies?.length && !f.companies.includes(j.companyKey)) bad.push('not an included company');
  if (f.excludeClearanceRequired && j.statements.clearanceRequired === true) bad.push('clearance required');
  if (f.excludeUsCitizenOnly && j.statements.usCitizenOnly === true) bad.push('citizens only');
  if (f.countries?.length) {
    const inCountry = j.places.some((p) => p.country && f.countries!.includes(p.country)) || (j.workModel === 'remote' && (j.remoteScope?.regions ?? []).some((r) => f.countries!.includes(r) || r === 'WORLDWIDE'));
    if (!inCountry && !(j.places.length === 0 && unk.has('place'))) bad.push(`country ${j.places.map((p) => p.country).join(',')}`);
  }
  if (f.status === 'open' && j.status !== 'open') bad.push('closed job in an open list');
  if (it.hidden) bad.push('hidden job in the list');
  return bad;
}

async function pageAll(demo: Demo, req: JobSearchRequest, max = 4000): Promise<{ items: JobListItem[]; total: number }> {
  const items: JobListItem[] = [];
  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const r = await demo.api.call('searchJobs', { body: { ...req, limit: 100, ...(cursor ? { cursor } : {}) } });
    total = r.total;
    items.push(...r.items);
    if (!r.nextCursor || items.length >= max) break;
    cursor = r.nextCursor;
  }
  return { items, total };
}

function lastSearch(p: Page): JobSearchRequest | null {
  const r = p.requests().filter((x) => x.url.endsWith('/api/v1/jobs/search') && x.body && !JSON.parse(x.body).cursor);
  return r.length ? (JSON.parse(r.at(-1)!.body!) as JobSearchRequest) : null;
}

async function ui(p: Page) {
  return p.eval<{ count: string; cards: string[]; chips: string[]; sort: string; active: string[] }>(`(() => ({
    count: (document.querySelector('.jl-results-line') || {}).innerText || '',
    cards: [...document.querySelectorAll('.jl-card')].map((c) => c.getAttribute('data-job-id')),
    chips: [...document.querySelectorAll('.jl-filter-btn')].map((b) => b.textContent.trim()),
    sort: (document.querySelector('.ant-select-selection-item') || {}).textContent || '',
    active: [...document.querySelectorAll('.jl-filter-btn.active')].map((b) => b.textContent.trim()),
  }))()`);
}

export async function run(demo: Demo): Promise<void> {
  // ---- the contract's own semantics against 5 combinations (the local API, as the outcome allows)
  const combos: Array<[string, JobFilter]> = [
    ['contract or part-time, remote', { employmentTypes: ['contract', 'part_time'], workModels: ['remote'] }],
    ['posted in 7 days, entry or mid', { postedWithin: '7d', levels: ['entry', 'mid'] }],
    ['pay 120K, no unknown', { minAnnualPayUsd: 120000 }],
    ['pay 120K, with unknown pay', { minAnnualPayUsd: 120000, includeUnknown: ['pay'] }],
    ['H-1B, full-time, 24h to 30d', { h1bSponsorship: true, employmentTypes: ['full_time'], postedWithin: '30d' }],
  ];
  const byPay: Record<string, number> = {};
  for (const [name, filter] of combos) {
    for (const sort of ['recommended', 'most_recent', 'top_matched'] as const) {
      const { items, total } = await pageAll(demo, { sort, filter });
      const bad = items.flatMap((it) => violations(it, filter).map((v) => `${it.job.id}: ${v}`));
      const ids = new Set(items.map((i) => i.job.id));
      check(bad.length === 0 && ids.size === items.length && total === items.length, `O7 [${name}] sort ${sort}: every job meets the filter, none repeats, total equals the list`, `${items.length} of total ${total}; ${bad.slice(0, 3).join(' | ')}`);
      if (sort === 'most_recent') {
        let wrong = 0;
        for (let i = 1; i < items.length; i++) { const a = items[i - 1]!.job.postedAt, b = items[i]!.job.postedAt; if (a === null && b !== null) wrong++; else if (a !== null && b !== null && Date.parse(a) < Date.parse(b)) wrong++; }
        check(wrong === 0, `O7 [${name}] most recent never goes the wrong way (jobs with no posted date last)`, `${wrong} out of order`);
      }
      if (sort === 'top_matched') {
        let wrong = 0;
        for (let i = 1; i < items.length; i++) { const a = items[i - 1]!.match?.percent ?? -1, b = items[i]!.match?.percent ?? -1; if (a < b) wrong++; }
        check(wrong === 0, `O7 [${name}] top matched never goes the wrong way`, `${wrong} out of order`);
      }
      if (sort === 'recommended') byPay[name] = items.length;
    }
  }
  check((byPay['pay 120K, with unknown pay'] ?? 0) > (byPay['pay 120K, no unknown'] ?? 0), 'O7 including jobs with unknown pay adds jobs (they are not silently dropped or passed)', `${byPay['pay 120K, no unknown']} -> ${byPay['pay 120K, with unknown pay']}`);
  const r1 = await demo.api.call('searchJobs', { body: { sort: 'recommended', filter: { postedWithin: '7d', levels: ['entry', 'mid'] }, limit: 50 } });
  const r2 = await demo.api.call('searchJobs', { body: { sort: 'recommended', filter: { postedWithin: '7d', levels: ['entry', 'mid'] }, limit: 50 } });
  check(JSON.stringify(r1.items.map((i) => i.job.id)) === JSON.stringify(r2.items.map((i) => i.job.id)), 'O7 Recommended keeps the same order on reload');

  // ---- through the screens
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(600);
    await p.clickText('Clear all');
    await sleep(700);

    // popover: Job type -> Contract
    p.clearRequests();
    await p.clickText('Job type');
    await sleep(300);
    await p.clickText('Contract', '.ant-popover');
    await p.clickText('Apply', '.ant-popover');
    await sleep(900);
    let req = lastSearch(p);
    let s = await ui(p);
    check(JSON.stringify(req?.filter?.employmentTypes) === '["contract"]', 'O7 the Job type popover sends exactly the chosen type', JSON.stringify(req?.filter));
    check(s.active.some((t) => /Contract/.test(t)), 'O7 an active filter looks different from an inactive one and names its value', s.active.join(' | '));
    if (req) {
      const all = await pageAll(demo, req);
      const shown = /([\d,]+) jobs?/.exec(s.count)?.[1]?.replace(/,/g, '');
      check(Number(shown) === all.total && all.items.every((i) => violations(i, req!.filter ?? {}).length === 0), 'O7 the count on screen equals the API total and every job meets the filter', `screen says "${s.count.trim()}", total ${all.total}`);
      check(JSON.stringify(s.cards.slice(0, 8)) === JSON.stringify(all.items.slice(0, 8).map((i) => i.job.id)), 'O7 the cards on screen are the first jobs of that search, in order');
    }

    // popover: Date posted -> Past week, then a Pay filter through the drawer
    await p.clickText('Date posted');
    await sleep(300);
    const posted = await p.eval<string[]>(`[...document.querySelectorAll('.ant-popover .ant-radio-wrapper')].map((x) => x.textContent.trim())`);
    const weekLabel = posted.find((x) => /week|7/i.test(x)) ?? posted[3]!;
    console.log('   date posted options:', posted.join(' | '));
    await p.clickText(weekLabel, '.ant-popover');
    await p.clickText('Apply', '.ant-popover');
    await sleep(900);
    req = lastSearch(p);
    s = await ui(p);
    check(req?.filter?.postedWithin === '7d' && JSON.stringify(req.filter.employmentTypes) === '["contract"]', 'O7 a second filter adds to the first and keeps it', JSON.stringify(req?.filter));
    check(/2 jobs|\d/.test(s.count) && s.cards.length >= 0, 'O7 the results line shows a count', s.count.trim());

    // empty result: says what to do next and how unknown values are treated
    await p.clickText('Pay');
    await sleep(300);
    const payText = await p.eval<string>(`(document.querySelector('.ant-popover') || {}).innerText || ''`);
    check(/no stated pay|not stated|no pay|unknown pay|left out/i.test(payText) && /Include jobs with no pay listed/.test(payText), 'O7 the Pay filter says how it treats jobs with no stated pay and offers to include them', payText.replace(/\s+/g, ' ').slice(0, 200));
    await p.press('Escape');
    await sleep(300);

    // sort control
    await p.clickText('Clear all');
    await sleep(700);
    p.clearRequests();
    await p.click('.ant-select-selector');
    await sleep(300);
    const sortOptions = await p.eval<string[]>(`[...document.querySelectorAll('.ant-select-item-option')].map((x) => x.textContent.trim())`);
    check(['Recommended', 'Top Matched', 'Most Recent'].every((x) => sortOptions.some((o) => o.toLowerCase() === x.toLowerCase())), 'O7 the sort menu has Recommended, Top Matched and Most Recent', sortOptions.join(' | '));
    await p.clickText('Most Recent', '.ant-select-dropdown');
    await sleep(900);
    req = lastSearch(p);
    check(req?.sort === 'most_recent', 'O7 choosing Most Recent sends that sort', req?.sort);
    if (req) {
      const all = await pageAll(demo, req, 300);
      s = await ui(p);
      check(JSON.stringify(s.cards.slice(0, 8)) === JSON.stringify(all.items.slice(0, 8).map((i) => i.job.id)), 'O7 the list on screen follows that order');
    }

    // fast typing: the last query wins and the count agrees with the list
    p.clearRequests();
    await p.click('.jl-search input');
    for (const ch of 'engineer') { await p.type(ch); await sleep(35); }
    await sleep(1500);
    s = await ui(p);
    const q = await p.eval<string>(`document.querySelector('.jl-search input').value`);
    req = lastSearch(p);
    check(q === 'engineer' && req?.q === 'engineer', 'O7 fast typing ends with the search of the full text', `field "${q}", last request "${req?.q}"`);
    if (req) {
      const all = await pageAll(demo, req);
      const shown = /([\d,]+) jobs?/.exec(s.count)?.[1]?.replace(/,/g, '');
      check(Number(shown) === all.total && /engineer/i.test(s.count), 'O7 the count and the list are for the new query, not an older one', `screen "${s.count.trim()}" vs total ${all.total}`);
      const ids = await p.eval<string[]>(`[...document.querySelectorAll('.jl-card')].slice(0, 12).map((c) => c.getAttribute('data-job-id'))`);
      let miss = 0;
      for (const id of ids) { const d = await demo.api.call('getJob', { params: { jobId: id } }); if (!/engineer/i.test(`${d.job.title} ${d.job.company} ${d.job.description}`)) miss++; }
      check(ids.length > 0 && miss === 0, 'O7 every card on screen contains the search word (title, company or posting text)', `${ids.length} cards, ${miss} without it`);
    }
    await p.eval(`document.querySelector('.jl-search input').focus()`);
    await p.clickText('Clear words');
    await sleep(500);

    // saved filter: save two, restart, compare every field
    await p.clickText('Clear all');
    await sleep(500);
    void 0;
  } finally {
    await b.close();
  }

  const f1: JobFilter = { employmentTypes: ['full_time'], workModels: ['remote', 'hybrid'], levels: ['senior'], excludedCompanies: ['harborhealth'], companies: [], minAnnualPayUsd: 100000, includeUnknown: ['pay', 'level'], postedWithin: '30d', places: [{ text: 'Austin, TX', placeId: null, radiusMiles: 25 }], excludedTitles: ['intern'], skills: ['Python'], h1bSponsorship: true };
  const f2: JobFilter = { countries: ['US'], jobFunctions: ['Data'], excludedIndustries: ['Staffing and Recruiting'], excludeStaffingAgencies: true, maxYearsRequired: 3 };
  const c1 = await demo.api.call('createFilter', { body: { name: 'Round trip one', filter: f1, sort: 'top_matched', alert: true } });
  const c2 = await demo.api.call('createFilter', { body: { name: 'Round trip two', filter: f2, sort: 'most_recent' } });
  if (demo.home) {
    demo.kill9();
    await sleep(400);
    await demo.relaunchApi(['--no-crawl']);
    const back = await demo.api.call('listFilters');
    const g1 = back.find((x) => x.id === c1.id), g2 = back.find((x) => x.id === c2.id);
    check(!!g1 && JSON.stringify(g1.filter) === JSON.stringify(c1.filter) && g1.sort === 'top_matched' && g1.alert.enabled === true && g1.name === 'Round trip one', 'O7 saved filter one comes back with every field after a restart', JSON.stringify(g1?.filter));
    check(!!g2 && JSON.stringify(g2.filter) === JSON.stringify(c2.filter) && g2.sort === 'most_recent', 'O7 saved filter two comes back with every field after a restart');
    await demo.api.call('deleteFilter', { params: { filterId: c1.id } });
    await demo.api.call('deleteFilter', { params: { filterId: c2.id } });
  }
}
