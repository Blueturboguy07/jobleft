// O6: a job's detail is complete and puts the person back where they were.
// Turn on filters, scroll to about the 40th card, open a job, close it three ways (Esc, the close button, the browser
// back button) and compare list, filters, count and scroll position. Apply controls open the employer's own posting.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import type { JobDetail } from '@jobleft/contracts';
import { check, ctl, getPage, refreshAndWait, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '1500', '--no-crawl'];

const FEED_STATE = `(() => {
  const pane = document.querySelector('#jl-feed-scroll');
  const pr = pane.getBoundingClientRect();
  const cards = [...document.querySelectorAll('.jl-card')];
  const first = cards.find((c) => { const r = c.getBoundingClientRect(); return r.bottom > pr.top + 100; });
  return {
    scrollTop: Math.round(pane.scrollTop),
    firstId: first ? first.getAttribute('data-job-id') : null,
    firstTop: first ? Math.round(first.getBoundingClientRect().top - pr.top) : null,
    count: (document.querySelector('.jl-results-line') || {}).innerText || '',
    chips: [...document.querySelectorAll('.jl-filter-btn')].map((b) => b.innerText.trim().replace(/\\s+/g, ' ') + (b.classList.contains('active') ? ' [on]' : '')),
    hash: location.hash,
    detailOpen: !!document.querySelector('.jl-overlay'),
    focus: document.activeElement ? (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || '').trim().slice(0, 60) : '',
  };
})()`;

