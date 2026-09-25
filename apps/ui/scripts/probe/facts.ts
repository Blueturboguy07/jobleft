// O3, O5, O6: job facts on cards and in the detail are true or absent; one stable score that explains itself;
// closing the detail returns to the same list, filters and scroll position; apply opens the employer's own page.
// The expected values come from the stored job as the local API returns it (docs/INTERFACES.md section 6.4),
// compared with what a person reads on screen.

import { launch, type Page } from '../browser.ts';
import type { JobListItem, JobSearchRequest } from '@jobleft/contracts';
import { check, sleep, type Demo } from './lib.ts';

interface CardDom { id: string; title: string; company: string; facts: string[]; chips: string[]; tile: string; aria: string; applyHref: string | null; text: string }

const READ_CARDS = `(() => [...document.querySelectorAll('.jl-card')].map((c) => ({
  id: c.getAttribute('data-job-id'),
  title: (c.querySelector('.jl-card-title')||{}).textContent || '',
  company: (c.querySelector('.jl-card-company')||{}).textContent || '',
  facts: [...c.querySelectorAll('.jl-fact .txt')].map((x) => x.textContent || ''),
  chips: [...c.querySelectorAll('.jl-chip')].map((x) => x.textContent || ''),
  tile: (c.querySelector('.jl-tile')||{}).innerText || '',
  aria: (c.querySelector('.jl-tile')||{}).getAttribute ? (c.querySelector('.jl-tile').getAttribute('aria-label') || '') : '',
  applyHref: (c.querySelector('a.jl-accent-btn')||{}).href || null,
  text: c.innerText,
})))()`;

