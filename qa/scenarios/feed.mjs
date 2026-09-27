// Replay of the Jobs feed checks (area: feed). Plain Node 24 ES module, no packages.
// Reads JOBLEFT_QA_URL, JOBLEFT_QA_API, JOBLEFT_QA_TOKEN, JOBLEFT_QA_SHOTS, JOBLEFT_QA_STATE.
// Never assumes a specific job or company: every check is an invariant over whatever jobs exist.
// Prints one line per check: "CHECK ok <name>", "CHECK FAIL <name>: <why>" or "CHECK skip <name>: <why>".
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { launch, AUDIT } = await import(new URL('../bin/driver.mjs', import.meta.url).href);

const URL0 = process.env.JOBLEFT_QA_URL;
const API = (process.env.JOBLEFT_QA_API || '').replace(/\/$/, '');
const TOKEN = process.env.JOBLEFT_QA_TOKEN;
const SHOTS = process.env.JOBLEFT_QA_SHOTS || '.';
const STATE = process.env.JOBLEFT_QA_STATE || 'golden';
if (!URL0 || !API || !TOKEN) { console.log('CHECK FAIL setup: JOBLEFT_QA_URL, JOBLEFT_QA_API and JOBLEFT_QA_TOKEN are required'); process.exit(1); }
try { mkdirSync(SHOTS, { recursive: true }); } catch {}

let failed = 0;
const ok = (n) => console.log(`CHECK ok ${n}`);
const fail = (n, why) => { failed++; console.log(`CHECK FAIL ${n}: ${String(why).replace(/\s+/g, ' ').slice(0, 400)}`); };
const skip = (n, why) => console.log(`CHECK skip ${n}: ${why}`);
const check = (n, cond, why) => (cond ? ok(n) : fail(n, why));
const START = Date.now();
const timeLeft = () => 9 * 60 * 1000 - (Date.now() - START);