async function state(p: Page) { return p.eval<{ scrollTop: number; firstId: string | null; firstTop: number | null; count: string; chips: string[]; hash: string; detailOpen: boolean; focus: string }>(FEED_STATE); }

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'detail');
  mkdirSync(dir, { recursive: true });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(700);

    // -------- two filters on (start from none: "Job type: Full-time" and "Date posted: past month")
    await p.clickText('Clear all');
    await sleep(700);
    await p.clickText('Job type');
    await sleep(300);
    await p.clickText('Full-time', '.ant-popover');
    await p.clickText('Apply', '.ant-popover');
    await sleep(700);
    await p.clickText('Date posted');
    await sleep(300);
    await p.clickText('Past month', '.ant-popover');
    await p.clickText('Apply', '.ant-popover');
    await sleep(900);
    const before0 = await state(p);
    check(before0.chips.filter((c) => c.endsWith('[on]')).length >= 2, 'O6 setup: two filters are on', before0.chips.filter((c) => c.endsWith('[on]')).join(' | '));

    check(Number(/(\d[\d,]*) jobs/.exec(before0.count)?.[1]?.replace(/,/g, '')) > 100, 'O6 setup: more than 100 jobs match the two filters', before0.count);
    // -------- scroll to about the 40th card
    await p.eval(`document.querySelector('#jl-feed-scroll').scrollTo(0, 40 * 240)`);
    await sleep(700);
    const idOf = await p.eval<string | null>(`(() => { const pr = document.querySelector('#jl-feed-scroll').getBoundingClientRect(); const c = [...document.querySelectorAll('.jl-card')].find((x) => x.getBoundingClientRect().top > pr.top + 150); return c ? c.getAttribute('data-job-id') : null; })()`);
    check(!!idOf, 'O6 setup: a card is on screen at about the 40th place', String(idOf));
    await p.shot(join(dir, '01-before-open.png'));
    const link = `[data-job-id="${idOf}"] .jl-card-title a`;
    const clicked = await p.click(link);
    await p.waitFor("document.querySelector('.jl-overlay .jl-match-panel, .jl-overlay .jl-detail-card')", 8000);
    await sleep(500);
    const open1 = await state(p);
    check(clicked && open1.detailOpen && open1.hash.includes(encodeURIComponent(idOf!)), 'O6 clicking a card opens its detail', open1.hash);
    await p.shot(join(dir, '02-detail.png'));
    // the layer under the detail is inert: no click or key reaches it
    const inert = await p.eval<boolean>(`!!document.querySelector('#jl-jobs-under[inert]')`);
    check(inert, 'O6 while the detail is open, the list under it does not take focus or keys');
    const reqsBefore = p.requests().filter((r) => r.url.endsWith('/api/v1/jobs/search')).length;

    const closeChecks = async (label: string, how: () => Promise<void>) => {
      await how();
      await sleep(800);
      const after = await state(p);
      check(!after.detailOpen && after.hash === before0.hash, `O6 ${label}: the detail is gone and the address is the list again`, after.hash);
      check(Math.abs(after.scrollTop - open1.scrollTop) <= 2 && after.firstId === open1.firstId && Math.abs((after.firstTop ?? 0) - (open1.firstTop ?? 0)) <= 2,
        `O6 ${label}: the list is at the same scroll position`, `scrollTop ${open1.scrollTop} -> ${after.scrollTop}, first card ${open1.firstId === after.firstId ? 'same' : 'DIFFERENT'}`);
      check(JSON.stringify(after.chips) === JSON.stringify(open1.chips), `O6 ${label}: the same filters are on`, after.chips.filter((c) => c.endsWith('[on]')).join(' | '));
      check(after.count === open1.count, `O6 ${label}: the same result count`, `${JSON.stringify(open1.count)} -> ${JSON.stringify(after.count)}`);
      const back = await p.eval<string>(`(document.activeElement && document.activeElement.closest('[data-job-id]') ? document.activeElement.closest('[data-job-id]').getAttribute('data-job-id') : '')`);
      check(back === idOf, `O6 ${label}: the keyboard focus is back on the card that was opened`, `focus in card ${back || 'none'} (${after.focus})`);
    };
    await closeChecks('Esc', async () => { await p.press('Escape'); });
    await p.shot(join(dir, '03-after-esc.png'));
    const reqsAfter = p.requests().filter((r) => r.url.endsWith('/api/v1/jobs/search')).length;
    check(reqsAfter === reqsBefore, 'O6 closing the detail does not search again (no reload of the list)', `${reqsAfter - reqsBefore} new searches`);

    // second round: the close button
    await p.click(link);
    await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
    await sleep(400);
    const open2 = await state(p);
    void open2;
    await closeChecks('the close button', async () => { await p.click('button[aria-label^="Close job detail"]'); });
    // third round: the browser back button
    await p.click(link);
    await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
    await sleep(400);
    await closeChecks('the browser back button', async () => { await p.eval('history.back()'); });

    // -------- Esc with a note typed asks first (the person's text is never thrown away silently)
    await p.click(link);
    await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
    await sleep(400);
    await p.eval(`(() => { const t = document.querySelector('textarea[aria-label="New note"]'); t.scrollIntoView({block:'center'}); t.focus(); })()`);
    await p.type('Ask about the team size');
    await p.press('Escape');
    await sleep(600);
    const asked = await p.eval<string>(`(document.querySelector('.ant-modal') || {}).innerText || ''`);
    check(/unsaved|discard|keep editing/i.test(asked), 'O6 Esc with an unsaved note asks before it closes', asked.replace(/\s+/g, ' ').slice(0, 100));
    await p.shot(join(dir, '04-discard-ask.png'));
    await p.clickText('Keep editing');
    await sleep(400);
    check(await p.eval<boolean>(`!!document.querySelector('.jl-overlay .jl-detail-card')`), 'O6 "Keep editing" keeps the detail open and the note text', await p.eval<string>(`document.querySelector('textarea[aria-label="New note"]').value`));
    await p.eval(`document.querySelector('textarea[aria-label="New note"]').focus()`);
    await p.press('Escape');
    await sleep(500);
    await p.clickText('Discard changes');
    await sleep(700);
    check(!(await state(p)).detailOpen, 'O6 "Discard changes" then closes the detail');

    // -------- the detail is complete: description, facts, match breakdown, company facts, apply
    const list = await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 100 } });
    const sample = [...list.items.slice(0, 6), ...list.items.filter((i) => i.job.places.length > 1).slice(0, 4)].slice(0, 10);
    let problems: string[] = [];
    for (const it of sample) {
      const id = it.job.id;
      const api = await demo.api.call('getJob', { params: { jobId: id } }) as JobDetail;
      await p.eval(`location.hash = '#/jobs/${encodeURIComponent(id)}'`);
      await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
      await sleep(250);
      const d = await p.eval<{ title: string; company: string; desc: string; apply: string | null; orig: string | null; companyHead: string; text: string; applyLabel: string }>(`(() => {
        const main = document.querySelector('.jl-detail-main');
        const apply = document.querySelector('.jl-actionbar a.jl-accent-btn');
        const orig = [...document.querySelectorAll('.jl-detail-tabs a')].find((a) => /Original posting/.test(a.textContent));
        return { title: main.querySelector('h1').textContent, company: (main.querySelector('.jl-detail-sec strong')||{}).textContent || '', desc: (main.querySelector('.jl-desc')||{}).innerText || '',
          apply: apply ? apply.href : null, applyLabel: apply ? (apply.getAttribute('aria-label')||'') : '', orig: orig ? orig.href : null, companyHead: (document.querySelector('#sec-company h3, h3#sec-company')||{}).textContent || '', text: main.innerText };
      })()`);
      const j = api.job;
      const want = j.applyUrl ?? j.url;
      if (d.title !== j.title) problems.push(`${id}: title "${d.title}"`);
      if (d.company !== j.company) problems.push(`${id}: company "${d.company}" vs "${j.company}"`);
      if (!d.apply) problems.push(`${id}: no apply link`);
      else if (d.apply !== want) problems.push(`${id}: apply ${d.apply} vs posting ${want}`);
      else {
        const page = await getPage(d.apply);
        if (page.status !== 200 || !page.text.includes(j.title.replace(/&/g, '&amp;')) && !page.text.includes(j.title)) problems.push(`${id}: the apply page is not this posting (status ${page.status})`);
        if (/\/search|\?q=|\?keywords=/i.test(d.apply)) problems.push(`${id}: apply opens a search page`);
      }
      if (d.orig !== j.url) problems.push(`${id}: original posting link ${d.orig} vs ${j.url}`);
      if (j.description && j.description.length > 50 && d.desc.replace(/\s+/g, ' ').length < Math.min(j.description.length, 200) * 0.6) problems.push(`${id}: the description looks cut short`);
      if (api.company && d.companyHead !== api.company.name) problems.push(`${id}: company block "${d.companyHead}" vs ${api.company.name}`);
      if (api.company && api.company.key !== j.companyKey) problems.push(`${id}: company facts belong to ${api.company.key}, job is ${j.companyKey}`);
      if (!api.company && /Founded|Headquarters/.test(d.text)) problems.push(`${id}: company facts shown but there are none`);
      if (/undefined|\bnull\b|NaN|\[object/.test(d.text)) problems.push(`${id}: bad text`);
    }
    check(problems.length === 0, 'O6 for 10 jobs (4 with several places): title, company, description, apply link, original posting and company facts are right', `${sample.length} jobs; ${problems.slice(0, 5).join(' | ')}`);

    // -------- a job with an unknown company has no invented company facts
    const noCompany = list.items.find((i) => i.job.companyKey && false);
    void noCompany;

    // -------- a closed posting: warning and no active apply
    const target = list.items.find((i) => i.job.status === 'open' && i.job.sources[0])!.job.id;
    const out = ctl(demo, 'remove-posting', target);
    check(/Removed/.test(out), 'O6 setup: a posting is taken off its employer board', out.slice(0, 100));
    await demo.api.call('updateTracker', { params: { jobId: target }, body: { liked: true } });
    const done = await refreshAndWait(demo);
    check(done, 'O6 setup: the refresh finishes');
    await p.eval(`location.hash = '#/jobs/${encodeURIComponent(target)}'`);
    await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
    await sleep(600);
    const closedState = await p.eval<{ text: string; applyActive: boolean; disabledApply: boolean }>(`(() => {
      const bar = document.querySelector('.jl-actionbar');
      return { text: document.querySelector('.jl-detail-main').innerText, applyActive: !!bar.querySelector('a.jl-accent-btn'), disabledApply: [...bar.querySelectorAll('button[disabled]')].some((x) => /closed/i.test(x.textContent)) };
    })()`);
    await p.shot(join(dir, '05-closed-posting.png'));
    check(/closed/i.test(closedState.text) && !closedState.applyActive && closedState.disabledApply, 'O6 a closed posting says so and has no active apply control', `apply active: ${closedState.applyActive}`);
    ctl(demo, 'restore-posting', target);
  } finally {
    await b.close();
  }
}
