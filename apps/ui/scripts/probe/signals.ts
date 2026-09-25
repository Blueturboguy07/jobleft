// O4: the app never shows signals it cannot back up: applicant counts, "early applicant" badges, claims about where
// else a job is listed, or "does not sponsor" from a missing record. Sponsorship shows only as a hedged "likely" with
// its public data source (and the date of that data).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import type { JobDetail } from '@jobleft/contracts';
import { check, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '1500', '--no-crawl'];

const BANNED: Array<[string, RegExp]> = [
  ['applicants', /applicants?\b/i], ['early applicant', /early applicant/i], ['top applicant', /top applicant/i],
  ['not visible on', /not visible on/i], ['No H-1B', /no h-?1b/i], ['does not sponsor', /does not sponsor|doesn't sponsor|will not sponsor/i],
  ['listed elsewhere', /only listed here|exclusive(ly)? (here|on)|not listed (on|elsewhere)|also listed on|listed on \w+/i],
  ['applied so far', /\d+\s+(people|others|candidates)\s+(have\s+)?applied/i],
];

function scan(text: string, where: string, hits: string[]): void {
  for (const [name, re] of BANNED) { const m = re.exec(text); if (m) hits.push(`${where}: "${name}" -> …${text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}…`); }
}

async function cardsText(p: Page): Promise<string[]> {
  return p.eval<string[]>(`[...document.querySelectorAll('.jl-card')].map((c) => c.innerText + ' ' + [...c.querySelectorAll('[aria-label],[title]')].map((e) => (e.getAttribute('aria-label')||'') + ' ' + (e.getAttribute('title')||'')).join(' '))`);
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'signals');
  mkdirSync(dir, { recursive: true });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(700);
    await p.clickText('Clear all');
    await sleep(900);

    // -------- the feed: 80 cards, every chip, every tooltip that a keyboard can reach
    const hits: string[] = [];
    let seen = 0, likelyCards = 0, badLikely: string[] = [];
    for (let round = 0; round < 12; round++) {
      const texts = await cardsText(p);
      seen += texts.length;
      for (const t of texts) {
        scan(t, 'feed card', hits);
        if (/H-1B/i.test(t)) {
          likelyCards++;
          if (/H-1B\s+sponsor(?!\s+likely)/i.test(t)) badLikely.push(t.replace(/\s+/g, ' ').slice(0, 80));
        }
      }
      await p.eval(`document.querySelector('#jl-feed-scroll').scrollBy(0, 720)`);
      await sleep(250);
    }
    check(hits.length === 0, 'O4 the feed shows no applicant counts, early-applicant badges or "listed elsewhere" claims', `${seen} card views; ${hits.slice(0, 3).join(' | ')}`);
    check(likelyCards > 0 && badLikely.length === 0, 'O4 every sponsorship chip on a card carries the hedge word ("likely")', `${likelyCards} cards with an H-1B chip; bad: ${badLikely.slice(0, 2).join(' | ')}`);
    await p.eval(`document.querySelector('#jl-feed-scroll').scrollTo(0, 0)`);
    await sleep(500);

    // -------- the chip's tooltip (reachable with the keyboard) names the public data and its date
    const chipTip = await p.eval<string>(`(async () => {
      const chip = [...document.querySelectorAll('.jl-card .jl-chip.cyan')].find((c) => /H-1B/.test(c.textContent));
      if (!chip) return '';
      chip.scrollIntoView({ block: 'center' }); chip.focus();
      await new Promise((r) => setTimeout(r, 700));
      return [...document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)')].map((t) => t.innerText).join(' | ');
    })()`);
    await p.shot(join(dir, '01-chip-tooltip.png'));
    check(/Department of Labor/i.test(chipTip) && /(20\d\d)/.test(chipTip) && /likely|past/i.test(chipTip), 'O4 the sponsorship chip tooltip names its public source and the date of the data', chipTip.replace(/\s+/g, ' ').slice(0, 220));

    // -------- details: one company that is in the sponsor data, one that is not
    const list = await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 100 } });
    const details: JobDetail[] = [];
    for (const it of list.items.slice(0, 60)) details.push(await demo.api.call('getJob', { params: { jobId: it.job.id } }) as JobDetail);
    const inData = details.find((d) => d.company?.h1b);
    const notInData = details.find((d) => !d.company?.h1b && d.job.statements.sponsorship !== 'no');
    check(!!inData && !!notInData, 'O4 setup: fixtures have a job at a company in the sponsor data and one that is not', `${inData?.job.company} / ${notInData?.job.company}`);
    const open = async (id: string) => {
      await p.eval(`location.hash = '#/jobs/${encodeURIComponent(id)}'`);
      await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
      await sleep(300);
      return p.eval<string>(`document.querySelector('.jl-detail-main').innerText`);
    };
    if (notInData) {
      const t = await open(notInData.job.id);
      await p.eval(`document.getElementById('sec-visa').scrollIntoView({ block: 'start' })`);
      await sleep(300);
      await p.shot(join(dir, '02-not-in-data.png'));
      const bad: string[] = [];
      scan(t, 'detail', bad);
      check(bad.length === 0 && /unknown/i.test(t) && !/cannot sponsor|no sponsorship/i.test(t), 'O4 a company that is not in the sponsor data shows "unknown", never a "no"', `${notInData.job.company}; ${bad.join(' | ')}`);
      const area = await p.eval<string>(`document.getElementById('sec-visa').innerText.replace(/\\s+/g, ' ')`);
      check(!/^.*(no h-?1b|does not sponsor|will not sponsor).*$/i.test(area), 'O4 the sponsorship area of that job has no negative claim', area.slice(0, 200));
    }
    if (inData) {
      const t = await open(inData.job.id);
      await p.eval(`document.getElementById('sec-visa').scrollIntoView({ block: 'start' })`);
      await sleep(300);
      await p.shot(join(dir, '03-in-data.png'));
      const area = await p.eval<string>(`document.getElementById('sec-visa').innerText.replace(/\\s+/g, ' ')`);
      check(/likely|some h-1b filing history/i.test(area), 'O4 a company in the data shows the hedge word', area.slice(0, 160));
      check(/Source: .*Department of Labor/i.test(area) && /Data through/i.test(area), 'O4 the sponsorship area names its source and the date the data runs to', area.slice(area.indexOf('Source') > 0 ? area.indexOf('Source') : 0, 300));
      check(!/applicants/i.test(t), 'O4 the detail of that job has no applicant text');
    }

    // -------- 60 details: no banned text, and "no sponsorship" only where the posting itself says so
    const detailHits: string[] = [];
    let negFromMissing = 0;
    for (const d of details.slice(0, 40)) {
      const t = await open(d.job.id);
      scan(t, d.job.id, detailHits);
      if (d.job.statements.sponsorship !== 'no' && /cannot sponsor|no sponsorship|will not sponsor|not sponsor/i.test(t)) negFromMissing++;
    }
    check(detailHits.length === 0, 'O4 40 job details have no applicant, early-applicant or listed-elsewhere text', detailHits.slice(0, 3).join(' | '));
    check(negFromMissing === 0, 'O4 a negative sponsorship statement only ever comes from the posting itself', `${negFromMissing} details with a negative statement that the posting does not make`);

    // -------- the dashboard, the tracker and the assistant screen
    for (const r of ['dashboard', 'tracker', 'jobs/liked', 'notifications', 'interview']) {
      await p.eval(`location.hash = '#/${r}'`);
      await sleep(700);
      const t = await p.eval<string>(`document.body.innerText`);
      const bad: string[] = [];
      scan(t, r, bad);
      check(bad.length === 0, `O4 ${r} has no applicant counts or listed-elsewhere claims`, bad.join(' | '));
    }
  } finally {
    await b.close();
  }
}