async function api(path, { method = 'GET', body, headers = {}, token = TOKEN } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h['x-jobleft-token'] = token;
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const search = (filter = {}, extra = {}) => api('/jobs/search', { method: 'POST', body: { sort: 'recommended', filter, limit: 100, ...extra } });
async function pageAll(filter, extra = {}, maxItems = 3000) {
  let cursor = null; const items = []; const totals = new Set(); let err = null;
  while (items.length < maxItems) {
    const r = await search(filter, { ...extra, ...(cursor ? { cursor } : {}) });
    if (r.status !== 200) { err = `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`; break; }
    totals.add(r.body.total); items.push(...r.body.items);
    cursor = r.body.nextCursor; if (!cursor) break;
  }
  const ids = items.map((i) => i.job.id);
  return { items, totals: [...totals], complete: !cursor, dup: ids.length - new Set(ids).size, err };
}

// Facts each filter promises, judged from the job's own facts (the same facts the card shows).
const DAY = 864e5;
const WIN = { '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const FACT = {
  levels: (j, v, unk) => (j.levels || []).some((l) => v.includes(l)) || (unk && !(j.levels || []).length),
  employmentTypes: (j, v, unk) => v.includes(j.employmentType) || (unk && j.employmentType == null),
  workModels: (j, v, unk) => v.includes(j.workModel) || (unk && j.workModel == null),
  postedWithin: (j, v, unk) => (j.postedAt && Date.now() - Date.parse(j.postedAt) <= WIN[v] + 2 * 36e5) || (unk && !j.postedAt),
  maxYearsRequired: (j, v, unk) => (j.yearsRequired && j.yearsRequired.min <= v) || (unk && !j.yearsRequired),
  minAnnualPayUsd: (j, v, unk) => (j.pay && j.pay.currency === 'USD' && (j.pay.annualMax ?? j.pay.annualMin) >= v) || (unk && !j.pay),
  countries: (j, v, unk) => (j.places || []).some((p) => v.includes(p.country)) || (j.remoteScope?.regions || []).some((r) => v.includes(r)) || (unk && (j.places || []).every((p) => !p.country)),
};
const UNK = { levels: 'level', employmentTypes: 'employmentType', workModels: 'workModel', postedWithin: 'postedAt', maxYearsRequired: 'years', minAnnualPayUsd: 'pay', countries: 'place' };

async function exactness(name, filter) {
  const r = await pageAll(filter);
  if (r.err) return fail(name, r.err);
  const unk = filter.includeUnknown || [];
  const bad = r.items.filter((it) => Object.entries(filter).some(([k, v]) => FACT[k] && !FACT[k](it.job, v, unk.includes(UNK[k]))));
  const why = [];
  if (r.totals.length !== 1) why.push(`total changed while paging ${r.totals}`);
  if (r.complete && r.totals[0] !== r.items.length) why.push(`total ${r.totals[0]} but paged ${r.items.length}`);
  if (r.dup) why.push(`${r.dup} duplicate jobs across pages`);
  if (bad.length) why.push(`${bad.length}/${r.items.length} jobs break the filter, e.g. ${bad.slice(0, 3).map((b) => `${b.job.id} "${b.job.title}"`).join('; ')}`);
  check(name, !why.length, why.join('; '));
}

// ---------- API checks (no browser) ----------
const health = await api('/health', { token: null });
check('health answers without a token', health.status === 200 && health.body && health.body.app === 'jobleft', `HTTP ${health.status}`);
const noTok = await api('/jobs/search', { method: 'POST', body: { sort: 'recommended', filter: {}, limit: 1 }, token: null });
check('search refuses a missing token in plain words', noTok.status === 401 && typeof noTok.body?.error?.message === 'string' && !/stack|Error:/.test(noTok.body.error.message), `HTTP ${noTok.status} ${JSON.stringify(noTok.body).slice(0, 120)}`);
const evil = await api('/jobs/search', { method: 'POST', body: { sort: 'recommended', filter: {}, limit: 1 }, headers: { Origin: 'https://evil.example' } });
check('search refuses another web page (Origin)', evil.status === 403, `HTTP ${evil.status}`);
for (const [n, body] of [['bad sort', { sort: 'nope', filter: {}, limit: 5 }], ['negative limit', { sort: 'recommended', filter: {}, limit: -1 }], ['wrong type', { sort: 'recommended', filter: { levels: 'entry' }, limit: 5 }], ['garbage cursor', { sort: 'recommended', filter: {}, limit: 5, cursor: 'garbage' }], ['not JSON', 'notjson']]) {
  const r = await api('/jobs/search', { method: 'POST', body });
  check(`search refuses ${n} with 400 and a message`, r.status === 400 && typeof r.body?.error?.message === 'string', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}
const unknownJob = await api('/jobs/' + encodeURIComponent('nope:nope:0'));
check('unknown job id gives 404 in plain words', unknownJob.status === 404 && typeof unknownJob.body?.error?.message === 'string', `HTTP ${unknownJob.status}`);
const health2 = await api('/health', { token: null });
check('health still answers after bad requests', health2.status === 200, `HTTP ${health2.status}`);

const first = await search({});
const TOTAL = first.status === 200 ? first.body.total : 0;
const HAVE_JOBS = TOTAL > 0;
if (!HAVE_JOBS) {
  for (const n of ['filter exactness', 'sort order', 'match tile', 'counts vs badges', 'reload persistence', 'UI feed']) skip(n, `state ${STATE}: the feed has no jobs yet`);
  process.exit(failed ? 1 : 0);
}

// Filter exactness against each job's own facts (API the screen uses).
const levelsPresent = new Set(first.body.items.flatMap((i) => i.job.levels || []));
for (const l of ['entry', 'senior', 'intern_new_grad']) await exactness(`filter exact: level ${l}`, { levels: [l] });
await exactness('filter exact: level entry + include unknown', { levels: ['entry'], includeUnknown: ['level'] });
for (const t of ['full_time', 'part_time', 'contract']) await exactness(`filter exact: job type ${t}`, { employmentTypes: [t] });
for (const w of ['remote', 'hybrid', 'onsite']) await exactness(`filter exact: work model ${w}`, { workModels: [w] });
for (const d of ['3d', '7d', '30d']) await exactness(`filter exact: posted within ${d}`, { postedWithin: d });
await exactness('filter exact: at most 3 years', { maxYearsRequired: 3 });
await exactness('filter exact: pay at least $80K (USD)', { minAnnualPayUsd: 80000 });
await exactness('filter exact: US + entry level (combined)', { countries: ['US'], levels: ['entry'] });
// A non-US country from the Location popover, when the data has jobs there.
{
  const sample = await pageAll({}, {}, 1500);
  const codes = ['CA', 'GB', 'IE', 'DE', 'AU'].filter((c) => sample.items.some((i) => (i.job.places || []).some((p) => p.country === c)));
  if (!codes.length) skip('filter exact: non-US country', 'no jobs in CA/GB/IE/DE/AU in the first 1,500');
  else await exactness(`filter exact: country ${codes[0]}`, { countries: [codes[0]] });
  // Facts shown as unknown, never as "$0" or "0+ years": pay/years facts that exist are positive.
  const zeroPay = sample.items.filter((i) => i.job.pay && ((i.job.pay.max ?? i.job.pay.min) === 0));
  check('no job has a stated pay of $0', !zeroPay.length, zeroPay.slice(0, 3).map((i) => i.job.id).join(', '));
}

// Sort order.
if (timeLeft() > 0) {
  const mr = await pageAll({}, { sort: 'most_recent' }, 2000);
  let inv = mr.items.findIndex((it, k) => k > 0 && it.job.postedAt && mr.items[k - 1].job.postedAt && Date.parse(mr.items[k - 1].job.postedAt) < Date.parse(it.job.postedAt));
  const nullBeforeDated = mr.items.findIndex((it, k) => k > 0 && !mr.items[k - 1].job.postedAt && it.job.postedAt);
  check('sort: Most recent is newest posted first (first 2,000)', inv < 0 && nullBeforeDated < 0, inv >= 0 ? `place ${inv}: ${mr.items[inv - 1].job.postedAt} before ${mr.items[inv].job.postedAt}` : `undated job before a dated one at ${nullBeforeDated}`);
  const tm = await pageAll({}, { sort: 'top_matched' }, 2000);
  inv = tm.items.findIndex((it, k) => k > 0 && tm.items[k - 1].match.percent < it.match.percent);
  check('sort: Top matched is highest match first (first 2,000)', inv < 0, inv >= 0 ? `place ${inv}: ${tm.items[inv - 1].match.percent}% before ${tm.items[inv].match.percent}%` : '');
  const bandBad = tm.items.filter((i) => i.match.band !== (i.match.percent >= 85 ? 'strong' : i.match.percent >= 70 ? 'good' : 'fair'));
  check('match band follows the number (STRONG >= 85, GOOD 70-84, FAIR < 70)', !bandBad.length, bandBad.slice(0, 3).map((i) => `${i.job.id} ${i.match.percent}% ${i.match.band}`).join('; '));
  let diff = [];
  for (const it of tm.items.slice(0, 15)) {
    const d = await api('/jobs/' + encodeURIComponent(it.job.id));
    if (d.status !== 200 || d.body.match.percent !== it.match.percent || d.body.match.band !== it.match.band) diff.push(`${it.job.id} list ${it.match.percent} detail ${d.body?.match?.percent}`);
  }
  check('match: same percent and band in list and detail (15 jobs)', !diff.length, diff.join('; '));
} else skip('sort order', 'time budget used');

// ---------- UI checks ----------
const b = await launch();
const POP = '.ant-popover:not(.ant-popover-hidden)';
try {
  const p = await b.page();
  await p.size(1400, 900);
  const t0 = Date.now();
  await p.goto(URL0);
  const cardsSel = '#jl-feed-scroll [data-job-id]';
  const toFeed = async () => {
    await p.click('.jl-topbar-tabs a[href="#/jobs"]');
    await p.waitFor(`document.querySelector('button[aria-label^="Hidden jobs"]') && document.querySelectorAll('${cardsSel}').length > 0`, 20000);
    await p.waitFor(`!document.body.innerText.includes('Updating')`, 15000);
  };
  const shown = await p.waitFor(`document.querySelectorAll('${cardsSel}').length > 0 || document.querySelector('.jl-topbar-tabs')`, 20000);
  if (!shown) { fail('UI: feed opens', 'no job list after 20 s'); throw new Error('stop'); }
  await toFeed();
  const firstMs = Date.now() - t0;
  check('UI: first cards within 2 s', firstMs <= 2000, `${firstMs} ms`);
  await p.shot(join(SHOTS, 'feed-01-first.png'));

  const audit = await p.eval(AUDIT);
  const cardText = await p.eval(`[...document.querySelectorAll('${cardsSel}')].map(c => c.innerText).join('\\n')`);
  const banned = (cardText.match(/\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\$0(?![\d.,])|\b0\+ years|\bcredits?\b(?! risk| card| union)/gi) || []);
  check('UI: no banned words or placeholders on cards', !banned.length, banned.slice(0, 5).join(', '));
  check('UI: no horizontal page scroll', !audit.overflowX, 'page scrolls sideways');

  // Counts vs badges.
  const badges = await p.eval(`Object.fromEntries([...document.querySelectorAll('.jl-topbar-tabs a')].map(a => { const m = (a.getAttribute('aria-label') || '').match(/^(\\w+), (\\d+)$/); return m ? [m[1], +m[2]] : [a.innerText.trim(), null]; }))`);
  for (const [tab, view] of [['Liked', 'liked'], ['Applied', 'applied'], ['External', 'external']]) {
    const t = await api(`/tracker?view=${view}&limit=100`);
    const n = t.status === 200 ? t.body.items.length : -1;
    check(`counts: ${tab} badge equals saved ${view} jobs`, badges[tab] === n, `badge ${badges[tab]} vs ${n}`);
  }
  const hiddenBadge = await p.eval(`+((document.querySelector('button[aria-label^="Hidden jobs"]')?.getAttribute('aria-label') || '').match(/\\d+/) || [NaN])[0]`);
  const th = await api('/tracker?view=hidden&limit=100');
  check('counts: Hidden jobs badge equals hidden jobs', th.status === 200 && hiddenBadge === th.body.items.length, `badge ${hiddenBadge} vs ${th.body?.items?.length}`);
  const countText = await p.eval(`(document.querySelector('#jl-feed-scroll').innerText.match(/([\\d,]+) jobs?\\b/) || [])[1]`);
  const lastReq = p.requests().filter((r) => r.url.includes('/jobs/search')).pop();
  if (lastReq) {
    const again = await api('/jobs/search', { method: 'POST', body: lastReq.body });
    check('counts: "N jobs" equals the search total', again.status === 200 && Number(String(countText).replace(/,/g, '')) === again.body.total, `screen ${countText} vs API ${again.body?.total}`);
  } else skip('counts: "N jobs" equals the search total', 'no search request seen');

  // Filter from the screen: Experience level "Entry Level" → every card shows "Entry"; then Job type keeps it.
  const applyPop = async (label, option) => {
    p.clearRequests();
    await p.click(`button[aria-label^="${label}"]`);
    if (!(await p.waitFor(`document.querySelector('${POP}')`, 5000))) return null;
    const picked = await p.clickText(option, POP);
    await p.clickText('Apply', POP);
    await p.waitFor(`document.querySelector('${POP}') === null`, 5000);
    await p.waitFor(`!document.body.innerText.includes('Updating')`, 15000);
    const reqs = p.requests().filter((r) => r.url.includes('/jobs/search'));
    return picked && reqs.length ? JSON.parse(reqs[reqs.length - 1].body) : null;
  };
  const r1 = await applyPop('Experience level filter', 'Entry Level');
  if (!r1) skip('UI filter: Entry Level', 'could not open or apply the Experience level popover');
  else {
    const cards = await p.eval(`[...document.querySelectorAll('${cardsSel}')].map(c => [c.getAttribute('data-job-id'), c.innerText])`);
    const badCards = cards.filter(([, t]) => !/\bEntry\b/.test(t) || /\bSenior Level\b/.test(t));
    check('UI filter: every card under "Entry Level" shows Entry and not Senior', cards.length > 0 && !badCards.length, cards.length ? badCards.slice(0, 3).map(([id]) => id).join(', ') : 'no cards');
    await p.shot(join(SHOTS, 'feed-02-entry.png'));
    const r2 = await applyPop('Job type filter', 'Full-time');
    if (!r2) skip('UI filter: filters combine', 'could not apply Job type');
    else check('UI filter: a second filter keeps the first (Entry Level + Full-time)', (r2.filter.levels || []).includes('entry') && (r2.filter.employmentTypes || []).includes('full_time'), `request filter ${JSON.stringify(r2.filter)}`);
    await p.shot(join(SHOTS, 'feed-03-combined.png'));
  }
  p.clearRequests();
  await p.clickText('Clear all');
  await p.waitFor(`!document.body.innerText.includes('Updating')`, 15000);
  // Let the list settle after the new search before touching cards.
  for (let i = 0; i < 20; i++) { const before = p.requests().length; await p.waitFor('false', 300); if (p.requests().length === before) break; }

  // Reload persistence: like one job and hide another, reload, check both.
  await p.waitFor(`document.querySelectorAll('#jl-feed-scroll button[aria-label^="Like "]').length >= 2 && document.querySelectorAll('#jl-feed-scroll button[aria-label^="Not interested in "]').length >= 2`, 10000);
  const likeId = await p.eval(`(() => { const b = document.querySelector('#jl-feed-scroll button[aria-label^="Like "]'); return b ? b.closest('[data-job-id]').getAttribute('data-job-id') : null; })()`);
  const hideId = await p.eval(`(() => { const all = [...document.querySelectorAll('#jl-feed-scroll button[aria-label^="Not interested in "]')].map(b => b.closest('[data-job-id]').getAttribute('data-job-id')).filter(x => x !== ${JSON.stringify(likeId)}); return all[0] || null; })()`);
  if (!likeId || !hideId) skip('reload persistence', 'no two jobs with Like and Not interested buttons');
  else {
    const likedBefore = (await api('/tracker?view=liked&limit=100')).body.items.length;
    p.clearRequests();
    await p.click(`#jl-feed-scroll [data-job-id="${likeId}"] button[aria-label^="Like "]`);
    const likeShown = await p.waitFor(`[...document.querySelectorAll('.jl-topbar-tabs a')].some(a => a.getAttribute('aria-label') === 'Liked, ${likedBefore + 1}')`, 5000);
    const likeSent = p.requests().some((r) => r.method === 'PATCH' && r.url.includes(encodeURIComponent(likeId)));
    check('like: the Liked badge goes up at once', likeShown, `request sent: ${likeSent}; badge did not reach ${likedBefore + 1} in 5 s`);
    await p.click(`#jl-feed-scroll [data-job-id="${hideId}"] button[aria-label^="Not interested in "]`);
    const gone = await p.waitFor(`!document.querySelector('#jl-feed-scroll [data-job-id="${hideId}"] button[aria-label^="Not interested in "]')`, 5000);
    check('hide: the card leaves the list at once', gone, 'still listed after 5 s');
    const likedSaved = (await api('/tracker?view=liked&limit=100')).body.items.some((i) => i.entry.jobId === likeId);
    await p.goto(URL0);
    await toFeed();
    const likedBadge = await p.eval(`[...document.querySelectorAll('.jl-topbar-tabs a')].map(a => a.getAttribute('aria-label')).find(l => /^Liked/.test(l))`);
    if (!likeShown) skip('reload: the like is kept (badge)', 'the like did not register before the reload');
    else check('reload: the like is kept (badge)', likedSaved && likedBadge === `Liked, ${likedBefore + 1}`, `saved: ${likedSaved}; badge "${likedBadge}", expected ${likedBefore + 1}`);
    const stillListed = await p.eval(`!!document.querySelector('#jl-feed-scroll [data-job-id="${hideId}"]')`);
    const apiHas = (await search({}, { limit: 100 })).body.items.some((i) => i.job.id === hideId);
    check('reload: the hidden job stays out of Recommended (screen and search)', !stillListed && !apiHas, `listed on screen: ${stillListed}; returned by search: ${apiHas}`);
    await p.shot(join(SHOTS, 'feed-04-after-reload.png'));
    // Put things back.
    await api('/tracker/' + encodeURIComponent(likeId), { method: 'PATCH', body: { liked: false } });
    await api('/tracker/' + encodeURIComponent(hideId), { method: 'PATCH', body: { hidden: false } });
  }
  const errs = p.errors().filter((e) => !/favicon|ResizeObserver/i.test(String(e.text || e)));
  check('UI: no uncaught page errors', !errs.length, JSON.stringify(errs).slice(0, 300));
} catch (e) {
  if (e.message !== 'stop') fail('UI run', e.message);
} finally {
  await b.close();
}
process.exit(failed ? 1 : 0);
