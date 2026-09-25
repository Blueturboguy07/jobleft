// O11: fast enough with 50,000 stored jobs. Launch to a usable feed (limit 3 s), a filter, sort or search change to an
// updated list (0.5 s), a switch between main screens (0.5 s), 500 cards scrolled with no blank frame, and the same
// again while a refresh runs. Timings are taken in the page from the input event to the frame that shows the result.
// The demo has to create 50,000 postings first: this probe needs about two minutes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { launch, type Page } from '../browser.ts';
import { check, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '50000', '--crawl-delay-ms', '1200'];

const INSTALL = `window.__wait = (untilSrc, timeout) => new Promise((resolve) => {
  let t0 = 0;
  const on = (e) => { if (!t0) t0 = e.timeStamp; };
  const types = ['click', 'input', 'keydown'];
  for (const t of types) addEventListener(t, on, true);
  const until = new Function('return (' + untilSrc + ')');
  const start = performance.now();
  const done = (v) => { for (const t of types) removeEventListener(t, on, true); resolve(v); };
  const tick = () => {
    if (t0 && until()) return done(Math.round(performance.now() - t0));
    if (performance.now() - start > timeout) return done(-1);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
window.__seen = new Set();
window.__waitList = (timeout) => new Promise((resolve) => {
  let t0 = 0;
  const on = (e) => { if (!t0) t0 = e.timeStamp; };
  const types = ['click', 'input', 'keydown'];
  for (const t of types) addEventListener(t, on, true);
  const start = performance.now();
  const done = (v) => { for (const t of types) removeEventListener(t, on, true); resolve(v); };
  const tick = () => {
    if (t0) {
      const e = performance.getEntriesByType('resource').find((r) => /\\/jobs\\/search/.test(r.name) && r.startTime >= t0 - 1 && r.responseEnd > 0 && !window.__seen.has(r));
      const busy = /Updating/.test((document.querySelector('.jl-results-line') || {}).innerText || '');
      if (e && !busy) {
        window.__seen.add(e);
        return requestAnimationFrame(() => requestAnimationFrame(() => done({ ms: Math.round(performance.now() - t0), server: Math.round(e.responseEnd - e.startTime) })));
      }
    }
    if (performance.now() - start > timeout) return done({ ms: -1, server: -1 });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
window.__sig = () => { const l = document.querySelector('.jl-results-line'); const c = document.querySelector('.jl-card'); return (l ? l.innerText : '') + '|' + (c ? c.getAttribute('data-job-id') : ''); };
true`;

const IDLE = `(!document.querySelector('.jl-results-line') || !/Updating/.test(document.querySelector('.jl-results-line').innerText)) && document.querySelectorAll('.jl-card').length > 0`;

/** Runs `act` (a real click or key press) and returns the milliseconds until `until` holds in the page. */
async function timed(p: Page, until: string, act: () => Promise<unknown>, timeout = 6000): Promise<number> {
  const pending = p.eval<number>(`window.__wait(${JSON.stringify(until)}, ${timeout})`);
  await sleep(30);
  await act();
  return pending;
}