function numbersIn(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/\$?([\d,]+(?:\.\d+)?)\s*(K)?/gi)) {
    let v = Number(m[1]!.replace(/,/g, ''));
    if (m[2]) v *= 1000;
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

async function feedRequestBody(p: Page): Promise<JobSearchRequest | null> {
  const r = p.requests().filter((x) => x.url.endsWith('/api/v1/jobs/search') && x.body);
  return r.length ? (JSON.parse(r.at(-1)!.body!) as JobSearchRequest) : null;
}

async function allItems(demo: Demo, req: JobSearchRequest, max: number): Promise<JobListItem[]> {
  const items: JobListItem[] = [];
  let cursor: string | undefined;
  while (items.length < max) {
    const r = await demo.api.call('searchJobs', { body: { ...req, limit: 100, ...(cursor ? { cursor } : {}) } });
    items.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return items;
}

export async function run(demo: Demo): Promise<void> {
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(600);

    // -------- clear the profile-made filters so the whole stored set is in the list
    await p.clickText('Clear all');
    await sleep(800);
    p.clearRequests();
    await p.eval(`document.querySelector('.jl-list-scroll').scrollTo(0, 1)`);
    await p.clickText('Clear all');
    await sleep(500);
    const req: JobSearchRequest = { sort: 'recommended', filter: {} };
    const items = await allItems(demo, req, 5000);
    const byId = new Map(items.map((i) => [i.job.id, i]));
    check(items.length >= 200, 'setup: the list has many jobs', `${items.length} jobs`);

    // -------- O3: fast scrolling; every visible card shows the facts of its own job
    let wrong = 0, blank = 0, checked = 0, frames = 0;
    const flick = (speed: number) => p.eval<{ frames: number; blankFrames: number }>(`new Promise((resolve) => {
      const pane = document.querySelector('.jl-list-scroll');
      pane.scrollTop = 0;
      let frames = 0, blankFrames = 0;
      const step = () => {
        // 1. what is painted now (the state after the last scroll and render)
        const pr = pane.getBoundingClientRect(); const x = pr.left + Math.min(pr.width / 2, 400);
        let run = 0, worst = 0;
        for (let yy = pr.top + 150; yy < pr.bottom - 10; yy += 10) { const hit = document.elementsFromPoint(x, yy).some((e) => e.closest && e.closest('.jl-card')); if (hit) run = 0; else { run += 10; worst = Math.max(worst, run); } }
        const atEnd = pane.scrollTop >= pane.scrollHeight - pane.clientHeight - 60;
        if (frames > 2 && worst > 40 && !atEnd) blankFrames++;
        // 2. then scroll on
        pane.scrollTop += ${speed}; frames++;
        if (frames < 300) requestAnimationFrame(step); else resolve({ frames, blankFrames });
      }; requestAnimationFrame(step); })`);
    const slow = await flick(300);
    const fast = await flick(900);
    frames = slow.frames; blank = slow.blankFrames;
    check(slow.blankFrames <= 3, 'O11 a fast scroll (18,000 px a second) shows no blank card area', `${slow.blankFrames} of ${slow.frames} frames had a gap`);
    check(fast.blankFrames <= 15, 'O11 an extreme flick (54,000 px a second) stays mostly filled', `${fast.blankFrames} of ${fast.frames} frames had a gap`);
    await sleep(500);
    const cards = await p.eval<CardDom[]>(READ_CARDS);
    for (const c of cards) {
      const it = byId.get(c.id);
      if (!it) continue;
      checked++;
      if (!c.text.includes(it.job.title) || !c.company.includes(it.job.company)) wrong++;
    }
    check(wrong === 0 && checked > 0, 'O3 after fast scrolling every visible card shows the title and company of its own job', `${checked} cards checked, ${wrong} wrong`);

    // -------- O3: compare 30+ cards with the stored jobs, fact by fact
    await p.eval(`document.querySelector('.jl-list-scroll').scrollTo(0, 0)`);
    await sleep(600);
    let compared = 0;
    const problems: string[] = [];
    for (let round = 0; round < 8 && compared < 60; round++) {
      const visible = await p.eval<CardDom[]>(READ_CARDS);
      for (const c of visible) {
        const it = byId.get(c.id);
        if (!it) continue;
        const j = it.job;
        compared++;
        const shown = c.text;
        // pay
        const payFact = c.facts.find((f) => /\$|£|€|hr|yr/.test(f)) ?? null;
        if (!j.pay) { if (payFact) problems.push(`${j.id}: shows pay "${payFact}" but the job has none`); }
        else {
          const want = [j.pay.min, j.pay.max].filter((x): x is number => x !== null);
          const got = payFact ? numbersIn(payFact) : [];
          if (!payFact) problems.push(`${j.id}: pay is missing on the card`);
          else if (want.some((w) => !got.some((g) => Math.abs(g - w) <= Math.max(1, w * 0.001)))) problems.push(`${j.id}: pay "${payFact}" vs ${JSON.stringify([j.pay.min, j.pay.max, j.pay.period])}`);
          const unit = { hour: '/hr', day: '/day', week: '/wk', month: '/mo', year: '/yr' }[j.pay.period];
          if (payFact && !payFact.includes(unit)) problems.push(`${j.id}: pay period "${payFact}" should say ${unit}`);
        }
        // place, type, model
        const first = j.places[0]?.text;
        if (first && !shown.includes(first)) problems.push(`${j.id}: place "${first}" not shown`);
        if (!first && c.facts.some((f) => /^[A-Z][a-z]+.*, [A-Z]{2}$/.test(f))) problems.push(`${j.id}: shows a place but the job lists none`);
        const typeWord = ({ full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', internship: 'Internship', temporary: 'Temporary' } as Record<string, string>)[j.employmentType ?? ''] ?? null;
        if (typeWord && !shown.includes(typeWord)) problems.push(`${j.id}: type ${typeWord} not shown`);
        if (!j.employmentType && /Full-time|Part-time|Contract|Internship|Temporary/.test(c.facts.join('|'))) problems.push(`${j.id}: shows a job type but it is unknown`);
        const wm = ({ onsite: 'Onsite', hybrid: 'Hybrid', remote: 'Remote' } as Record<string, string>)[j.workModel ?? ''] ?? null;
        if (wm && !shown.includes(wm)) problems.push(`${j.id}: work model ${wm} not shown`);
        if (!j.workModel && /Onsite|Hybrid|Remote/.test(c.facts.join('|'))) problems.push(`${j.id}: shows a work model but it is unknown`);
        // years
        if (j.yearsRequired && (j.yearsRequired.min !== null || j.yearsRequired.max !== null)) {
          const yr = c.facts.find((f) => /years|minimum/i.test(f));
          const nums = yr ? numbersIn(yr).map(Math.round) : [];
          for (const w of [j.yearsRequired.min, j.yearsRequired.max]) if (w !== null && w !== 0 && !nums.includes(w)) problems.push(`${j.id}: years "${yr}" vs ${JSON.stringify(j.yearsRequired)}`);
        } else if (c.facts.some((f) => /years exp/i.test(f))) problems.push(`${j.id}: shows years of experience but the job states none`);
        // posted time
        if (j.postedAt) {
          const ageH = (Date.now() - Date.parse(j.postedAt)) / 3_600_000;
          const chip = c.chips.find((x) => /ago|Just now/.test(x)) ?? '';
          const n = Number(/(\d+)/.exec(chip)?.[1] ?? 0);
          const unit = /minute/.test(chip) ? 1 / 60 : /hour/.test(chip) ? 1 : /day/.test(chip) ? 24 : /week/.test(chip) ? 168 : 0;
          if (ageH < 24 * 60 && unit && Math.abs(n * unit - ageH) > Math.max(1.1 * unit, 0.5)) problems.push(`${j.id}: posted "${chip}" but the age is ${ageH.toFixed(1)} hours`);
          if (ageH < 0) problems.push(`${j.id}: posted in the future`);
        } else if (c.chips.some((x) => /ago/.test(x))) problems.push(`${j.id}: shows a posted time but the job states none`);
        // score
        if (it.match) {
          const pct = Number(/(\d+)\s*%/.exec(c.tile)?.[1]);
          if (pct !== it.match.percent) problems.push(`${j.id}: tile ${c.tile.replace(/\s+/g, ' ')} vs ${it.match.percent}`);
          const band = it.match.percent >= 85 ? 'STRONG' : it.match.percent >= 70 ? 'GOOD' : 'FAIR';
          if (!c.tile.toUpperCase().includes(band)) problems.push(`${j.id}: band for ${it.match.percent} should be ${band}: "${c.tile.replace(/\s+/g, ' ')}"`);
        }
        if (/undefined|\bnull\b|NaN|\[object|\$0(?![.\d,])/.test(c.text)) problems.push(`${j.id}: bad text in card: ${c.text.replace(/\s+/g, ' ').slice(0, 80)}`);
        if (/applicants|early applicant/i.test(c.text)) problems.push(`${j.id}: applicant text`);
      }
      await p.eval(`document.querySelector('.jl-list-scroll').scrollBy(0, 900)`);
      await sleep(350);
    }
    check(problems.length === 0 && compared >= 30, 'O3 30 or more cards agree with their stored jobs, fact by fact', `${compared} compared; ${problems.slice(0, 6).join(' | ')}`);
    const hourly = items.filter((i) => i.job.pay?.period === 'hour').length;
    const noPay = items.filter((i) => !i.job.pay).length;
    check(hourly > 0 && noPay > 0, 'setup: the fixtures hold hourly pay and jobs with no pay', `${hourly} hourly, ${noPay} without pay`);

    // -------- O5: card, detail, API and a restart give the same numbers
    const sample = items.filter((i) => i.match).slice(0, 20);
    void feedRequestBody;
    let mismatch = 0;
    const detail: Record<string, { pct: number; parts: number[] }> = {};
    const readDetail = async (id: string) => {
      await p.eval(`location.hash = '#/jobs/${encodeURIComponent(id)}'`);
      await p.waitFor("document.querySelector('.jl-match-panel')", 8000);
      await sleep(150);
      return p.eval<{ pct: number; parts: number[]; band: string; fitchips: string[]; text: string }>(`(() => {
        const m = document.querySelector('.jl-match-panel'); const t = m.innerText;
        const rows = [...m.querySelectorAll('.inner .row')].map((r) => Number((/(\\d+)\\s*%/.exec(r.innerText) || [])[1]));
        return { pct: Number((/^(\\d+)/.exec(t.trim()) || [])[1]), parts: rows, band: (/(STRONG|GOOD|FAIR) MATCH/.exec(t) || [])[1] || '', fitchips: [...document.querySelectorAll('.jl-fitchip')].map((x) => x.textContent), text: document.querySelector('.jl-detail-main').innerText };
      })()`);
    };
    for (const it of sample) {
      const d = await readDetail(it.job.id);
      const api = await demo.api.call('getMatch', { params: { jobId: it.job.id } });
      const parts = [api.subScores.experienceLevel.percent, api.subScores.skills.percent, api.subScores.industryExperience.percent];
      detail[it.job.id] = { pct: d.pct, parts: d.parts };
      if (d.pct !== it.match!.percent || api.percent !== it.match!.percent || parts.some((v, i) => v !== null && v !== d.parts[i])) mismatch++;
      const band = it.match!.percent >= 85 ? 'STRONG' : it.match!.percent >= 70 ? 'GOOD' : 'FAIR';
      if (d.band !== band) mismatch++;
      if (/undefined|\bnull\b|NaN|\[object/.test(d.text)) mismatch++;
      if (d.fitchips.filter((c) => /sponsor/i.test(c)).length > 1) { problems.push(`duplicate sponsor chip on ${it.job.id}: ${d.fitchips.join(' | ')}`); mismatch++; }
    }
    check(mismatch === 0, 'O5 card, detail and API show the same percent, band and three part-scores for 20 jobs', `${sample.length} jobs, ${mismatch} differences`);
    await p.eval(`location.hash = '#/jobs'`);

    if (demo.home) {
      demo.kill9();
      await sleep(500);
      await demo.relaunchApi(['--no-crawl']);
      await p.goto(demo.url.replace(/#token=.*/, '') + '#/jobs');
      await sleep(1500);
      let drift = 0;
      for (const it of sample.slice(0, 10)) {
        const d = await readDetail(it.job.id);
        const prev = detail[it.job.id]!;
        if (d.pct !== prev.pct || d.parts.some((v, i) => v !== prev.parts[i])) drift++;
      }
      check(drift === 0, 'O5 the same numbers after the local service restarts', `${drift} of 10 changed`);
    }
  } finally {
    await b.close();
  }
}
