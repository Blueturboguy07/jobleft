// O1 and O2: every screen exists, is at most two clicks from any other, and shows real content; no other
// company's name or marketing text anywhere (screen text, tooltips, window titles, spoken labels, image alt text).

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { launch, type Page } from '../browser.ts';
import { check, sleep, type Demo } from './lib.ts';

const TARGETS: Array<[string, RegExp]> = [
  ['Jobs Recommended', /^#\/jobs$/], ['Liked', /^#\/jobs\/liked$/], ['Applied', /^#\/jobs\/applied$/], ['External', /^#\/jobs\/external$/],
  ['Tracker', /^#\/tracker$/], ['Dashboard', /^#\/dashboard$/], ['Resume', /^#\/resume$/], ['Profile', /^#\/profile$/], ['Network', /^#\/network(\/companies)?$/],
  ['Assistant', /^#\/assistant$/], ['Interview', /^#\/interview$/], ['Notifications', /^#\/notifications$/],
  ['Settings AI', /^#\/settings(\/ai)?$/], ['Settings balance', /^#\/settings\/balance$/], ['Settings alerts', /^#\/settings\/alerts$/], ['Settings sources', /^#\/settings\/sources$/],
  ['Settings data', /^#\/settings\/data$/],
];

const CANDIDATES = `(() => {
  const out = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[inert],[aria-hidden=true]'); };
  let i = 0;
  for (const e of document.querySelectorAll('a[href^="#/"], .ant-menu-item, .ant-tabs-tab, [role=tab]')) {
    if (!vis(e)) continue;
    e.setAttribute('data-nav-probe', String(i));
    out.push({ i: i++, label: (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40), href: e.getAttribute('href') });
  }
  return out; })()`;

async function hashOf(p: Page): Promise<string> { return p.eval<string>('location.hash'); }

/** All hashes reachable by one click from the current screen. */
async function oneClick(p: Page, start: string): Promise<Set<string>> {
  const seen = new Set<string>();
  await p.eval(`location.hash = ${JSON.stringify(start)}`);
  await sleep(500);
  const cands = await p.eval<Array<{ i: number; label: string; href: string | null }>>(CANDIDATES);
  for (const c of cands) {
    if (c.href && c.href.startsWith('#/')) { seen.add(c.href); continue; }
    await p.eval(`location.hash = ${JSON.stringify(start)}`);
    await sleep(120);
    await p.eval(CANDIDATES);
    if (await p.click(`[data-nav-probe="${c.i}"]`)) { await sleep(250); seen.add(await hashOf(p)); }
  }
  return seen;
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-shell, .jl-onboard')", 15000);
    await sleep(800);

    // a job and a resume to start from
    const list = await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 5 } });
    const jobId = list.items[0]?.job.id;
    let resumes = await demo.api.call('listResumes');
    if (!resumes.length) { await demo.api.call('createResume', { body: { name: 'Main resume' } }); resumes = await demo.api.call('listResumes'); }
    const starts = ['#/jobs', '#/settings/data', `#/resume/${resumes[0]!.id}`, `#/jobs/${encodeURIComponent(jobId ?? '')}`];
    for (const start of starts) {
      const first = await oneClick(p, start);
      const reach = new Set(first);
      for (const h of first) {
        if (!h.startsWith('#/') || h === start) continue;
        for (const x of await oneClick(p, h)) reach.add(x);
      }
      const missing = TARGETS.filter(([, re]) => ![...reach].some((h) => re.test(h))).map(([n]) => n);
      check(missing.length === 0, `O1 every main screen is at most two clicks from ${start.replace(/\/[^/]*%[^/]*$/, '/<job>')}`, missing.length ? `not reached: ${missing.join(', ')}` : `${reach.size} places reached`);
    }

    // every screen: titled, real content or designed empty state, no endless loader
    const screens = ['jobs', 'jobs/liked', 'jobs/applied', 'jobs/external', 'jobs/hidden', 'tracker', 'dashboard', 'resume', 'profile', 'network', 'network/people', 'network/plan', 'interview', 'assistant', 'notifications',
      'settings/ai', 'settings/balance', 'settings/alerts', 'settings/sources', 'settings/data', 'settings/extension', 'settings/about', 'onboarding', 'no-such-screen'];
    for (const s of screens) {
      await p.eval(`location.hash = ${JSON.stringify(`#/${s}`)}`);
      await sleep(400);
      const done = await p.waitFor("!document.querySelector('.ant-spin-spinning, .jl-skel')", 8000);
      const info = await p.eval<{ h1: string; text: number; title: string; btn: number }>(`(() => ({ h1: (document.querySelector('h1,h2')||{}).textContent || '', text: document.body.innerText.trim().length, title: document.title, btn: document.querySelectorAll('button,a').length }))()`);
      check(done && info.h1.trim().length > 0 && info.text > 60, `O1 screen ${s} has a title and content and no endless loader`, `title="${info.h1.trim().slice(0, 30)}" window="${info.title}" text=${info.text}`);
      check(/jobleft/i.test(info.title), `O2 window title of ${s} names jobleft`, info.title);
    }
  } finally {
    await b.close();
  }
  void join;
}
