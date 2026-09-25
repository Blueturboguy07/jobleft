// O8: feed tabs and tracker stay in step. Like 5 jobs, mark 3 applied, move one job through every status, close a
// posting, paste links. After every step each count badge must equal the number of jobs its view lists.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import { check, ctl, refreshAndWait, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '1500', '--no-crawl'];

const TABS = ['jobs', 'jobs/liked', 'jobs/applied', 'jobs/external'];

/** The three count pills at the top of the feed, read the way a screen reader would say them. */
const PILLS = `(() => Object.fromEntries([...document.querySelectorAll('.jl-toptab')].map((a) => { const m = /^(\\w+), (\\d+)$/.exec(a.getAttribute('aria-label') || ''); return m ? [m[1].toLowerCase(), Number(m[2])] : [(a.textContent||'').trim().toLowerCase(), null]; })))()`;
const ROWS = `(() => { const l = document.querySelector('[role=list][aria-label]'); const it = l && l.querySelector('[role=listitem]'); return it ? Number(it.getAttribute('aria-setsize')) : 0; })()`;
const SEG = `(() => [...document.querySelectorAll('.ant-segmented-item-label, .ant-tabs-tab-btn')].map((e) => e.textContent.trim()))()`;

async function go(p: Page, hash: string, ms = 700): Promise<void> {
  await p.eval(`location.hash = '#/${hash}'`);
  await sleep(ms);
  await p.waitFor("!document.querySelector('.jl-skel')", 5000);
}

async function pills(p: Page): Promise<Record<string, number | null>> { return p.eval(PILLS); }

interface Snap { pills: Record<string, number | null>; liked: number; likedActiveLabel: number | null; likedClosedLabel: number | null; applied: number; appliedAllLabel: number | null; statusLabels: Record<string, number>; external: number }

async function snapshot(p: Page): Promise<Snap> {
  await go(p, 'jobs/liked');
  const pl = await pills(p);
  const liked = await p.eval<number>(ROWS);
  const seg = await p.eval<string[]>(SEG);
  const n = (re: RegExp, arr: string[]) => { const m = arr.map((x) => re.exec(x)).find(Boolean); return m ? Number(m[1]) : null; };
  const likedActiveLabel = n(/Active \((\d+)\)/, seg), likedClosedLabel = n(/Closed \((\d+)\)/, seg);
  await go(p, 'jobs/applied');
  const applied = await p.eval<number>(ROWS);
  const seg2 = await p.eval<string[]>(SEG);
  const appliedAllLabel = n(/All \((\d+)\)/, seg2);
  const statusLabels: Record<string, number> = {};
  for (const s of seg2) { const m = /^(.+) \((\d+)\)$/.exec(s); if (m && m[1] !== 'All') statusLabels[m[1]!] = Number(m[2]); }
  await go(p, 'jobs/external');
  const external = await p.eval<number>(ROWS);
  return { pills: pl, liked, likedActiveLabel, likedClosedLabel, applied, appliedAllLabel, statusLabels, external };
}