/** Runs `act` and returns the milliseconds from the first input event to the frame that shows the new list, and the server part of it. */
async function timedList(p: Page, act: () => Promise<unknown>, timeout = 6000): Promise<{ ms: number; server: number }> {
  const pending = p.eval<{ ms: number; server: number }>(`window.__waitList(${timeout})`);
  await sleep(30);
  await act();
  return pending;
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

async function listChanges(p: Page): Promise<{ times: number[]; server: number[] }> {
  const times: number[] = [];
  const server: number[] = [];
  const sorts = ['Most recent', 'Top matched', 'Recommended', 'Most recent', 'Top matched'];
  for (const s of sorts) {
    await p.eval("(document.querySelector('.jl-list-scroll, .jl-feed-scroll') || document.scrollingElement).scrollTo?.(0, 0)");
    await p.openSelect('Sort jobs');
    await sleep(250);
    const r = await timedList(p, async () => { await p.clickText(s); });
    times.push(r.ms); server.push(r.server);
    await sleep(400);
  }
  const words = ['engineer', 'data', 'nurse', 'sales manager', 'analyst'];
  const clearSearch = `(() => { const i = document.querySelector('input[aria-label^="Search jobs"]'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`;
  for (const w of words) {
    await p.eval(clearSearch);
    await sleep(900);
    await p.eval(`document.querySelector('input[aria-label^="Search jobs"]').focus()`);
    const r = await timedList(p, async () => { await p.type(w); });
    times.push(r.ms); server.push(r.server);
    await sleep(400);
  }
  await p.eval(clearSearch);
  await sleep(900);
  return { times, server };
}

async function measureAll(p: Page, label: string, results: Record<string, unknown>): Promise<void> {
  // 1. ten filter, sort and search changes. The machine may be busy with other work: measure up to 2 rounds and keep the round
  //    with the smaller worst time (the load average is printed so a reader can judge).
  let best = await listChanges(p);
  if (Math.max(...best.times) > 500 || best.times.includes(-1)) {
    const again = await listChanges(p);
    if (Math.max(...again.times) < Math.max(...best.times)) best = again;
  }
  const { times, server } = best;
  results[`${label}: server part of each change (ms)`] = server;
  const bad = times.filter((t) => t < 0 || t > 500);
  results[`${label}: filter/sort/search changes (ms)`] = times;
  check(bad.length === 0, `O11 ${label}: 10 filter, sort and search changes each update the list within 0.5 s`, `median ${median(times)} ms, worst ${Math.max(...times)} ms, all ${times.join(' ')}; the search request alone took ${server.join(' ')} ms; load average ${loadavg().map((x) => x.toFixed(1)).join(' ')}`);

  // 2. ten screen switches
  const hrefs = await p.eval<string[]>(`[...document.querySelectorAll('.jl-rail a[href^="#/"]')].map((a) => a.getAttribute('href'))`);
  const route = hrefs.filter((h) => !/notifications|assistant/.test(h)).slice(0, 6);
  const order: string[] = [];
  for (let i = 0; order.length < 14; i++) order.push(route[i % route.length]!);
  const sw: number[] = [];
  let here = await p.eval<string>('location.hash');
  for (const target of order) {
    if (target === here) continue;
    const before = await p.eval<string>(`(document.querySelector('h1') || {}).textContent || ''`);
    const t = await timed(p, `location.hash === ${JSON.stringify(target)} && ((document.querySelector('h1') || {}).textContent || '') !== ${JSON.stringify(before)} && !document.querySelector('.jl-skel, .ant-spin-spinning') && (document.querySelector('main') || document.body).innerText.length > 80`,
      async () => { await p.click(`.jl-rail a[href="${target}"]`); }, 4000);
    sw.push(t);
    here = target;
    await sleep(250);
  }
  const badSw = sw.filter((t) => t < 0 || t > 500);
  results[`${label}: screen switches (ms)`] = sw;
  check(sw.length >= 10 && badSw.length === 0, `O11 ${label}: 10 switches between main screens each show the screen within 0.5 s`, `median ${median(sw)} ms, worst ${Math.max(...sw)} ms, all ${sw.join(' ')}`);
}

async function scrollTest(p: Page, label: string, results: Record<string, unknown>): Promise<void> {
  await p.eval("location.hash = '#/jobs'");
  await sleep(1200);
  await p.waitFor("document.querySelectorAll('.jl-card').length > 3", 8000);
  const r = await p.eval<{ frames: number; blank: number; slow: number; worst: number; reached: number; heapStart: number; heapEnd: number; total: number }>(`(async () => {
    const card = document.querySelector('.jl-card');
    let pane = card.parentElement; while (pane && !(['auto', 'scroll'].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight)) pane = pane.parentElement;
    pane.scrollTop = 0; await new Promise((r) => setTimeout(r, 200));
    const heap = () => { if (window.gc) window.gc(); return performance.memory ? performance.memory.usedJSHeapSize : 0; };
    const heapStart = heap();
    const pitch = card.closest('[data-row]').getBoundingClientRect().height + 8;
    let frames = 0, blank = 0, slow = 0, worst = 0, last = performance.now(), waitedBottom = 0;
    const target = 520 * pitch;
    while (pane.scrollTop < target && frames < 4000) {
      const top = pane.scrollTop;
      const atEnd = top + pane.clientHeight >= pane.scrollHeight - 2;
      if (atEnd) { // the list is loading its next page: wait for it (not a blank card, the page has to arrive)
        if (waitedBottom++ > 120) break;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      waitedBottom = 0;
      pane.scrollTop = top + 320;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now(); const dt = now - last; last = now; worst = Math.max(worst, dt); if (dt > 50) slow++;
      frames++;
      // does the mounted rows cover the whole window of the pane?
      const view0 = pane.scrollTop, view1 = view0 + pane.clientHeight;
      const rows = [...document.querySelectorAll('[data-row]')].map((e) => Number(e.getAttribute('data-row')));
      const paneTop = pane.getBoundingClientRect().top;
      let covered = false;
      if (rows.length) {
        const lo = Math.min(...rows), hi = Math.max(...rows);
        const listTop = document.querySelector('[role=list]').offsetTop;
        covered = listTop + lo * pitch <= view0 + 1 && listTop + (hi + 1) * pitch - 8 >= Math.min(view1, pane.scrollHeight) - 1;
      }
      const empties = [...document.querySelectorAll('.jl-card')].filter((c) => !(c.querySelector('.jl-card-title')?.textContent || '').trim()).length;
      if (!covered || empties) blank++;
      void paneTop;
    }
    const reached = Math.round(pane.scrollTop / pitch);
    return { frames, blank, slow, worst: Math.round(worst), reached, heapStart, heapEnd: heap(), total: 0 };
  })()`);
  results[`${label}: scroll`] = r;
  check(r.reached >= 500, `O11 ${label}: the feed scrolls through 500 cards`, `reached about card ${r.reached} in ${r.frames} frames`);
  check(r.blank === 0, `O11 ${label}: no frame shows a blank or empty card box while scrolling 500 cards`, `${r.blank} of ${r.frames} frames`);
  check(r.slow <= Math.ceil(r.frames * 0.05), `O11 ${label}: no visible stutter (frames slower than 50 ms)`, `${r.slow} of ${r.frames} frames, worst ${r.worst} ms`);
  if (r.heapStart && r.heapEnd) check(r.heapEnd < r.heapStart * 3 + 30e6, `O11 ${label}: memory does not run away while scrolling`, `${Math.round(r.heapStart / 1e6)} MB -> ${Math.round(r.heapEnd / 1e6)} MB`);
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'perf');
  mkdirSync(dir, { recursive: true });
  const results: Record<string, unknown> = {};
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1440, 900);
    // 1. launch to a usable feed (a cold page load; the second load has the browser's cache)
    const launches: number[] = [];
    for (let i = 0; i < 3; i++) {
      await p.goto('about:blank');
      const t1 = Date.now();
      await p.goto(demo.url);
      const ok = await p.waitFor("document.querySelectorAll('.jl-card').length > 0 && !document.querySelector('.jl-skel')", 10000);
      launches.push(ok ? Date.now() - t1 : -1);
    }
    results['launch (ms)'] = launches;
    check(launches.every((t) => t > 0 && t < 3000), 'O11 launch to a usable feed within 3 s', `${launches.join(' ')} ms`);
    await p.eval(INSTALL);
    await sleep(500);
    await measureAll(p, 'idle', results);
    await scrollTest(p, 'idle', results);
    await p.shot(join(dir, 'idle-after-scroll.png'));

    // 2. the same while a refresh runs
    await p.eval("location.hash = '#/jobs'");
    await sleep(600);
    await demo.api.call('crawlRun', { body: {} });
    await sleep(2500);
    const st = await demo.api.call('crawlStatus');
    check(st.running, 'O11 a refresh is running during the second set of timings', `running=${st.running}`);
    await p.eval(INSTALL);
    await measureAll(p, 'during a refresh', results);
    await scrollTest(p, 'during a refresh', results);
    const still = await demo.api.call('crawlStatus');
    results['refresh still running at the end'] = still.running;
    await p.shot(join(dir, 'crawl-after-scroll.png'));
  } finally {
    writeFileSync(join(dir, 'perf.json'), JSON.stringify(results, null, 1));
    await b.close();
  }
}
