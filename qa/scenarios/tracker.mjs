// Replay of the tracker area's most important checks (job detail, tracker, dashboard, alerts, tracker API).
// Plain Node 24 ES module, no packages. Reads its target from JOBLEFT_QA_* (see scenarios/README.md).
// Never assumes a specific job: it picks untracked jobs from the recommended list, asserts invariants
// (screens agree with the API and with each other, nothing is lost after a reload), then undoes its changes.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const { launch, AUDIT } = await import(new URL('../bin/driver.mjs', import.meta.url));

const PAGE_URL = process.env.JOBLEFT_QA_URL;
const API = (process.env.JOBLEFT_QA_API || '').replace(/\/$/, '');
const TOKEN = process.env.JOBLEFT_QA_TOKEN;
const SHOTS = process.env.JOBLEFT_QA_SHOTS || '.';
const STATE = process.env.JOBLEFT_QA_STATE || 'golden';
if (!PAGE_URL || !API || !TOKEN) { console.log('CHECK FAIL setup: JOBLEFT_QA_URL, JOBLEFT_QA_API and JOBLEFT_QA_TOKEN are required'); process.exit(1); }
try { mkdirSync(SHOTS, { recursive: true }); } catch {}

let failed = 0;
const ok = (n) => console.log(`CHECK ok ${n}`);
const fail = (n, why) => { failed++; console.log(`CHECK FAIL ${n}: ${String(why).replace(/\s+/g, ' ').slice(0, 400)}`); };
const skip = (n, why) => console.log(`CHECK skip ${n}: ${why}`);
const check = (n, cond, why) => (cond ? ok(n) : fail(n, why));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();