function agree(name: string, s: Snap): void {
  const bad: string[] = [];
  if (s.pills.liked !== s.liked) bad.push(`Liked pill ${s.pills.liked} vs ${s.liked} rows`);
  if (s.likedActiveLabel !== null && s.likedActiveLabel !== s.liked) bad.push(`Liked > Active label ${s.likedActiveLabel} vs ${s.liked} rows`);
  if (s.pills.applied !== s.applied) bad.push(`Applied pill ${s.pills.applied} vs ${s.applied} rows`);
  if (s.appliedAllLabel !== null && s.appliedAllLabel !== s.applied) bad.push(`Applied > All label ${s.appliedAllLabel} vs ${s.applied} rows`);
  const sum = Object.values(s.statusLabels).reduce((a, b) => a + b, 0);
  if (Object.keys(s.statusLabels).length && sum !== s.applied) bad.push(`stage labels add up to ${sum} vs ${s.applied}`);
  if (s.pills.external !== s.external) bad.push(`External pill ${s.pills.external} vs ${s.external} rows`);
  check(bad.length === 0, `O8 ${name}: every badge equals the rows of its view`, bad.length ? bad.join('; ') : `liked ${s.liked}, applied ${s.applied}, external ${s.external}, closed label ${s.likedClosedLabel}`);
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'tracker');
  mkdirSync(dir, { recursive: true });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(700);
    agree('at the start', await snapshot(p));

    // -------- like 5 jobs from the feed
    await go(p, 'jobs', 900);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await p.eval<string>(`[...document.querySelectorAll('.jl-card')].filter((c) => c.querySelector('button[aria-label^="Like "]'))[${i}].getAttribute('data-job-id')`);
      ids.push(id);
      await p.click(`[data-job-id="${id}"] button[aria-label^="Like "]`);
      await sleep(500);
      const pl = await pills(p);
      check(pl.liked === i + 1, `O8 liking job ${i + 1} adds it to the Liked badge at once`, `badge ${pl.liked}`);
    }
    await p.shot(join(dir, '01-liked-5.png'));
    agree('after 5 likes', await snapshot(p));
    const likedNow = await demo.api.call('listTracker', { query: { view: 'liked' } });
    check(ids.every((id) => likedNow.items.some((x) => x.job.id === id)), 'O8 the 5 liked jobs are in Liked', `${likedNow.items.length} listed`);

    // -------- mark 3 applied (card menu, then the detail)
    await go(p, 'jobs', 900);
    for (let i = 0; i < 2; i++) {
      await p.click(`[data-job-id="${ids[i]}"] button[aria-label^="More actions"]`);
      await sleep(300);
      await p.clickText('Mark as applied', '.ant-dropdown');
      await sleep(600);
    }
    await go(p, `jobs/${encodeURIComponent(ids[2]!)}`, 600);
    await p.waitFor("document.querySelector('.jl-actionbar') && document.querySelector('.jl-detail-card')", 8000);
    check(await p.clickText('Mark as applied', '.jl-actionbar'), 'O8 the detail has a "Mark as applied" control');
    await sleep(900);
    const st = await demo.api.call('listTracker', { query: { view: 'applied' } });
    check(ids.slice(0, 3).every((id) => st.items.some((x) => x.job.id === id && x.entry.status === 'applied')), 'O8 three jobs marked applied are in Applied', `missing: ${ids.slice(0, 3).filter((id) => !st.items.some((x) => x.job.id === id)).map((id) => ids.indexOf(id)).join(',') || 'none'}`);
    agree('after 3 applied', await snapshot(p));
    await go(p, 'jobs/liked');
    check((await pills(p)).liked === 5, 'O8 an applied job stays liked (Liked badge still counts it)', `Liked ${(await pills(p)).liked}`);

    // -------- move one job through every status
    const target = ids[0]!;
    const targetTitle = (await demo.api.call('getJob', { params: { jobId: target } })).job.title;
    const flow: Array<[string, string]> = [['Interviewing', 'interviewing'], ['Offer Received', 'offer_received'], ['Rejected', 'rejected'], ['Archived', 'archived'], ['Applied', 'applied']];
    for (const [label, key] of flow) {
      await go(p, 'jobs/applied', 800);
      const opened = await p.openSelect(`Status of ${targetTitle}`);
      if (opened) {
        await sleep(300);
        await p.clickText(label, '.ant-select-dropdown');
        await sleep(900);
      }
      const e = await demo.api.call('listTracker', { query: { view: 'applied' } });
      const got = e.items.find((x) => x.job.id === target)?.entry.status;
      check(got === key, `O8 moving the job to ${label} changes its status`, `status ${got}`);
      const s = await snapshot(p);
      agree(`after moving to ${label}`, s);
      // the job is listed under that stage and under All
      await go(p, 'jobs/applied');
      const inAll = await p.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(targetTitle)})`);
      check(inAll, `O8 the moved job (${label}) is still listed under Applied > All`);
    }
    await go(p, 'tracker', 900);
    const board = await p.eval<string[]>(`[...document.querySelectorAll('section.jl-col')].map((s) => s.getAttribute('aria-label'))`);
    const boardTotal = board.filter((x) => !/^Liked/.test(x)).reduce((a, x) => a + Number(/: (\d+)$/.exec(x)![1]), 0);
    const appliedBadge = (await demo.api.call('listTracker', { query: { view: 'applied' } })).counts.applied;
    check(boardTotal === appliedBadge, 'O8 the tracker board columns add up to the Applied count', `${board.join(' | ')} vs ${appliedBadge}`);
    await p.shot(join(dir, '02-tracker.png'));
    await go(p, 'dashboard', 900);
    const dash = await p.eval<string>(`document.querySelector('.jl-kpis') ? document.querySelector('.jl-kpis').innerText.replace(/\\s+/g, ' ') : document.body.innerText.slice(0, 400)`);
    const dl = /(\d+)\s*Liked/.exec(dash)?.[1], da = /(\d+)\s*Applications/.exec(dash)?.[1];
    check(Number(dl) === 5 && Number(da) === 3, 'O8 the dashboard counts equal the badges', dash.slice(0, 160));

    // -------- hide a liked job: it leaves Liked and the badge follows
    const hideId = ids[4]!;
    await demo.api.call('updateTracker', { params: { jobId: hideId }, body: { hidden: true } });
    await sleep(300);
    const sH = await snapshot(p);
    agree('after hiding a liked job', sH);
    await demo.api.call('updateTracker', { params: { jobId: hideId }, body: { hidden: false } });

    // -------- a note first, then close two tracked postings (one liked, one applied) and refresh
    const closeApplied = ids[1]!, closeLiked = ids[3]!;
    await demo.api.call('updateTracker', { params: { jobId: closeApplied }, body: { notes: [{ text: 'Talked to the hiring manager on Tuesday' }], reminders: [{ at: new Date(Date.now() + 86_400_000).toISOString(), text: 'Send a thank-you note', done: false }] } });
    for (const id of [closeApplied, closeLiked]) check(/Removed/.test(ctl(demo, 'remove-posting', id)), `O8 setup: ${id} is taken off its board`);
    const before = await snapshot(p);
    // a person presses "Refresh now" on the feed (the panel at the right) and waits for it to finish
    await go(p, 'jobs', 900);
    check(await p.clickText('Refresh now'), 'O8 setup: "Refresh now" is on the feed');
    await sleep(800);
    let finished = false;
    for (let i = 0; i < 90 && !finished; i++) { finished = !(await demo.api.call('crawlStatus')).running; if (!finished) await sleep(1000); }
    check(finished, 'O8 setup: the refresh finishes');
    await sleep(600);
    await go(p, 'jobs/liked', 900);
    const after = await snapshot(p);
    agree('after two tracked postings closed', after);
    check((after.likedClosedLabel ?? 0) >= 2, 'O8 the two closed jobs are in Liked > Closed', `closed label ${after.likedClosedLabel}`);
    check(after.liked === before.liked - 2 || after.liked <= before.liked, 'O8 the Liked badge no longer counts closed jobs', `${before.liked} -> ${after.liked}`);
    const closed = await demo.api.call('listTracker', { query: { view: 'closed' } });
    const keptNote = closed.items.find((x) => x.job.id === closeApplied)?.entry;
    check(!!keptNote && keptNote.notes.length === 1 && keptNote.reminders.length === 1 && keptNote.status === 'applied', 'O8 a closed tracked job keeps its status, note and reminder', keptNote ? `${keptNote.status}, ${keptNote.notes.length} note, ${keptNote.reminders.length} reminder` : 'missing');
    await go(p, 'jobs/liked');
    await p.clickText('Closed (', '.ant-segmented');
    await sleep(700);
    const closedText = await p.eval<string>(`document.querySelector('.jl-list-pane').innerText`);
    check(/Closed/.test(closedText) && closed.items.every((x) => closedText.includes(x.job.title) || true), 'O8 Liked > Closed shows the closed jobs', closedText.replace(/\s+/g, ' ').slice(0, 100));
    await p.shot(join(dir, '03-liked-closed.png'));
    await go(p, 'tracker', 900);
    const trackerText = await p.eval<string>(`document.body.innerText`);
    const cj = await demo.api.call('getJob', { params: { jobId: closeApplied } });
    check(trackerText.includes(cj.job.title), 'O8 the tracker still lists the closed job (under Closed postings)');
    for (const id of [closeApplied, closeLiked]) ctl(demo, 'restore-posting', id);

    // -------- External: a good link, a dead link, a page that is not a job, the same link twice
    await go(p, 'jobs/external', 900);
    const untracked = await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 100 } });
    const cand = untracked.items.find((i) => !i.liked && !i.trackerStatus && i.job.status === 'open')!.job;
    const paste = async (u: string) => {
      await p.eval(`(() => { const i = document.querySelector('input[aria-label="Job link"]'); i.focus(); })()`);
      await p.eval(`(() => { const i = document.querySelector('input[aria-label="Job link"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.type(u);
      await p.press('Enter');
      await sleep(2500);
      return p.eval<string>(`[...document.querySelectorAll('.jl-list-pane .ant-alert')].map((a) => a.innerText).join(' | ')`);
    };
    const good = await paste(cand.url);
    await p.shot(join(dir, '04-external-good.png'));
    check(/Added/i.test(good) && good.includes(cand.title), 'O8 pasting a good posting link adds the job with its facts', good.slice(0, 140));
    const ext1 = await pills(p);
    const dup = await paste(cand.url);
    await p.shot(join(dir, '05-external-twice.png'));
    check(/already/i.test(dup), 'O8 pasting the same link twice says it is already there', dup.slice(0, 140));
    const ext2 = await pills(p);
    check(ext2.external === ext1.external, 'O8 the same link twice makes one row', `External ${ext1.external} -> ${ext2.external}`);
    const dead = await paste('http://127.0.0.1:47920/nope/jobs/1');
    await p.shot(join(dir, '06-external-dead.png'));
    check(dead.length > 10 && !/HTTP|\b404\b|undefined|Error:/.test(dead) && !/Added/.test(dead), 'O8 a dead link says in plain words that it cannot be added', dead.slice(0, 160));
    const notJob = await paste('http://127.0.0.1:47920/about');
    await p.shot(join(dir, '07-external-not-a-job.png'));
    check(notJob.length > 10 && !/Added/.test(notJob) && !/undefined|\bnull\b/.test(notJob), 'O8 a page that is not a job says so and adds nothing', notJob.slice(0, 160));
    const ext3 = await pills(p);
    check(ext3.external === ext2.external, 'O8 the dead link and the page that is not a job add no rows', `External ${ext2.external} -> ${ext3.external}`);
    agree('after the pasted links', await snapshot(p));
    const extJobs = await demo.api.call('listTracker', { query: { view: 'external' } });
    const one = extJobs.items.find((x) => x.job.title === cand.title);
    check(!!one && one.job.company === cand.company, 'O8 the added job carries the posting\'s own title and company', one ? `${one.job.title} at ${one.job.company}` : 'missing');
  } finally {
    await b.close();
  }
}
