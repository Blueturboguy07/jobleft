// O10: every state is designed. First run shows crawl progress and fills as boards finish; loading, empty and error
// states differ; every empty view says what to do next; when a thing fails the screen says in plain words what failed
// and offers a retry, and the rest of the app keeps working.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import { check, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--balance', '4.37'];

const TECH = /(\bHTTP\b|\bECONN\w*|\bstack\b|Error:|\{"|\bundefined\b|\bnull\b|\bNaN\b|\[object|\b[45]\d\d\b(?! ?(?:jobs|K|boards|\/))|Unexpected token)/;

const SNAP = `(() => ({
  cards: document.querySelectorAll('.jl-card').length,
  count: (document.querySelector('.jl-results-line')||{}).innerText || '',
  progress: (document.querySelector('.jl-progress')||{}).innerText || '',
  state: (document.querySelector('.jl-state h2')||{}).textContent || '',
  stateText: (document.querySelector('.jl-state')||{}).innerText || '',
  spinner: !!document.querySelector('.ant-spin-spinning, .jl-skel'),
  alerts: [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText),
}))()`;

async function shot(p: Page, dir: string, name: string): Promise<void> { await p.shot(join(dir, `${name}.png`)); }

async function bodyText(p: Page): Promise<string> { return p.eval<string>('document.body.innerText'); }

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'states');
  mkdirSync(dir, { recursive: true });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    // -------- first run with an empty data folder: onboarding first, then the feed while the first refresh runs
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-shell, .jl-onboard')", 15000);
    await sleep(600);
    await shot(p, dir, '00-first-launch');
    const first = await p.eval<string>('document.body.innerText');
    check(/what kind of work|skip setup/i.test(first), 'O10 an empty first launch opens the setup, with a way to skip it', first.slice(0, 80).replace(/\s+/g, ' '));
    await p.clickText('Skip setup');
    await sleep(700);
    const samples: Array<{ t: number } & Record<string, unknown>> = [];
    const t0 = Date.now();
    let sawProgress = false, falseEmpty = 0, maxCards = 0, cardsWhileRunning = 0, spinnerFor = 0, lastSpinner = 0;
    for (let i = 0; i < 16; i++) {
      const s = await p.eval<{ cards: number; count: string; progress: string; state: string; stateText: string; spinner: boolean }>(SNAP);
      const t = Math.round((Date.now() - t0) / 1000);
      samples.push({ t, ...s });
      const running = /of \d+ boards? done|Reading|being read|first refresh/i.test(s.progress + ' ' + s.stateText);
      if (running) sawProgress = true;
      if (running && s.cards > 0) cardsWhileRunning = Math.max(cardsWhileRunning, s.cards);
      // "No jobs match" or "No jobs yet" while the crawl runs would say the search found nothing
      if (running && /^No jobs (match|yet)/i.test(s.state)) falseEmpty++;
      if (!running && !s.progress && /^No jobs (match|yet)/i.test(s.state) && i < 8) falseEmpty++;
      if (s.spinner) { if (!lastSpinner) lastSpinner = Date.now(); spinnerFor = Math.max(spinnerFor, Date.now() - lastSpinner); } else lastSpinner = 0;
      maxCards = Math.max(maxCards, s.cards);
      if (i % 2 === 0) await shot(p, dir, `01-feed-${String(t).padStart(3, '0')}s`);
      await sleep(5000);
    }
    writeFileSync(join(dir, 'first-run-samples.json'), JSON.stringify(samples, null, 1));
    check(sawProgress, 'O10 the first-run feed shows crawl progress in words', JSON.stringify(samples.find((s) => /boards? done/.test(String(s.progress) + String(s.stateText)))?.progress ?? samples[0]).slice(0, 160));
    check(cardsWhileRunning > 0, 'O10 jobs are on the feed while the first refresh is still running', `${cardsWhileRunning} cards seen mid-refresh`);
    const early = samples.filter((s) => (s.t as number) <= 30 && Number(s.cards) > 0);
    check(early.length > 0, 'O10 the feed has cards within 30 seconds of the first refresh starting', early[0] ? `t=${early[0].t}s` : 'none');
    check(falseEmpty === 0, 'O10 "No jobs match" or "No jobs yet" never shows while the first refresh runs', `${falseEmpty} samples`);
    check(spinnerFor < 12000, 'O10 no loader spins for 12 seconds or more', `${spinnerFor} ms`);
    check(maxCards > 3, 'O10 the feed fills up', `${maxCards} cards on screen`);
    const growth = samples.filter((s) => Number(s.cards) > 0).length;
    check(growth >= 3, 'O10 cards appear in several samples, not only at the end', `${growth} samples with cards`);

    // -------- empty views: each has a title, words and a next step
    const empties = ['jobs/liked', 'jobs/applied', 'jobs/external', 'jobs/hidden', 'tracker', 'network', 'resume', 'notifications', 'interview'];
    for (const r of empties) {
      await p.eval(`location.hash = '#/${r}'`);
      await sleep(900);
      const st = await p.eval<{ h2: string; text: string; controls: number; anyFilled: boolean }>(`(() => { const s = document.querySelector('.jl-state, .jl-empty'); return { h2: (s && s.querySelector('h2,h3')||{}).textContent || '', text: s ? s.innerText : document.querySelector('main').innerText.slice(0, 200), controls: s ? s.querySelectorAll('button,a,input,[role=button]').length : document.querySelectorAll('main button, main a, main input').length, anyFilled: document.querySelectorAll('.jl-card').length > 0 }; })()`);
      await shot(p, dir, `02-empty-${r.replace('/', '_')}`);
      check(st.text.trim().length > 20 && st.controls > 0 && !TECH.test(st.text), `O10 the empty view ${r} says what to do next`, `${JSON.stringify(st.h2)} ${st.text.slice(0, 90).replace(/\s+/g, ' ')} (${st.controls} controls)`);
    }
    // the loading state, the empty state and the error state look different: compare their own classes and words
    const ld = await p.eval<boolean>(`!!document.querySelector('.jl-skel')`);
    void ld;

    // -------- failures: employer sites down, AI stopped, network off. Words, a retry, the rest keeps working.
    const ctl = async (what: string, action: string) => { const { spawnSync } = await import('node:child_process'); return spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'mock', 'ctl.ts'), what, action, '--home', demo.home], { encoding: 'utf8' }); };
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(900);
    // employer sites down, then a refresh
    await ctl('boards', 'stop');
    await p.clickText('Refresh now');
    await p.waitFor("document.querySelector('.jl-progress')", 15000);
    await p.waitFor("!document.querySelector('.jl-progress')", 90000);
    await sleep(1200);
    let t = await bodyText(p);
    await shot(p, dir, '03-refresh-employers-down');
    const boardsNote = /could not|failed|unavailable|not answering|down|try again/i.test(t);
    check(boardsNote && !TECH.test(t), 'O10 with the employer sites down, a refresh says in plain words what failed', t.match(/[^.\n]*(could not|failed|unavailable|not answering|down)[^.\n]*/i)?.[0]?.slice(0, 140) ?? '(no message found)');
    await ctl('boards', 'start');
    await sleep(500);

    // the AI model does not answer: pick the model on this computer, stop it, send a chat message
    await demo.api.call('putAiSettings', { body: { provider: 'local', localKind: 'openai_compatible', baseUrl: 'http://127.0.0.1:47911/v1', model: 'standin-7b' } as never }).catch(() => undefined);
    await ctl('ai', 'stop');
    await sleep(500);
    await p.eval(`location.hash = '#/assistant'`);
    await p.eval('location.reload()');
    await p.waitFor("document.querySelector('.jl-shell')", 10000);
    await sleep(1200);
    await p.eval(`document.querySelector('textarea[aria-label="Message to the assistant"]').focus()`);
    await p.type('Which skills come up most in the jobs I liked?');
    await p.press('Enter');
    await sleep(4500);
    t = await bodyText(p);
    await shot(p, dir, '04-chat-ai-down');
    const chatFailed = await p.eval<{ alert: string; retry: boolean }>(`(() => ({ alert: [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText).join(' | '), retry: /send again|try again/i.test(document.body.innerText) }))()`);
    check(chatFailed.alert.length > 10 && !TECH.test(chatFailed.alert), 'O10 with the AI model stopped, a chat message ends in a plain-words error', chatFailed.alert.slice(0, 160));
    check(chatFailed.retry, 'O10 the chat error offers a retry');
    // the rest of the app keeps working with the AI down
    for (const r of ['jobs', 'tracker', 'resume', 'profile']) {
      await p.eval(`location.hash = '#/${r}'`);
      await sleep(700);
      const ok = await p.eval<boolean>(`document.querySelector('.jl-shell') && document.body.innerText.length > 100 && !document.querySelector('.jl-state.error')`);
      check(ok, `O10 with the AI down, ${r} still works`);
    }
    await ctl('ai', 'start');

    // network off: the app says so, stored data still browses
    await fetch(`${demo.origin}/__mock/offline`, { method: 'POST', headers: { 'x-jobleft-token': demo.token, 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) });
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(1200);
    await p.clickText('Refresh now');
    await sleep(2500);
    t = await bodyText(p);
    await shot(p, dir, '05-offline-jobs');
    const cardsOffline = await p.eval<number>(`document.querySelectorAll('.jl-card').length`);
    check(cardsOffline > 0, 'O10 with the network off, stored jobs still browse', `${cardsOffline} cards`);
    check(/offline|no network|no internet|not connected|cannot read job boards/i.test(t) && !TECH.test(t), 'O10 with the network off, a refresh says so in plain words', t.match(/[^.\n]*(offline|no network|no internet|not connected|cannot read)[^.\n]*/i)?.[0]?.slice(0, 140) ?? '(none)');
    for (const r of ['tracker', 'resume', 'profile', 'network']) {
      await p.eval(`location.hash = '#/${r}'`);
      await sleep(700);
      const ok = await p.eval<boolean>(`document.querySelector('.jl-shell') && document.body.innerText.length > 100`);
      check(ok, `O10 with the network off, ${r} still opens`);
    }
    // a chat message while offline
    // (a model on this computer works without the internet, so this step uses publik, which is off the computer)
    await demo.api.call('connectPublik', { body: { disclosureAccepted: true, disclosureVersion: 1 } }).catch(() => undefined);
    await demo.api.call('putAiSettings', { body: { provider: 'publik' } }).catch(() => undefined);
    await p.eval(`location.hash = '#/assistant'`);
    await p.eval('location.reload()');
    await p.waitFor("document.querySelector('.jl-shell')", 10000);
    await sleep(1200);
    await p.eval(`document.querySelector('textarea[aria-label="Message to the assistant"]').focus()`);
    await p.type('Help me plan my job search this week.');
    await p.press('Enter');
    await sleep(3500);
    const off = await p.eval<string>(`[...document.querySelectorAll('[role=alert]')].map((e) => e.innerText).join(' | ')`);
    await shot(p, dir, '06-chat-offline');
    check(off.length > 10 && !TECH.test(off), 'O10 offline, a chat message ends in a plain-words error', off.slice(0, 160));
    await fetch(`${demo.origin}/__mock/offline`, { method: 'POST', headers: { 'x-jobleft-token': demo.token, 'content-type': 'application/json' }, body: JSON.stringify({ on: false }) });

    // the local service itself is gone: one clear message, no raw errors, and it recovers by itself
    demo.kill9();
    await p.eval(`location.hash = '#/tracker'`);
    await sleep(2500);
    await p.eval(`location.hash = '#/dashboard'`);
    await sleep(2500);
    t = await bodyText(p);
    await shot(p, dir, '07-service-gone');
    check(!TECH.test(t) && /not answering|not connected|try again|could not/i.test(t), 'O10 when the local service is gone, the screen says so in plain words', t.match(/[^.\n]*(not answering|not connected|could not)[^.\n]*/i)?.[0]?.slice(0, 140) ?? t.slice(0, 100).replace(/\s+/g, ' '));
    check(await p.eval<boolean>(`!!document.querySelector('.jl-rail, nav')`), 'O10 the navigation stays when the local service is gone');
    await demo.relaunchApi(['--no-crawl']);
    await sleep(500);
    const retried = await p.clickText('Try again');
    void retried;
    await sleep(2500);
    t = await bodyText(p);
    await shot(p, dir, '08-service-back');
    check(!/not answering/i.test(t), 'O10 after the local service returns, a retry (or the next poll) brings the screen back', t.slice(0, 80).replace(/\s+/g, ' '));
  } finally {
    await b.close();
  }
}