async function api(method, path, body, headers = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'x-jobleft-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const enc = encodeURIComponent;
const getEntry = async (id) => (await api('GET', '/jobs/' + enc(id))).body?.tracker ?? null;
async function trackerState() {
  const lv = (await api('GET', '/tracker?view=liked')).body;
  const av = (await api('GET', '/tracker?view=applied')).body;
  const all = new Map();
  for (const i of [...(lv.items || []), ...(av.items || [])]) all.set(i.job.id, i);
  const items = [...all.values()];
  const by = (s) => items.filter((i) => i.entry.status === s).length;
  return {
    counts: av.counts,
    likedNotApplied: items.filter((i) => i.entry.liked && !i.entry.status).length,
    liked: items.filter((i) => i.entry.liked).length,
    applications: items.filter((i) => i.entry.status).length,
    applied: by('applied'), interviewing: by('interviewing'), offer: by('offer_received'), rejected: by('rejected'), archived: by('archived'),
    ids: new Set(items.map((i) => i.job.id)),
  };
}

// ---------- 1. API refusals (no browser needed) ----------
{
  const h = await fetch(API + '/health');
  const hb = await h.json().catch(() => null);
  check('api-health', h.status === 200 && hb?.app === 'jobleft', `status ${h.status} body ${JSON.stringify(hb)}`);
  const nt = await fetch(API + '/tracker?view=liked');
  check('api-no-token-refused', nt.status === 401, `status ${nt.status}`);
  const og = await fetch(API + '/tracker?view=liked', { headers: { 'x-jobleft-token': TOKEN, origin: 'https://evil.example' } });
  check('api-other-origin-refused', og.status === 403 && !og.headers.get('access-control-allow-origin'), `status ${og.status} ACAO ${og.headers.get('access-control-allow-origin')}`);
  const bv = await api('GET', '/tracker?view=bogus');
  check('api-bad-view-refused-plainly', bv.status === 400 && typeof bv.body?.error?.message === 'string', `status ${bv.status}`);
  const uj = await api('PATCH', '/tracker/' + enc('nosuchboard:nosuchjob:0'), { liked: true });
  check('api-unknown-job-404', uj.status === 404 && typeof uj.body?.error?.message === 'string', `status ${uj.status} ${JSON.stringify(uj.body).slice(0, 120)}`);
}

// ---------- pick jobs ----------
const search = await api('POST', '/jobs/search', { sort: 'recommended', filter: {}, limit: 80 });
const total = search.body?.total ?? 0;
const NAMES_JOB = ['card-equals-detail', 'band-follows-number', 'why-this-score-three-parts', 'panel-equals-why', 'apply-opens-employer-page', 'visa-section-agrees-with-chip',
  'score-same-after-reload', 'esc-closes-detail', 'unknown-job-page', 'skills-required-count', 'api-bad-stage-refused', 'api-long-note-refused', 'like-and-apply-from-detail',
  'stage-move-by-select', 'stage-move-back', 'notes-reminders-persist-after-reload', 'tracker-columns-equal-api', 'feed-tabs-equal-tracker', 'dashboard-numbers-equal-api',
  'dashboard-weekly-sum-equals-applications', 'dashboard-lists-every-open-reminder', 'alerts-lists-every-upcoming-reminder', 'not-applied-keeps-job-tracked', 'tracker-lists-both-reminders', 'banned-words', 'no-page-errors'];
if (search.status !== 200 || total === 0) {
  for (const n of NAMES_JOB) skip(n, STATE === 'fresh' ? 'state is fresh and there are no jobs yet' : `no jobs to test (search status ${search.status}, total ${total})`);
  process.exit(failed ? 1 : 0);
}
const untracked = search.body.items.filter((i) => !i.trackerStatus && !i.liked && !i.hidden).map((i) => i.job);
const touched = new Set();

// ---------- 2. API invariants over the listed jobs ----------
{
  const bad = await api('PATCH', '/tracker/' + enc(search.body.items[0].job.id), { status: 'bogus' });
  const health = await fetch(API + '/health');
  check('api-bad-stage-refused', bad.status === 400 && health.status === 200, `status ${bad.status}, health ${health.status}`);
  if (untracked[0]) {
    const long = await api('PATCH', '/tracker/' + enc(untracked[0].id), { notes: [{ text: 'z'.repeat(20001) }] });
    touched.add(untracked[0].id);
    check('api-long-note-refused', long.status === 400, `status ${long.status}`);
  } else skip('api-long-note-refused', 'no untracked job');
  const wrong = [];
  for (const it of search.body.items.slice(0, 25)) {
    const d = (await api('GET', '/jobs/' + enc(it.job.id))).body;
    const r = d?.match?.subScores?.skills?.reasons?.find((x) => x.code === 'skills_required');
    const m = r && /You have (\d+) of the (\d+)/.exec(r.text);
    if (m && +m[2] !== (d.match.skills?.required?.length ?? -1)) wrong.push(`${it.job.id}: "${m[0]}" but ${d.match.skills.required.length} required listed`);
  }
  check('skills-required-count', wrong.length === 0, `${wrong.length} of 25 jobs: ${wrong.slice(0, 3).join('; ')}`);
}

const b = await launch();
try {
  const p = await b.page();
  await p.size(1400, 900);
  await p.goto(PAGE_URL);
  await p.waitFor(`document.querySelectorAll('.jl-card').length > 0`, 20000);
  const nav = async (hash, cond, t = 15000) => { await p.eval(`location.hash = ${JSON.stringify(hash)}`); return p.waitFor(cond, t); };
  const openDetail = (id) => nav('#/jobs/' + enc(id), `document.querySelector('.jl-detail-card h1') && document.querySelector('.jl-match-panel') && decodeURIComponent(location.hash).includes(${JSON.stringify(id)})`);
  const toastsGone = () => p.waitFor(`!document.querySelector('.ant-message-notice')`, 8000);
  const setVal = (sel, v) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
  const content = () => p.eval(`(document.querySelector('.jl-content') || document.body).innerText`);
  const banned = [];
  // the employer's own posting text is hidden while auditing: it may legitimately contain words such as "Applicants"
  const audit = async (where) => {
    await p.eval(`document.querySelectorAll('.jl-desc').forEach((e) => { e.dataset.qaDisplay = e.style.display; e.style.display = 'none'; })`);
    const a = await p.eval(AUDIT);
    await p.eval(`document.querySelectorAll('.jl-desc').forEach((e) => { e.style.display = e.dataset.qaDisplay || ''; })`);
    for (const w of a.banned) banned.push(`${where}: ${w}`);
  };

  // ---------- 3. card facts = detail facts ----------
  const CARDS = `[...document.querySelectorAll('.jl-card')].map(c => {
    const facts = {}; for (const f of c.querySelectorAll('.jl-card-facts .jl-fact')) { const ic = f.querySelector('[role=img]')?.getAttribute('aria-label'); const t = f.querySelector('.txt')?.getAttribute('title') ?? f.textContent.trim(); if (ic && !facts[ic]) facts[ic] = t; }
    const m = /Match (\\d+) percent, (\\w+) match/.exec(c.querySelector('.jl-tile')?.getAttribute('aria-label') || '');
    return { id: c.dataset.jobId, title: c.querySelector('.jl-card-title')?.textContent.trim(), company: c.querySelector('.jl-card-company')?.getAttribute('title'), facts, pct: m ? +m[1] : null, band: m ? m[2] : null, apply: c.querySelector('a[aria-label^="Apply"]')?.href ?? null };
  })`;
  const DETAIL = `(() => { const d = document.querySelector('.jl-detail-card'); if (!d) return null;
    const facts = {}; for (const f of d.querySelectorAll('section[aria-label="Job summary"] .jl-fact')) { const l = f.querySelector('.jl-sr')?.textContent.replace(':', '').trim(); const c = f.cloneNode(true); c.querySelector('.jl-sr')?.remove(); c.querySelectorAll('.jl-small').forEach(x => x.remove()); if (l) facts[l] = c.textContent.trim(); }
    const mp = d.querySelector('.jl-match-panel'); const m = /Match (\\d+) percent, (\\w+) match/.exec(mp?.getAttribute('aria-label') || '');
    const rows = {}; for (const r of mp?.querySelectorAll('.inner .row') ?? []) rows[r.firstElementChild.getAttribute('title')] = r.lastElementChild.textContent.trim();
    const why = [...d.querySelectorAll('#sec-why .jl-factbox strong')].map(x => x.textContent.trim());
    const visaH = [...d.querySelectorAll('h2,h3')].find(e => /Visa sponsorship/.test(e.textContent));
    const a = document.querySelector('.jl-actionbar a[aria-label^="Apply"]');
    return { title: d.querySelector('h1')?.textContent.trim(), company: d.querySelector('section[aria-label="Job summary"] strong')?.textContent.trim(), facts, pct: m ? +m[1] : null, band: m ? m[2] : null, big: mp?.querySelector('.big')?.firstChild?.textContent.trim(), rows, why,
      chips: [...d.querySelectorAll('.jl-fitchip')].map(x => x.textContent.trim()), visa: visaH?.closest('section')?.innerText ?? '', apply: a ? { href: a.href, target: a.target, rel: a.rel } : null };
  })()`;
  const cards = (await p.eval(CARDS)).filter((c) => c.id && c.pct !== null).slice(0, 8);
  const factMap = { environment: 'Location', dollar: 'Pay', idcard: 'Level', calendar: 'Experience', 'clock-circle': 'Job type', home: 'Work model' };
  const bandOf = (n) => (n >= 85 ? 'strong' : n >= 70 ? 'good' : 'fair');
  const diffs = [], bandBad = [], whyBad = [], panelBad = [], applyBad = [], visaBad = [], seen = [];
  for (const c of cards) {
    await p.click(`.jl-card[data-job-id="${c.id}"] .jl-card-title a`);
    if (!(await p.waitFor(`document.querySelector('.jl-detail-card h1') && document.querySelector('.jl-match-panel') && decodeURIComponent(location.hash).includes(${JSON.stringify(c.id)})`, 15000))) { diffs.push(`${c.id}: detail did not open`); continue; }
    const d = await p.eval(DETAIL);
    seen.push({ id: c.id, pct: d.pct });
    if (seen.length === 1) { await p.shot(join(SHOTS, 'tracker-detail.png')); await audit('job detail'); }
    if (d.title !== c.title) diffs.push(`${c.id} title "${c.title}" vs "${d.title}"`);
    if (d.company !== c.company) diffs.push(`${c.id} company "${c.company}" vs "${d.company}"`);
    if (d.pct !== c.pct || String(d.pct) !== String(d.big)) diffs.push(`${c.id} percent card ${c.pct} vs detail ${d.pct}/${d.big}`);
    if (d.band !== c.band) diffs.push(`${c.id} band card ${c.band} vs detail ${d.band}`);
    for (const [ic, v] of Object.entries(c.facts)) {
      const k = factMap[ic]; if (!k) continue;
      const dv = d.facts[k] || '';
      if (!(dv === v || dv.startsWith(v) || dv.startsWith(v.split(/[;+]/)[0].trim()))) diffs.push(`${c.id} ${k} card "${v}" vs detail "${dv}"`);
    }
    for (const n of [c.pct, d.pct]) if (n !== null && bandOf(n) !== c.band) bandBad.push(`${c.id} ${n}% shown as ${c.band}`);
    const want = ['Experience Level', 'Skills', 'Industry Experience'];
    if (d.why.length !== 3 || !want.every((w, i) => (d.why[i] || '').startsWith(w))) whyBad.push(`${c.id}: ${JSON.stringify(d.why)}`);
    for (const [i, w] of want.entries()) {
      const row = d.rows[w] ?? ''; const head = d.why[i] ?? '';
      const rowPct = /(\d+)\s*%/.exec(row)?.[1] ?? 'unknown'; const headPct = /(\d+)%/.exec(head)?.[1] ?? 'unknown';
      if (rowPct !== headPct) panelBad.push(`${c.id} ${w}: panel "${row}" vs why "${head}"`);
    }
    const job = (await api('GET', '/jobs/' + enc(c.id))).body?.job;
    const expectHref = job?.applyUrl || job?.url;
    const a = d.apply;
    if (!a || !/^https?:\/\//.test(a.href) || a.target !== '_blank' || !/noopener/.test(a.rel) || /jobleft\.invalid/.test(a.href) || (expectHref && a.href !== new URL(expectHref).href) || (c.apply && c.apply !== a.href)) applyBad.push(`${c.id}: ${JSON.stringify(a)} expected ${expectHref} card ${c.apply}`);
    if (d.chips.some((x) => /no (visa )?sponsorship/i.test(x)) && /nothing about visa sponsorship/i.test(d.visa)) visaBad.push(`${c.id}: chip says no sponsorship, visa section says "nothing about visa sponsorship"`);
    await p.press('Escape');
    await p.waitFor(`!document.querySelector('.jl-detail-card')`, 5000);
  }
  if (!cards.length) { for (const n of ['card-equals-detail', 'band-follows-number', 'why-this-score-three-parts', 'panel-equals-why', 'apply-opens-employer-page', 'visa-section-agrees-with-chip', 'esc-closes-detail', 'score-same-after-reload']) skip(n, 'no cards in the feed'); }
  else {
    check('card-equals-detail', diffs.length === 0, diffs.slice(0, 4).join('; '));
    check('band-follows-number', bandBad.length === 0, bandBad.slice(0, 4).join('; '));
    check('why-this-score-three-parts', whyBad.length === 0, whyBad.slice(0, 3).join('; '));
    check('panel-equals-why', panelBad.length === 0, panelBad.slice(0, 3).join('; '));
    check('apply-opens-employer-page', applyBad.length === 0, applyBad.slice(0, 3).join('; '));
    check('visa-section-agrees-with-chip', visaBad.length === 0, visaBad.slice(0, 3).join('; '));
    check('esc-closes-detail', !(await p.eval(`!!document.querySelector('.jl-detail-card')`)) && /^#\/jobs/.test(await p.eval('location.hash')), `hash ${await p.eval('location.hash')}`);
    // reload: the same percent
    await p.eval('location.reload()');
    await p.waitFor(`document.querySelectorAll('.jl-card').length > 0`, 20000);
    const drift = [];
    for (const s of seen.slice(0, 3)) { await openDetail(s.id); const d = await p.eval(DETAIL); if (d?.pct !== s.pct) drift.push(`${s.id} ${s.pct} -> ${d?.pct}`); }
    check('score-same-after-reload', drift.length === 0, drift.join('; '));
  }

  // ---------- 4. unknown job id ----------
  await nav('#/jobs/' + enc('nosuchboard:nosuchjob:0'), `document.body.innerText.length > 50`);
  await sleep(1500);
  {
    const t = await content();
    const a = await p.eval(AUDIT);
    check('unknown-job-page', /not|removed|exist/i.test(t) && a.banned.length === 0 && !(await p.eval(`!!document.querySelector('.jl-detail-card h1')`)), `text "${t.slice(0, 120)}" banned ${a.banned.join(',')}`);
    await p.press('Escape');
  }

  // ---------- 5. tracker: like, apply, stage moves, notes, reminders ----------
  const free = untracked.slice(1);
  if (free.length < 4) {
    for (const n of ['like-and-apply-from-detail', 'stage-move-by-select', 'stage-move-back', 'notes-reminders-persist-after-reload', 'tracker-columns-equal-api', 'feed-tabs-equal-tracker', 'dashboard-numbers-equal-api', 'dashboard-weekly-sum-equals-applications', 'dashboard-lists-every-open-reminder', 'alerts-lists-every-upcoming-reminder', 'tracker-lists-both-reminders', 'not-applied-keeps-job-tracked']) skip(n, `only ${free.length} untracked jobs`);
  } else {
    const [L, A, I, X] = free;
    for (const j of [L, A, I, X]) touched.add(j.id);
    const stamp = String(Date.now()).slice(-6);
    const NOTE = `QA note ${stamp}: talked to the recruiter`;
    const REM_A = `QA reminder applied ${stamp}`;
    const REM_L = `QA reminder liked ${stamp}`;

    // like L and mark A applied from their detail pages
    await openDetail(L.id);
    await p.click('.jl-actionbar button[aria-label="Like this job"]');
    await p.waitFor(`document.querySelector('.jl-actionbar button[aria-label="Unlike this job"]')`, 8000);
    await openDetail(A.id);
    await p.clickText('Mark as applied');
    await sleep(1200);
    const eL = await getEntry(L.id), eA = await getEntry(A.id);
    check('like-and-apply-from-detail', eL?.liked === true && eA?.status === 'applied' && !!eA?.appliedAt, `liked ${eL?.liked}, applied status ${eA?.status} appliedAt ${eA?.appliedAt}`);

    // reminder + note on A through the screen (reminder first, then wait for the message to go before the note)
    const localWhen = await p.eval(`(() => { const d = new Date(Date.now() + 2 * 864e5); const z = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T10:00'; })()`);
    await toastsGone();
    await setVal('input[aria-label="Reminder date and time"]', localWhen);
    await p.click('input[aria-label="Reminder text"]');
    await p.type(REM_A);
    await sleep(300);
    await toastsGone();
    await p.clickText('Add reminder');
    await p.waitFor(`document.querySelector('#sec-notes')?.innerText.includes(${JSON.stringify(REM_A)})`, 8000);
    await toastsGone();
    await p.click('textarea[aria-label="New note"]');
    await p.type(NOTE);
    await sleep(300);
    await p.clickText('Save note');
    await p.waitFor(`document.querySelector('#sec-notes')?.innerText.includes(${JSON.stringify(NOTE)})`, 8000);
    // reminder on the liked job L (same call the screen makes)
    await api('PATCH', '/tracker/' + enc(L.id), { reminders: [{ at: new Date(Date.now() + 3 * 864e5).toISOString(), text: REM_L, done: false }] });

    // I: like through the API, then move Liked -> Interviewing with the board's select, then back to Applied
    await api('PATCH', '/tracker/' + enc(I.id), { liked: true });
    await nav('#/tracker', `document.querySelectorAll('section.jl-col').length >= 6`);
    await sleep(800);
    const moveBySelect = async (id, label) => {
      const sel = `.jl-mini:has(a[href="#/jobs/${enc(id)}"]) .ant-select-selector`;
      if (!(await p.click(sel))) return false;
      await sleep(400);
      const r = await p.clickMatching('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item', `^${label}$`);
      await sleep(1200);
      return r;
    };
    await moveBySelect(I.id, 'Interviewing');
    const eI = await getEntry(I.id);
    const inCol = await p.eval(`!!document.querySelector('section.jl-col[aria-label^="Interviewing"] a[href="#/jobs/${enc(I.id)}"]')`);
    check('stage-move-by-select', eI?.status === 'interviewing' && inCol, `API status ${eI?.status}, card in Interviewing column: ${inCol}`);
    await moveBySelect(I.id, 'Applied');
    const eI2 = await getEntry(I.id);
    const inCol2 = await p.eval(`!!document.querySelector('section.jl-col[aria-label^="Applied"] a[href="#/jobs/${enc(I.id)}"]')`);
    check('stage-move-back', eI2?.status === 'applied' && inCol2, `API status ${eI2?.status}, card in Applied column: ${inCol2}`);

    // X: applied (API), then "Not applied" on the board: the job must stay somewhere in the tracker
    await api('PATCH', '/tracker/' + enc(X.id), { status: 'applied' });
    await p.eval('location.reload()');
    await p.waitFor(`document.querySelectorAll('section.jl-col').length >= 6`, 20000);
    await sleep(800);
    await moveBySelect(X.id, 'Not applied');
    await p.eval('location.reload()');
    await p.waitFor(`document.querySelectorAll('section.jl-col').length >= 6`, 20000);
    await sleep(800);
    const xVisible = await p.eval(`!!document.querySelector('.jl-mini a[href="#/jobs/${enc(X.id)}"]')`);
    check('not-applied-keeps-job-tracked', xVisible, 'the job left every tracker column after "Not applied" (it was never liked)');

    // reload and verify notes and reminders survived
    await openDetail(A.id);
    await sleep(500);
    const notesTxt = await p.eval(`document.querySelector('#sec-notes')?.innerText ?? ''`);
    const eA2 = await getEntry(A.id);
    check('notes-reminders-persist-after-reload', notesTxt.includes(NOTE) && notesTxt.includes(REM_A) && eA2?.notes?.some((n) => n.text === NOTE) && eA2?.reminders?.some((r) => r.text === REM_A),
      `detail has note ${notesTxt.includes(NOTE)}, reminder ${notesTxt.includes(REM_A)}; API notes ${eA2?.notes?.length}, reminders ${eA2?.reminders?.length}`);
    await p.press('Escape');

    // counts everywhere vs the API
    const verifyCounts = async (suffix) => {
      const st = await trackerState();
      const probs = [];
      await nav('#/tracker', `document.querySelectorAll('section.jl-col').length >= 6`);
      await sleep(1000);
      const cols = await p.eval(`[...document.querySelectorAll('section.jl-col')].map(c => ({ label: c.getAttribute('aria-label'), pill: +c.querySelector('.jl-pill')?.textContent, cards: c.querySelectorAll('.jl-mini').length }))`);
      const want = { 'Liked, not applied': st.likedNotApplied, Applied: st.applied, Interviewing: st.interviewing, 'Offer Received': st.offer, Rejected: st.rejected, Archived: st.archived };
      for (const c of cols) { const k = c.label.split(':')[0]; if (k in want && (c.pill !== want[k] || c.cards !== want[k])) probs.push(`tracker ${k}: pill ${c.pill}, cards ${c.cards}, API ${want[k]}`); }
      const trackerText = await content();
      if (!suffix) { await p.shot(join(SHOTS, 'tracker-board.png')); await audit('tracker'); }
      check('tracker-columns-equal-api' + suffix, probs.length === 0, probs.join('; '));
      // feed tabs
      await nav('#/jobs/applied', `/All \\(\\d/.test(document.querySelector('.jl-list-pane')?.innerText || '') && document.querySelector('.jl-topbar-tabs')`);
      await sleep(800);
      const tabs = await p.eval(`[...document.querySelectorAll('.jl-topbar-tabs a')].map(a => a.getAttribute('aria-label') || '')`);
      const segs = await p.eval(`document.querySelector('.jl-list-pane').innerText.split('\\n').slice(0, 6).join('|')`);
      const tabProbs = [];
      const tabN = (name) => +((tabs.find((t) => t.startsWith(name + ',')) || '').split(',')[1] ?? NaN);
      if (tabN('Liked') !== st.counts.liked) tabProbs.push(`Liked tab ${tabN('Liked')} vs API ${st.counts.liked}`);
      if (tabN('Applied') !== st.applications) tabProbs.push(`Applied tab ${tabN('Applied')} vs API ${st.applications}`);
      for (const [lab, n] of [['All', st.applications], ['Applied', st.applied], ['Interviewing', st.interviewing], ['Offer Received', st.offer], ['Rejected', st.rejected], ['Archived', st.archived]]) if (!segs.includes(`${lab} (${n})`)) tabProbs.push(`segment ${lab} (${n}) missing in "${segs}"`);
      check('feed-tabs-equal-tracker' + suffix, tabProbs.length === 0, tabProbs.join('; '));
      // dashboard
      await nav('#/dashboard', `/\\d\\nApplications/.test(document.querySelector('.jl-content')?.innerText || '') && document.body.innerText.includes('Next reminders')`, 20000);
      await sleep(1500);
      const d = await content();
      const tile = (name) => +((new RegExp('([\\d,]+)\\n' + name + '\\n').exec(d) || [])[1] || 'NaN').replace(/,/g, '');
      const stagePart = d.split('Your applications by stage')[1]?.split('Applications per week')[0] ?? '';
      const stageNum = (name) => +((new RegExp('\\n' + name + '\\n(\\d+)').exec('\n' + stagePart) || [])[1] ?? NaN);
      const dProbs = [];
      if (tile('Applications') !== st.applications) dProbs.push(`Applications ${tile('Applications')} vs ${st.applications}`);
      if (tile('Interviewing') !== st.interviewing) dProbs.push(`Interviewing ${tile('Interviewing')} vs ${st.interviewing}`);
      if (tile('Offers') !== st.offer) dProbs.push(`Offers ${tile('Offers')} vs ${st.offer}`);
      if (tile('Liked') !== st.liked) dProbs.push(`Liked ${tile('Liked')} vs ${st.liked}`);
      for (const [lab, n] of [['Applied', st.applied], ['Interviewing', st.interviewing], ['Offer Received', st.offer], ['Rejected', st.rejected], ['Archived', st.archived]]) if (stageNum(lab) !== n) dProbs.push(`stage ${lab} ${stageNum(lab)} vs ${n}`);
      check('dashboard-numbers-equal-api' + suffix, dProbs.length === 0, dProbs.join('; '));
      if (!suffix) {
        const lines = (d.split('Applications per week')[1]?.split('Next reminders')[0] ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
        let weekSum = 0;
        for (let i = 0; i < lines.length - 1; i++) if (/^\d+$/.test(lines[i]) && /^[A-Z][a-z]{2} \d{1,2}$/.test(lines[i + 1])) weekSum += +lines[i];
        check('dashboard-weekly-sum-equals-applications', weekSum === st.applications, `weekly bars add up to ${weekSum}, Applications is ${st.applications}`);
        const next = d.split('Next reminders')[1]?.split('Job boards')[0] ?? '';
        check('dashboard-lists-every-open-reminder', next.includes(REM_A) && next.includes(REM_L), `applied-job reminder shown: ${next.includes(REM_A)}, liked-job reminder shown: ${next.includes(REM_L)}`);
        check('tracker-lists-both-reminders', trackerText.includes(REM_A) && trackerText.includes(REM_L), `applied ${trackerText.includes(REM_A)}, liked ${trackerText.includes(REM_L)}`);
        await p.shot(join(SHOTS, 'tracker-dashboard.png'));
        await audit('dashboard');
        await nav('#/notifications', `document.body.innerText.includes('Coming up')`);
        await sleep(1500);
        const al = await content();
        check('alerts-lists-every-upcoming-reminder', al.includes(REM_A) && al.includes(REM_L), `applied-job reminder shown: ${al.includes(REM_A)}, liked-job reminder shown: ${al.includes(REM_L)}`);
        await p.shot(join(SHOTS, 'tracker-alerts.png'));
        await audit('alerts');
      }
    };
    await verifyCounts('');
    await p.eval('location.reload()');
    await p.waitFor(`document.body.innerText.length > 50`, 20000);
    await verifyCounts('-after-reload');
  }
  check('banned-words', banned.length === 0, banned.slice(0, 5).join(' | '));
  const errs = p.errors().filter((e) => !/favicon/i.test(e));
  check('no-page-errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  fail('scenario-crashed', e?.stack || e);
} finally {
  // undo what this scenario changed
  for (const id of touched) { try { await api('PATCH', '/tracker/' + enc(id), { liked: false, status: null, notes: [], reminders: [] }); } catch {} }
  await b.close();
}
console.log(`tracker scenario finished in ${Math.round((Date.now() - T0) / 1000)} s, ${failed} failed`);
process.exit(failed ? 1 : 0);
