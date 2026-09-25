// O14: money is a dollar balance, and nothing is spent or sent without a click.
// One scripted session against the made-up publik service: connect, browse 20 jobs, open 10 details, tailor 1 resume,
// draft 1 network message, send 3 chat turns. The charge log must hold exactly one line for each click that confirmed
// a paid action, and no popup may open without a click. The service answers with the word "credits" in its errors
// (--legacy-wording): the app must show "balance".

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import { check, ctl, seedRich, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--price', '0.01', '--jobs', '600', '--no-crawl', '--legacy-wording'];

const OBSERVER = `(() => {
  window.__pops = []; window.__lastInput = performance.now();
  for (const t of ['click', 'keydown', 'pointerdown', 'mousedown']) addEventListener(t, () => { window.__lastInput = performance.now(); }, true);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    const hit = n.matches && n.matches('.ant-modal-wrap, .ant-drawer, .ant-popover, .ant-notification-notice, .ant-modal-root') ? n : (n.querySelector ? n.querySelector('.ant-modal-wrap, .ant-drawer-content, .ant-popover, .ant-notification-notice') : null);
    if (hit) window.__pops.push({ since: Math.round(performance.now() - window.__lastInput), what: String(hit.className).slice(0, 50), text: (hit.innerText || '').replace(/\\s+/g, ' ').slice(0, 70) });
  } }).observe(document.body, { childList: true, subtree: true });
})()`;

/** Screen text without the crawled posting text (which is exempt): cards, descriptions, job titles. */
const CHROME_TEXT = `(() => {
  const hidden = [...document.querySelectorAll('.jl-card, .jl-desc, .jl-mini, [data-job-id], .jl-detail-main h1, .ant-table-row, .jl-skel')];
  const old = hidden.map((e) => e.style.display);
  hidden.forEach((e) => { e.style.display = 'none'; });
  const attrs = [...document.querySelectorAll('[title],[aria-label],[placeholder],img[alt]')].filter((e) => !e.closest('.jl-card, .jl-desc, .jl-mini, [data-job-id]')).map((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('alt')].filter(Boolean).join(' ')).join(' ');
  const text = document.body.innerText + ' ' + attrs + ' ' + document.title;
  hidden.forEach((e, i) => { e.style.display = old[i]; });
  return text;
})()`;

function ledger(demo: Demo): Array<{ at: string; kind: string; micros: number; balanceAfterMicros: number }> {
  const f = join(demo.home, 'publik-standin', 'ledger.ndjson');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function balanceChip(p: Page): Promise<string> { return p.eval<string>(`(document.querySelector('.jl-topbar .jl-status-chip') || {}).innerText || ''`); }

async function sendChat(p: Page, text: string): Promise<void> {
  await p.eval(`document.querySelector('textarea[aria-label="Message to the assistant"]').focus()`);
  await p.type(text);
  await p.press('Enter');
  await sleep(300);
  await p.waitFor(`!document.querySelector('button[aria-label="Stop the answer"]') && document.querySelectorAll('.jl-bubble.assistant').length > 0`, 20000);
  await sleep(500);
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'money');
  mkdirSync(dir, { recursive: true });
  const seeded = await seedRich(demo, { ai: false });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(600);
    await p.eval(OBSERVER);
    check(/AI: not set up/.test(await balanceChip(p)), 'O14 before a provider is chosen the header says the AI is not set up (no balance shown)', await balanceChip(p));

    // -------- connect publik in Settings > Balance (the person ticks "I have read this" and presses the button)
    await p.eval(`location.hash = '#/settings/balance'`);
    await sleep(900);
    await p.clickText('I have read this');
    await sleep(200);
    await p.clickMatching('button', '^Connect');
    await sleep(1500);
    await p.shot(join(dir, '01-balance.png'));
    const bal1 = await p.eval<string>(`document.querySelector('main').innerText`);
    check(/Balance: \$4\.37/.test(bal1), 'O14 the balance card shows "Balance: $4.37"', (/Balance: [^\n]*/.exec(bal1) ?? [''])[0]);
    check(/Balance: \$4\.37/.test(await balanceChip(p)), 'O14 the top bar shows "Balance: $4.37"', await balanceChip(p));
    check(ledger(demo).length === 0, 'O14 connecting and reading the balance charges nothing', `${ledger(demo).length} charges`);

    // -------- every place with money: dollars, the word balance, no long decimals
    const places: Array<[string, string]> = [['jobs', 'the feed'], ['dashboard', 'the dashboard'], ['settings/ai', 'Settings > AI provider'], ['settings/balance', 'Settings > Balance'], ['assistant', 'the assistant']];
    const moneyBad: string[] = [];
    const chromeBad: string[] = [];
    for (const [r, label] of places) {
      await p.eval(`location.hash = '#/${r}'`);
      await sleep(800);
      const t = await p.eval<string>(CHROME_TEXT);
      for (const m of t.matchAll(/\$\s?[\d,]+(?:\.\d+)?/g)) if (!/^\$[\d,]+\.\d{2}$/.test(m[0].replace(/\s/g, ''))) moneyBad.push(`${label}: ${m[0]}`);
      if (/\bcredits?\b/i.test(t)) chromeBad.push(`${label}: credit`);
      if (/upgrade|subscribe|subscription|premium|pick a plan|choose a plan|pro plan|limited[- ]time|\d+% off|flash sale|ends (in|today)|hurry|last chance|best value|most popular/i.test(t)) chromeBad.push(`${label}: ${(/upgrade|subscribe|subscription|premium|pick a plan|choose a plan|pro plan|limited[- ]time|\d+% off|flash sale|ends (in|today)|hurry|last chance|best value|most popular/i.exec(t) ?? [''])[0]}`);
      const struck = await p.eval<number>(`[...document.querySelectorAll('s, strike, del')].filter((e) => !e.closest('.ant-drawer')).length + [...document.querySelectorAll('main *')].filter((e) => getComputedStyle(e).textDecorationLine === 'line-through' && /\\$/.test(e.textContent || '')).length`);
      if (struck) chromeBad.push(`${label}: struck-out text`);
    }
    check(moneyBad.length === 0, 'O14 every dollar figure on 5 screens is written like $4.37 (two decimals, no long decimals)', moneyBad.slice(0, 4).join(' | '));
    check(chromeBad.length === 0, 'O14 no "credits", plan upsell, struck-out price or countdown on 5 screens', chromeBad.join(' | '));

    // -------- browse 20 jobs and open 10 details: nothing is charged, no AI request is made
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(900);
    for (let i = 0; i < 6; i++) { await p.eval(`document.querySelector('#jl-feed-scroll').scrollBy(0, 900)`); await sleep(200); }
    const list = await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 20 } });
    p.clearRequests();
    for (const it of list.items.slice(0, 10)) {
      await p.eval(`location.hash = '#/jobs/${encodeURIComponent(it.job.id)}'`);
      await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
      await sleep(350);
    }
    await p.eval(`location.hash = '#/jobs'`);
    const aiPosts = p.requests().filter((r) => r.method === 'POST' && /\/ai\/chat|\/tailor|\/cover|\/draft|\/practice|\/refresh/.test(r.url));
    check(aiPosts.length === 0 && ledger(demo).length === 0, 'O14 browsing 20 jobs and opening 10 details starts no AI step and charges nothing', `${aiPosts.length} AI requests, ${ledger(demo).length} charges`);
    check((await p.eval<Array<{ since: number }>>('window.__pops')).length === 0, 'O14 no popup, drawer or dialog opened by itself while browsing');

    // -------- tailor 1 resume: the note names the charge BEFORE the click, one click, one charge
    const job = list.items[0]!.job;
    const clicksBefore = ledger(demo).length;
    await p.eval(`location.hash = '#/jobs/${encodeURIComponent(job.id)}'`);
    await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
    await sleep(500);
    await p.clickMatching('button', '^Tailor your resume');
    await sleep(900);
    const noteBefore = await p.eval<string>(`[...document.querySelectorAll('.ant-drawer [role=note]')].map((e) => e.innerText).join(' ')`);
    await p.shot(join(dir, '02-tailor-note.png'));
    check(/charges your publik balance/i.test(noteBefore) && /\$0\.01/.test(noteBefore), 'O14 before the click, the tailor step says it charges the balance and shows the expected cost', noteBefore.replace(/\s+/g, ' ').slice(0, 140));
    check(ledger(demo).length === clicksBefore, 'O14 opening the tailor drawer charges nothing');
    await p.clickMatching('button', '^Draft tailored changes');
    await sleep(800);
    const consent = await p.eval<string>(`(document.querySelector('.ant-modal-confirm') || {}).innerText || ''`);
    await p.shot(join(dir, '03-consent.png'));
    check(/publik/i.test(consent) && /Send to publik/i.test(consent), 'O14 the first time text goes to a service, a question names the service', consent.replace(/\s+/g, ' ').slice(0, 140));
    check(ledger(demo).length === clicksBefore, 'O14 nothing is charged while that question is open');
    await p.clickMatching('.ant-modal-confirm button', '^Send to publik');
    await p.waitFor("document.querySelector('.ant-drawer .jl-factbox input[type=checkbox], .ant-drawer .ant-alert')", 15000);
    await sleep(800);
    check(ledger(demo).length === clicksBefore + 1, 'O14 one click on "Draft tailored changes" made exactly one charge', `${ledger(demo).length - clicksBefore} new charges`);
    check(/Balance: \$4\.36/.test(await balanceChip(p)), 'O14 the balance on screen follows the charge at once ($4.36)', await balanceChip(p));
    await p.press('Escape');
    await sleep(400);
    if (await p.eval<boolean>(`!!document.querySelector('.ant-modal-confirm')`)) await p.clickMatching('.ant-modal-confirm button', 'Discard');
    await sleep(600);

    // -------- draft 1 network message
    const before2 = ledger(demo).length;
    await p.eval(`location.hash = '#/network/people'`);
    await p.waitFor("document.querySelector('.ant-table-row')", 8000);
    await sleep(500);
    await p.clickMatching('.ant-table-row button', '^Draft');
    await sleep(800);
    const noteMsg = await p.eval<string>(`[...document.querySelectorAll('.ant-modal [role=note]')].map((e) => e.innerText).join(' ')`);
    check(/charges your publik balance/i.test(noteMsg) && /\$0\.01/.test(noteMsg), 'O14 before the click, the message draft says it charges the balance and shows the expected cost', noteMsg.replace(/\s+/g, ' ').slice(0, 140));
    check(ledger(demo).length === before2, 'O14 opening the message window charges nothing');
    await p.clickMatching('.ant-modal button', '^Draft a message');
    await p.waitFor("document.querySelector('textarea[aria-label=\"Message text\"]')", 15000);
    await sleep(600);
    check(ledger(demo).length === before2 + 1, 'O14 one click on "Draft a message" made exactly one charge', `${ledger(demo).length - before2} new charges`);
    const sentNothing = p.requests().filter((r) => r.method === 'POST' && /\/send|\/message\b/.test(r.url));
    check(sentNothing.length === 0, 'O14 jobleft sends no message on its own (the person copies the draft)');
    await p.press('Escape');
    await sleep(500);

    // -------- 3 chat turns
    const before3 = ledger(demo).length;
    await p.eval(`location.hash = '#/assistant'`);
    await sleep(900);
    const noteChat = await p.eval<string>(`[...document.querySelectorAll('.jl-chat-input [role=note]')].map((e) => e.innerText).join(' ')`);
    check(/charges your publik balance/i.test(noteChat) && /\$0\.01/.test(noteChat), 'O14 the chat says before each turn that it charges the balance, with the expected cost', noteChat.replace(/\s+/g, ' ').slice(0, 140));
    // a suggested question only fills the box
    await p.clickMatching('button', '^Which skills come up most');
    await sleep(400);
    check(ledger(demo).length === before3, 'O14 a suggested question only fills the box: nothing is sent or charged until Send', `${ledger(demo).length - before3} charges`);
    await p.eval(`document.querySelector('textarea[aria-label="Message to the assistant"]').value = ''`);
    await sendChat(p, 'Which skills come up most in the jobs I liked?');
    await sendChat(p, 'Help me plan my job search this week.');
    await sendChat(p, 'How do I explain a gap in my work history?');
    await p.shot(join(dir, '04-chat.png'));
    check(ledger(demo).length === before3 + 3, 'O14 three chat turns made exactly three charges', `${ledger(demo).length - before3} new charges`);
    const bal5 = await balanceChip(p);
    check(/Balance: \$4\.32/.test(bal5), 'O14 after 5 paid clicks the balance reads $4.32 (no long decimal, no old figure)', bal5);

    // -------- a chat suggestion never edits the saved preferences without a click on Apply
    const fresh = (await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 40 } })).items.map((i) => i.job).find((j) => !seeded.liked.includes(j.id) && !seeded.applied.includes(j.id))!;
    const prefsBefore = JSON.stringify((await demo.api.call('getProfile')).preferences);
    await p.eval(`location.hash = '#/jobs/${encodeURIComponent(fresh.id)}'`);
    await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
    await sleep(500);
    await p.clickMatching('button', '^Ask the assistant');
    await sleep(700);
    await p.eval(`document.querySelector('.jl-chatpanel textarea').focus()`);
    await p.type('Please mark this job as applied and add a note: call on Friday');
    await p.press('Enter');
    await p.waitFor(`document.querySelector('.jl-chatpanel [aria-label="Suggested changes"]')`, 20000);
    await sleep(500);
    const trackerMid = await demo.api.call('getJob', { params: { jobId: fresh.id } });
    check(!trackerMid.tracker?.status && !(trackerMid.tracker?.notes.length), 'O14 the assistant suggests a status and a note but changes nothing until the person applies them', `status ${trackerMid.tracker?.status ?? 'none'}`);
    await p.shot(join(dir, '05-proposal.png'));
    check(JSON.stringify((await demo.api.call('getProfile')).preferences) === prefsBefore, 'O14 the saved preferences are unchanged by a chat suggestion');
    await p.press('Escape');
    await sleep(400);

    // -------- popups: none opened without a click (the question and drawers above all followed one)
    const pops = await p.eval<Array<{ since: number; what: string; text: string }>>('window.__pops');
    const auto = pops.filter((x) => x.since > 2500);
    check(auto.length === 0, 'O14 no popup opened without a click during the whole session', `${pops.length} popups, ${auto.length} without a click: ${auto.map((x) => x.text).join(' | ').slice(0, 120)}`);

    // -------- too little balance: the message says "balance" (the service says "credits")
    const beforeZero = ledger(demo).length;
    check(beforeZero === before3 + 4, 'O14 the ledger holds one line per paid click so far (tailor, draft, 3 chat turns, 1 chat turn for the suggestion)', `${beforeZero} lines`);
    ctl(demo, 'balance', '0');
    await p.eval(`location.hash = '#/assistant'`);
    await sleep(800);
    await sendChat(p, 'One more question');
    const err0 = await p.eval<string>(`[...document.querySelectorAll('[role=alert]')].map((e) => e.innerText).join(' | ')`);
    await p.shot(join(dir, '06-balance-low.png'));
    check(/balance/i.test(err0) && !/credit/i.test(err0) && !/HTTP|\b402\b|\{/.test(err0), 'O14 with no balance left the message says "balance", never "credits", and no raw status', err0.replace(/\s+/g, ' ').slice(0, 160));
    const chargesAfterZero = ledger(demo).length;
    check(chargesAfterZero === beforeZero, 'O14 nothing was charged when the balance was too low');
    const all0 = await p.eval<string>(CHROME_TEXT);
    check(!/credit/i.test(all0), 'O14 the word "credit" is nowhere on that screen', (/.{0,30}credit.{0,30}/i.exec(all0) ?? [''])[0]);

    // -------- a model on this computer: no balance prompt blocks an AI action
    await demo.api.call('putAiSettings', { body: { provider: 'local', localKind: 'openai_compatible', baseUrl: 'http://127.0.0.1:47911/v1', model: 'standin-7b' } });
    await p.eval('location.reload()');
    await p.waitFor("document.querySelector('.jl-shell')", 10000);
    await p.eval(`location.hash = '#/assistant'`);
    await sleep(1200);
    const chip = await balanceChip(p);
    check(!/Balance/.test(chip) && /Mac|model|AI/.test(chip), 'O14 with a local model the header does not show a balance', chip);
    const noteLocal = await p.eval<string>(`[...document.querySelectorAll('.jl-chat-input [role=note]')].map((e) => e.innerText).join(' ')`);
    check(/nothing leaves this Mac/i.test(noteLocal) && /nothing is charged/i.test(noteLocal), 'O14 the chat says that nothing leaves this Mac and nothing is charged (local model)', noteLocal.replace(/\s+/g, ' ').slice(0, 140));
    await sendChat(p, 'Does a local model need a balance?');
    const answered = await p.eval<string>(`[...document.querySelectorAll('.jl-bubble.assistant')].map((e) => e.innerText).join(' ')`);
    const modal = await p.eval<boolean>(`!!document.querySelector('.ant-modal-confirm, .ant-modal')`);
    check(answered.length > 20 && !modal && !/balance is too low|add money/i.test(answered), 'O14 with a zero balance and a local model, the AI still answers and nothing blocks it', answered.replace(/\s+/g, ' ').slice(0, 100));
    check(ledger(demo).length === chargesAfterZero, 'O14 the local model made no charge');
    // the local-model tailor/draft screens also show no charge note
    await p.eval(`location.hash = '#/jobs/${encodeURIComponent(job.id)}'`);
    await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
    await sleep(400);
    await p.clickMatching('button', '^Tailor your resume');
    await sleep(700);
    const noteLocalTailor = await p.eval<string>(`[...document.querySelectorAll('.ant-drawer [role=note]')].map((e) => e.innerText).join(' ')`);
    check(!/charges your publik balance/i.test(noteLocalTailor) && /nothing (leaves|is charged)/i.test(noteLocalTailor), 'O14 the tailor note for a local model says nothing is charged', noteLocalTailor.replace(/\s+/g, ' ').slice(0, 120));
    void seeded;
  } finally {
    await b.close();
  }
}
