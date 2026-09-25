// End-to-end checks in headless Google Chrome with a scratch profile: the real built extension, the stand-in app
// and the practice pages. Every click on the extension's panel is a trusted mouse click; the toolbar button is
// pressed through DevTools (Extensions.triggerAction), which is what grants activeTab.
//
//   node scripts/build.ts && node scripts/e2e.ts [--only <name,...>] [--shots <dir>]
// Needs: Google Chrome at /Applications/Google Chrome.app (or JOBLEFT_CHROME), free ports 47821-47830 and 47900.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Browser, type Page } from './cdp.ts';
import { appCall, dump, launch, openPopup, pair, panelText, practiceLog, pressFill, startApp, startPractice, waitFor } from './harness.ts';

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set((args[args.indexOf('--only') + 1] ?? '').split(',')) : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] ?? null : null;
if (shots) mkdirSync(shots, { recursive: true });

const P = 'http://127.0.0.1:47900/practice';
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  PASS ${name}`); } else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}

type Dump = Array<{ id: string; name: string; type: string; value: unknown }>;
const val = (d: Dump, key: string): unknown => d.find((x) => x.id === key || x.name === key)?.value;
const radios = (d: Dump, name: string): boolean[] => d.filter((x) => x.name === name).map((x) => x.value as boolean);

async function shot(tab: Page, name: string): Promise<void> {
  if (shots) writeFileSync(join(shots, `${name}.png`), await tab.screenshot());
}

async function fillAndWait(s: Ctx, tab: Page, resumeId?: string): Promise<string> {
  const popup = await pressFill(s, tab, resumeId);
  await waitFor(async () => /Done\.|Stopped|did not run|Undone/.test(await panelText(tab)), 30000);
  await new Promise((r) => setTimeout(r, 400));
  return `${popup}\n${await panelText(tab)}`;
}

/** Submit, Next and page-change events logged by THIS page load (tabs closed later log their own page change). */
async function pageEvents(tab: Page): Promise<Array<{ kind: string; path: string; detail: string }>> {
  const search = await tab.eval<string>('location.search');
  return (await practiceLog()).entries.filter((e) => e.path.includes(search) && ['submit', 'next', 'page-change'].includes(e.kind));
}

async function typeInto(tab: Page, id: string, text: string): Promise<void> {
  await tab.eval(`document.getElementById(${JSON.stringify(id)}).focus()`);
  await tab.send('Input.insertText', { text });
  await tab.eval(`document.getElementById(${JSON.stringify(id)}).blur()`);
}

interface Ctx { browser: Browser; extId: string; appPort: number; appToken: string; app: ChildProcess; home: string }

const swUrls: string[] = [];
async function watchWorker(b: Browser, extId: string): Promise<void> {
  const t = await b.waitTarget((x) => x.type === 'service_worker' && x.url.includes(extId), 10000);
  const r = await b.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  b.on((m) => { if (m.sessionId === r.sessionId && m.method === 'Network.requestWillBeSent') swUrls.push(String((m.params.request as { url: string }).url)); });
  await b.send('Network.enable', {}, r.sessionId);
}

async function main(): Promise<void> {
  const home = '/private/tmp/jl-e2e-app';
  rmSync(home, { recursive: true, force: true });
  let app = await startApp(home);
  const practice = await startPractice();
  const { browser, extId } = await launch();
  await watchWorker(browser, extId).catch(() => console.log('  (could not watch the service worker network)'));
  const s: Ctx = { browser, extId, appPort: app.port, appToken: app.token, app: app.proc, home };
  const want = (n: string): boolean => !only || only.has(n);
  // A tracking parameter makes each tab's address unique without changing which job it is.
  // Tabs are closed as the checks go on, so the headless browser does not run out of memory.
  const open: Page[] = [];
  const fresh = async (page: string): Promise<Page> => {
    while (open.length > 2) await open.shift()?.close();
    const p = await browser.newPage(`${P}/${page}?utm_term=${Date.now()}`);
    open.push(p);
    return p;
  };
  const appLog = async (): Promise<string[]> => ((await appCall(s, 'GET', '/api/v1/standin/log')) as { lines: string[] }).lines;
  const state = async (): Promise<{ tracker: Array<{ jobId: string; resumeId: string | null; appliedAt: string }>; pairings: unknown[]; drafts: { balanceMicros: number } }> =>
    appCall(s, 'GET', '/api/v1/standin/state') as never;

  try {
    // ------------------------------------------------ O1, O12: nothing before pairing
    {
      console.log('unpaired: the extension asks to pair and changes nothing');
      const tab = await fresh('job-a.html');
      const before = await dump(tab);
      const pop = await openPopup(browser, extId, tab);
      const text = await pop.eval<string>('document.body.innerText');
      if (shots) writeFileSync(join(shots, '00-popup-unpaired.png'), await pop.screenshot());
      check('popup asks for pairing', /not paired/.test(text));
      check('popup says what it reads before pairing', /What jobleft reads/.test(text) && /only to the jobleft app/.test(text));
      check('no Fill button before pairing', !/Fill this application/.test(text));
      check('page unchanged before pairing', JSON.stringify(await dump(tab)) === JSON.stringify(before));
      check('app got no page address or fill before pairing', !(await appLog()).some((l) => /extension\/(page|fill)/.test(l)));
      await shot(tab, '01-unpaired');
      const r = await pair(s, tab);
      check('pairing works with the code from the app', /Paired with jobleft/.test(r));
      check('the app lists one paired browser', (await state()).pairings.length === 1);
    }

    // ------------------------------------------------ O3, O4, O5, O7, O9, O10, O11 on job A
    if (want('joba')) {
      console.log('job A: fill, traps, typed values, report');
      await fetch('http://127.0.0.1:47900/__reset', { method: 'POST' });
      const tab = await fresh('job-a.html');
      await typeInto(tab, 'phone', '512-555-0199');
      await typeInto(tab, 'location', 'Round Rock');
      const before = await dump(tab);
      const contexts: Array<{ id: number; name: string; type: string }> = [];
      browser.on((m) => {
        if (m.sessionId === tab.sessionId && m.method === 'Runtime.executionContextCreated') {
          const c = m.params.context as { id: number; name: string; auxData?: { type?: string } };
          contexts.push({ id: c.id, name: c.name, type: c.auxData?.type ?? '' });
        }
      });
      const report = await fillAndWait(s, tab);
      const d = await dump(tab);
      await shot(tab, '02-job-a-filled');
      // The pairing key is out of reach of the page AND of the extension's own content script.
      const iso = contexts.find((c) => c.type === 'isolated' && /jobleft/i.test(c.name));
      if (iso) {
        const r = await tab.send<{ result: { value?: string }; exceptionDetails?: unknown }>('Runtime.evaluate', {
          contextId: iso.id, awaitPromise: true, returnByValue: true,
          expression: `chrome.storage.local.get(null).then(function(v){ return JSON.stringify(v); }, function(e){ return 'refused: ' + e.message; })`,
        }).catch((e: Error) => ({ result: { value: `refused: ${e.message}` } }));
        const v = String(r.result.value ?? '');
        check('content script cannot read the pairing key', !/pairingToken|"token"/.test(v), v.slice(0, 80));
      } else {
        check('content script context found for the key check', false, JSON.stringify(contexts.slice(0, 5)));
      }
      const pageSees = await tab.eval<string>(`typeof chrome === 'undefined' || !chrome.storage ? 'no storage' : 'storage'`);
      check('the page itself has no extension storage', pageSees === 'no storage', pageSees);
      check('first name', val(d, 'first_name') === 'Jordan');
      check('last name', val(d, 'last_name') === 'Testwell');
      check('email', val(d, 'email') === 'jordan.testwell@example.com');
      check('typed phone kept', val(d, 'phone') === '512-555-0199', String(val(d, 'phone')));
      check('typed location kept', val(d, 'location') === 'Round Rock', String(val(d, 'location')));
      check('report lists kept fields', /Kept as they were/i.test(report) && /Round Rock/.test(report));
      check('resume for job A attached', String(val(d, 'resume')).startsWith('Jordan_Testwell_Resume_SoftwareEngineer.pdf'), String(val(d, 'resume')));
      check('report names the attached file', /Resume attached: Jordan_Testwell_Resume_SoftwareEngineer\.pdf/.test(report));
      check('cover letter box empty', val(d, 'cover_letter') === '');
      check('country: United States, not the Minor Outlying Islands', val(d, 'country') === 'United States', String(val(d, 'country')));
      check('state: Texas', val(d, 'state') === 'Texas');
      check('degree: Bachelor of Science (not Arts)', val(d, 'degree') === 'Bachelor of Science', String(val(d, 'degree')));
      check('start month from profile', val(d, 'edu_start_month') === 'August', String(val(d, 'edu_start_month')));
      check('second education block stays empty', val(d, 'school2') === '' && val(d, 'degree2') === '', `${val(d, 'school2')}/${val(d, 'degree2')}`);
      check('middle name, preferred name, GitHub, certification, Kubernetes years stay empty',
        ['middle_name', 'preferred_name', 'github', 'certification', 'k8s'].every((k) => val(d, k) === ''));
      check('traps: hidden SSN, Phone, Address boxes stay empty', ['trap_phone', 'trap_address', 'trap_ssn', 'outside_ssn', 'trap_hidden_email'].every((k) => val(d, k) === ''));
      check('job alert form stays empty', val(d, 'alert_name') === '' && val(d, 'alert_email') === '');
      check('comments box stays empty (page text does not steer)', val(d, 'comments') === '');
      check('referrer fields stay empty', val(d, 'ref_name') === '' && val(d, 'ref_email') === '');
      check('sensitive questions stay empty', ['gender', 'hispanic', 'race', 'veteran', 'disability'].every((k) => /select/i.test(String(val(d, k)))) && radios(d, 'q_auth').every((x) => !x) && radios(d, 'q_sponsor').every((x) => !x));
      check('pay and date of birth stay empty', val(d, 'salary') === '' && val(d, 'dob') === '');
      check('open questions stay empty after the fill', val(d, 'why') === '' && val(d, 'project') === '');
      check('consent and job-alert boxes not ticked', val(d, 'consent') === false && val(d, 'alerts_opt') === false);
      check('report offers two drafts', (report.match(/Insert into the form/g) ?? []).length === 2);
      check('report: needs-you items listed with reasons', /Salary expectations[\s\S]*never answers it/.test(report));
      check('report does not list the hidden traps as filled', !/\bSSN\b[\s\S]{0,40}filled/.test(report));
      const ev1 = await pageEvents(tab);
      check('no submit, no Next, no page change', ev1.length === 0, JSON.stringify(ev1));

      console.log('job A: undo');
      const clicked = await tab.clickDeep('button', 'Undo fill');
      await waitFor(async () => /Undone/.test(await panelText(tab)), 8000);
      const u = await dump(tab);
      await shot(tab, '03-job-a-undone');
      check('undo button pressed', clicked);
      check('undo puts the page back (typed values kept, resume removed)', JSON.stringify(u) === JSON.stringify(before), diff(before, u));

      console.log('job A: fill again, accept one draft');
      await fillAndWait(s, tab);
      const draftText = (await tab.textsDeep('textarea[aria-label^="Draft for Why"]'))[0] ?? '';
      void draftText;
      await tab.clickDeep('button', 'Insert into the form');
      await new Promise((r) => setTimeout(r, 600));
      const d2 = await dump(tab);
      check('accepted draft goes into its own box only', String(val(d2, 'why')).length > 20 && val(d2, 'project') === '' && val(d2, 'comments') === '', `${String(val(d2, 'why')).slice(0, 40)}|${val(d2, 'project')}`);
      check('draft has no contact details', !/555-01|jordan\.testwell@|Round Rock/.test(String(val(d2, 'why'))));
      await shot(tab, '04-job-a-draft-inserted');

      console.log('job A: the person confirms they submitted');
      check('no tracker entry after fills alone', (await state()).tracker.length === 0);
      await tab.clickDeep('button', 'I submitted this application');
      await new Promise((r) => setTimeout(r, 300));
      await tab.clickDeep('button', 'Yes, I submitted it');
      await waitFor(async () => /Saved: your jobleft tracker/.test(await panelText(tab)), 8000);
      const st = await state();
      check('one Applied entry for job A with its resume', st.tracker.length === 1 && st.tracker[0]?.jobId === 'job-a' && st.tracker[0]?.resumeId === 'res-job-a', JSON.stringify(st.tracker));
      const tab2 = await browser.newPage(`${P}/job-a.html?utm_source=newsletter&gh_src=abc&utm_term=${Date.now()}`);
      const pop = await openPopup(browser, extId, tab2);
      if (shots) writeFileSync(join(shots, '00-popup-paired-applied.png'), await pop.screenshot());
      check('popup says already applied (link with tracking parameters)', /already marked this job as applied/.test(await pop.eval<string>('document.body.innerText')));
      await fillAndWait(s, tab2);
      await tab2.clickDeep('button', 'I submitted it again');
      await new Promise((r) => setTimeout(r, 300));
      await tab2.clickDeep('button', 'Yes, I submitted it');
      await waitFor(async () => /Saved: your jobleft tracker/.test(await panelText(tab2)), 8000);
      check('a second confirm keeps one entry', (await state()).tracker.length === 1);
      const ev2 = [...await pageEvents(tab), ...await pageEvents(tab2)];
      check('still no submit, Next or page change after all of it', ev2.length === 0, JSON.stringify(ev2));
    }

    // ------------------------------------------------ O6: one saved answer changes one question
    if (want('sensitive')) {
      console.log('sensitive: a saved veteran answer, and a changed phone number');
      const st = await appCall(s, 'GET', '/api/v1/standin/state') as { profile: Record<string, unknown> & { eeo: Record<string, unknown>; personal: Record<string, unknown> } };
      const p = { ...st.profile };
      delete p.id; delete p.version; delete p.updatedAt;
      p.eeo = { ...st.profile.eeo, veteran: 'no' };
      p.personal = { ...st.profile.personal, phone: '555-0142' };
      await appCall(s, 'PUT', '/api/v1/standin/profile', p);
      const tab = await fresh('job-a.html');
      await fillAndWait(s, tab);
      const d = await dump(tab);
      check('veteran question gets the exact saved choice', val(d, 'veteran') === 'I am not a protected veteran', String(val(d, 'veteran')));
      check('other sensitive questions still empty', ['gender', 'hispanic', 'race', 'disability'].every((k) => /select/i.test(String(val(d, k)))));
      check('the new phone number goes in', val(d, 'phone') === '555-0142', String(val(d, 'phone')));
    }

    // ------------------------------------------------ O15: a paid draft shows its price first
    if (want('price')) {
      console.log('drafts with a paid provider (simulated)');
      await appCall(s, 'PUT', '/api/v1/standin/draft-provider', { kind: 'publik_sim', priceMicros: 10_000, balanceMicros: 1_000_000 });
      const tab = await fresh('job-a.html');
      const rep = await fillAndWait(s, tab);
      check('price in dollars shown before any draft', /Make drafts \(\$0\.02\)/.test(rep) && /Your balance: \$1\.00/.test(rep), rep.slice(0, 0));
      check('no draft made before the click', !/Insert into the form/.test(rep));
      check('the word "credit" never shows', !/credit/i.test(rep));
      await tab.clickDeep('button', 'Make drafts');
      await waitFor(async () => /Insert into the form/.test(await panelText(tab)), 10000);
      const st = await state();
      check('balance fell by no more than the price', st.drafts.balanceMicros >= 980_000 && st.drafts.balanceMicros < 1_000_000, String(st.drafts.balanceMicros));
      check('report says what it cost', /cost \$0\.02 from your balance/.test(await panelText(tab)));
      await appCall(s, 'PUT', '/api/v1/standin/draft-provider', { kind: 'local' });
    }

    // ------------------------------------------------ other pages
    if (want('jobb')) {
      console.log('job B (Lever-shaped): the resume made for job B');
      const tab = await fresh('job-b.html');
      const rep = await fillAndWait(s, tab);
      const d = await dump(tab);
      await shot(tab, '05-job-b');
      check('full name in one box', val(d, 'name') === 'Jordan Testwell');
      check('current company', val(d, 'org') === 'Northwind Sample Labs');
      check('job B resume attached (not job A)', String(val(d, 'resume')).startsWith('Jordan_Testwell_Resume_BackendEngineer.pdf'), String(val(d, 'resume')));
      check('GitHub and Other website stay empty', val(d, 'urls[GitHub]') === '' && val(d, 'urls[Other]') === '');
      check('pronouns stay empty (not saved)', val(d, 'pronouns') === '');
      check('additional information box stays empty', val(d, 'comments') === '');
      check('Lever EEO selects stay empty', /select/i.test(String(val(d, 'eeo[gender]'))) && /select/i.test(String(val(d, 'eeo[race]'))));
      void rep;
    }
    if (want('ashby')) {
      console.log('Ashby-shaped: custom dropdowns and hidden radios');
      const tab = await fresh('ashby-like.html');
      const rep = await fillAndWait(s, tab);
      const d = await dump(tab);
      await shot(tab, '06-ashby-like');
      const combos = d.filter((x) => x.type === 'combo').map((x) => String(x.value));
      check('name', val(d, '_systemfield_name') === 'Jordan Testwell');
      check('country dropdown: United States', combos[0] === 'United States', JSON.stringify(combos));
      check('location dropdown: Austin, Texas (not Minnesota or Arkansas)', combos[1] === 'Austin, Texas, United States', JSON.stringify(combos));
      check('degree dropdown with no B.S. option stays empty', combos[2] === '', JSON.stringify(combos));
      check('report says the degree list has no match', /Highest degree[\s\S]{0,120}(No option|not filled)/.test(rep));
      check('work authorization buttons untouched (no saved answer)', radios(d, 'authorized').every((x) => !x));
      const savedVet = ((await appCall(s, 'GET', '/api/v1/standin/state')) as { profile: { eeo: { veteran: string | null } } }).profile.eeo.veteran;
      const wantVet = savedVet === 'no' ? [false, true, false] : [false, false, false];
      check(`veteran buttons: ${savedVet ? 'only the saved answer, through the hidden radio' : 'untouched (no saved answer)'}`, JSON.stringify(radios(d, 'vet')) === JSON.stringify(wantVet), JSON.stringify(radios(d, 'vet')));
      check('open question not filled', val(d, 'why') === '');
    }
    if (want('tricky')) {
      console.log('tricky page: no matching option, a self-clearing field, a refused upload, a late section');
      const tab = await fresh('tricky.html');
      const rep = await fillAndWait(s, tab);
      await new Promise((r) => setTimeout(r, 3500));
      const later = await panelText(tab);
      const d = await dump(tab);
      await shot(tab, '07-tricky');
      check('country with no US option stays empty', /choose/i.test(String(val(d, 'country'))));
      check('report: country needs you', /Country[\s\S]{0,80}(needs you|not filled)/.test(rep));
      check('self-clearing field not reported as filled', !/School[^\n]*\n[^\n]*\n?filled/.test(later) && /(cleared by page|not filled)/.test(later), later.slice(0, 0));
      check('upload refused and reported as failed', /Resume not attached: Upload failed/.test(rep));
      check('required fields with no value are "needs you"', /Earliest start date[\s\S]{0,40}needs you/.test(rep) && /Which shift[\s\S]{0,40}needs you/.test(rep));
      check('late section reported', /New fields appeared/.test(later));
    }
    if (want('captcha')) {
      console.log('CAPTCHA page');
      await fetch('http://127.0.0.1:47900/__reset', { method: 'POST' });
      const tab = await fresh('captcha.html');
      const rep = await fillAndWait(s, tab);
      const d = await dump(tab);
      check('panel says a person must complete the human check', /human check \(CAPTCHA\)/.test(rep));
      check('CAPTCHA box untouched', val(d, 'robot') === false && val(d, 'captcha_answer') === '');
      const log = await practiceLog();
      check('no attempt on the CAPTCHA and no submit', !log.entries.some((e) => /captcha box touched/.test(e.detail)) && (await pageEvents(tab)).length === 0);
    }
    if (want('account')) {
      console.log('account sign-up step');
      const tab = await fresh('account.html');
      const rep = await fillAndWait(s, tab);
      const d = await dump(tab);
      check('panel stops at the account step', /sign in or create an account/.test(rep));
      check('every field stays empty, passwords too', ['email', 'fname', 'lname', 'pw', 'pw2'].every((k) => val(d, k) === '') && val(d, 'terms') === false);
    }
    if (want('frames')) {
      console.log('frames');
      const same = await fresh('iframe-same.html');
      const rep = await fillAndWait(s, same);
      const inner = await same.eval<string>(`document.querySelector('iframe').contentDocument.getElementById('first_name').value`);
      const search = await same.eval<string>(`document.getElementById('q').value`);
      check('same-site frame form filled', inner === 'Jordan', inner);
      check('search box beside it stays empty', search === '');
      void rep;
      const cross = await fresh('iframe-cross.html');
      const rep2 = await fillAndWait(s, cross);
      check('form in a frame from another site: panel says so with a link', /frame from another site[\s\S]*http:\/\/localhost:47900\/practice\/frame-form\.html/.test(rep2));
    }
    if (want('workday')) {
      console.log('Workday-shaped page (hand-made)');
      await fetch('http://127.0.0.1:47900/__reset', { method: 'POST' });
      const tab = await fresh('workday-like.html');
      const pop = await openPopup(browser, extId, tab);
      check('popup shows partial for Workday', /partial/.test(await pop.eval<string>('document.body.innerText')));
      const rep = await fillAndWait(s, tab);
      const shown = await tab.eval<string[]>(`Array.from(document.querySelectorAll('button[aria-haspopup]')).map(function(b){return b.textContent})`);
      const d = await dump(tab);
      await shot(tab, '08-workday-like');
      check('Workday: says partial and never 100%', /Workday support is partial: jobleft fills only the step you can see/.test(rep) && /add them yourself/.test(rep));
      check('Workday: names filled', val(d, 'fn') === 'Jordan' && val(d, 'ln') === 'Testwell');
      check('Workday: country list picks United States of America', shown[0] === 'United States of America', JSON.stringify(shown));
      check('Workday: state list picks Texas', shown[1] === 'Texas', JSON.stringify(shown));
      check('Workday: phone device type left for the person', shown[2] === 'Select One', JSON.stringify(shown));
      const log = await practiceLog();
      check('Workday: Save and Continue and Add never pressed, no page change', (await pageEvents(tab)).length === 0 && !log.entries.some((e) => /Add work row/.test(e.detail)));
    }
    if (want('generic')) {
      console.log('hand-made form (not supported)');
      const tab = await fresh('generic.html');
      const pop = await openPopup(browser, extId, tab);
      check('popup shows not supported', /not supported/.test(await pop.eval<string>('document.body.innerText')));
      const rep = await fillAndWait(s, tab);
      const d = await dump(tab);
      check('generic: name, email, phone, town filled', val(d, 'n1') === 'Jordan Testwell' && val(d, 'n2') === 'jordan.testwell@example.com' && val(d, 'n3') === '555-0142' && val(d, 'n4') === 'Austin', JSON.stringify(d.slice(0, 5)));
      check('generic: postcode needs you', val(d, 'n5') === '' && /Postcode[\s\S]{0,40}needs you/.test(rep));
      check('generic: warns to check every field', /not on the supported list/.test(rep));
    }

    // ------------------------------------------------ saved copies of real public application pages
    if (want('recorded')) {
      console.log('saved copies of real application pages');
      await fetch('http://127.0.0.1:47900/__reset', { method: 'POST' });
      const R = 'http://127.0.0.1:47900/recorded';
      const quiet = { ok: true, detail: '' };
      const run = async (file: string): Promise<{ d: Dump; rep: string; popup: string }> => {
        while (open.length) await open.shift()?.close();
        const stamp = `utm_term=${Date.now()}`;
        const tab = await browser.newPage(`${R}/${file}?${stamp}`);
        const popup = await (await openPopup(browser, extId, tab)).eval<string>('document.body.innerText');
        const rep = await fillAndWait(s, tab);
        await shot(tab, `09-${file.replace('.html', '')}`);
        const d = await dump(tab);
        // Read the page's log before closing the tab (closing it is a page change of its own).
        const lg = (await practiceLog()).entries.filter((e) => e.path.includes(stamp) && ['submit', 'next', 'page-change'].includes(e.kind));
        if (lg.length) { quiet.ok = false; quiet.detail += `${file}: ${JSON.stringify(lg)} `; }
        await tab.close();
        return { d, rep, popup };
      };
      const fileOf = (d: Dump): string[] => d.filter((x) => x.type === 'file').map((x) => String(x.value));
      const checkedAny = (d: Dump, pre: string): boolean => d.some((x) => x.type === 'checkbox' && x.id.startsWith(pre) && x.value === true);

      let r = await run('greenhouse-gymshark-embed-1.html');
      check('GH gymshark: popup says Greenhouse supported', /Greenhouse[\s\S]*supported/.test(r.popup));
      check('GH gymshark: names, email, phone', val(r.d, 'first_name') === 'Jordan' && val(r.d, 'last_name') === 'Testwell' && val(r.d, 'email') === 'jordan.testwell@example.com' && /^555-01/.test(String(val(r.d, 'phone'))));
      check('GH gymshark: resume only in the resume box', /^Jordan_Testwell_Resume.*\.pdf/.test(String(val(r.d, 'resume'))) && val(r.d, 'cover_letter') === '');
      check('GH gymshark: preferred name, salary, notice period, why-us stay empty', val(r.d, 'preferred_name') === '' && val(r.d, 'question_9681438101') === '' && val(r.d, 'question_9681439101') === '' && val(r.d, 'question_9681437101') === '');
      check('GH gymshark: demographic consent box not ticked', !r.d.some((x) => x.type === 'checkbox' && x.value === true));
      check('GH gymshark: custom lists that cannot open are reported, not guessed', /did not open for jobleft/.test(r.rep));

      r = await run('greenhouse-brookecharterschools-1.html');
      check('GH brooke: names, email, LinkedIn', val(r.d, 'first_name') === 'Jordan' && val(r.d, 'email') === 'jordan.testwell@example.com' && /linkedin\.com/.test(String(val(r.d, 'question_68333117'))));
      check('GH brooke: race checkboxes untouched', !checkedAny(r.d, 'question_68333122') && !checkedAny(r.d, 'question_68333123'));
      check('GH brooke: resume attached', /^Jordan_Testwell_Resume/.test(String(val(r.d, 'resume'))));

      r = await run('lever-kippsocal-1.html');
      check('Lever kipp: popup says Lever supported', /Lever[\s\S]*supported/.test(r.popup));
      check('Lever kipp: name, email, phone, company', val(r.d, 'name') === 'Jordan Testwell' && val(r.d, 'email') === 'jordan.testwell@example.com' && val(r.d, 'org') === 'Northwind Sample Labs');
      const lf = fileOf(r.d);
      check('Lever kipp: resume in the resume box only (not the portfolio uploads)', /^Jordan_Testwell_Resume/.test(lf[0] ?? '') && lf.slice(1).every((x) => x === ''), JSON.stringify(lf));
      check('Lever kipp: pronoun boxes untouched', !r.d.some((x) => x.name === 'pronouns' && x.value === true));
      check('Lever kipp: EEO gender and race untouched; veteran only with the saved "no"', ['eeo[gender]', 'eeo[race]'].every((k) => /select/i.test(String(val(r.d, k)))) && /select|not/i.test(String(val(r.d, 'eeo[veteran]'))), String(val(r.d, 'eeo[veteran]')));
      check('Lever kipp: labels are the questions, not the widget text', /Resume\/CV/.test(r.rep) && !/Analyzing resume/.test(r.rep));

      r = await run('lever-bluebottlecoffee-1.html');
      check('Lever bluebottle: name and email', val(r.d, 'name') === 'Jordan Testwell' && val(r.d, 'email') === 'jordan.testwell@example.com');
      check('Lever bluebottle: questions in Korean left for the person', /needs you/.test(r.rep));

      r = await run('workable-huggingface-1.html');
      check('Workable 1: popup says Workable supported', /Workable[\s\S]*supported/.test(r.popup));
      check('Workable 1: names, email, summary', val(r.d, 'firstname') === 'Jordan' && val(r.d, 'lastname') === 'Testwell' && val(r.d, 'email') === 'jordan.testwell@example.com' && /Software engineer/.test(String(val(r.d, 'summary'))));
      check('Workable 1: resume attached', fileOf(r.d).some((x) => /^Jordan_Testwell_Resume/.test(x)), JSON.stringify(fileOf(r.d)));
      check('Workable 1: yes/no questions untouched', !r.d.some((x) => x.type === 'radio' && x.value === true));
      check('Workable 1: open questions and cover letter stay empty', r.d.filter((x) => x.type === 'textarea' && /^QA_|cover_letter/.test(x.id)).every((x) => x.value === ''));
      check('Workable 1: a long question naming GitHub is not a GitHub link box', !/Tell us about something you've built[\s\S]{0,400}no GitHub link/.test(r.rep));

      r = await run('workable-huggingface-2.html');
      check('Workable 2: names and email', val(r.d, 'firstname') === 'Jordan' && val(r.d, 'email') === 'jordan.testwell@example.com');
      check('saved copies: no submit, Next or page change while each page was open', quiet.ok, quiet.detail);
    }

    // ------------------------------------------------ O1: app closed, then unpaired
    if (want('lifecycle')) {
      console.log('app closed, restarted, and unpaired');
      app.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      const tab = await fresh('job-a.html');
      const before = await dump(tab);
      const pop = await openPopup(browser, extId, tab);
      const t = await pop.eval<string>('document.body.innerText');
      check('app closed: popup says the app is not running', /not running/.test(t));
      check('app closed: no Fill button', !/Fill this application/.test(t));
      check('app closed: page unchanged', JSON.stringify(await dump(tab)) === JSON.stringify(before));
      app = await startApp(home);
      s.appPort = app.port; s.appToken = app.token; s.app = app.proc;
      const pop2 = await openPopup(browser, extId, tab);
      check('app restarted: still paired', /Paired with jobleft/.test(await pop2.eval<string>('document.body.innerText')));
      const pairings = (await state()).pairings as Array<{ extensionId: string }>;
      await appCall(s, 'DELETE', `/api/v1/extension/pairings/${pairings[0]?.extensionId}`);
      const pop3 = await openPopup(browser, extId, tab);
      const t3 = await pop3.eval<string>('document.body.innerText');
      check('unpaired in the app: popup asks to pair again', /not paired/.test(t3) && !/Fill this application/.test(t3));
      check('unpaired: page unchanged', JSON.stringify(await dump(tab)) === JSON.stringify(before));
    }

    // ------------------------------------------------ O12: never on the three blocked job boards
    if (want('blocked')) {
      console.log('blocked job boards (their host names mapped to a local https practice page)');
      const tls = await startPractice(47943, true);
      const hosts = ['www.linkedin.com', 'uk.linkedin.com', 'www.indeed.com', 'uk.indeed.com', 'www.glassdoor.com', 'www.glassdoor.co.uk'];
      const rules = hosts.map((h) => `MAP ${h} 127.0.0.1:47943`).join(', ');
      // The mapped names skip the test browser's dead proxy; everything else still cannot leave the computer.
      const second = await launch({ args: [`--host-resolver-rules=${rules}`, '--ignore-certificate-errors', `--proxy-bypass-list=${hosts.join(';')}`] });
      const s2 = { browser: second.browser, extId: second.extId, appPort: s.appPort, appToken: s.appToken };
      try {
        const first = await second.browser.newPage(`${P}/job-b.html?utm_term=${Date.now()}`);
        await pair(s2, first);
        const beforeLog = (await appLog()).length;
        for (const h of hosts) {
          const tab = await second.browser.newPage(`https://${h}/practice/blocked.html?utm_term=${Date.now()}`);
          const before = await dump(tab);
          const pop = await openPopup(second.browser, second.extId, tab);
          const t = await pop.eval<string>('document.body.innerText');
          if (shots && h === 'www.linkedin.com') writeFileSync(join(shots, '00-popup-blocked.png'), await pop.screenshot());
          check(`${h}: popup says jobleft does not work here, no Fill button`, /does not work on this site/.test(t) && !/Fill this application/.test(t), t.slice(0, 120));
          check(`${h}: page unchanged`, JSON.stringify(await dump(tab)) === JSON.stringify(before));
        }
        const newLines = (await appLog()).slice(beforeLog);
        check('blocked boards: the app got nothing about those pages', !newLines.some((l) => /extension\/(page|fill)/.test(l)), newLines.join(' | '));
      } finally {
        await second.browser.close();
        tls.kill();
      }
    }

    // ------------------------------------------------ O2: the extension talks only to the app
    console.log('network');
    const others = swUrls.filter((u) => !/^http:\/\/127\.0\.0\.1:478(2[1-9]|30)\/api\/v1\//.test(u));
    check(`service worker requests go only to the app (${swUrls.length} seen)`, swUrls.length > 0 && others.length === 0, others.slice(0, 5).join(' '));
  } finally {
    await browser.close();
    try { app.proc.kill(); } catch { /* ignore */ }
    practice.kill();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

function diff(a: Dump, b: Dump): string {
  const out: string[] = [];
  a.forEach((x, i) => { const y = b[i]; if (!y || JSON.stringify(x.value) !== JSON.stringify(y.value)) out.push(`${x.id || x.name}: ${JSON.stringify(x.value)} -> ${JSON.stringify(y?.value)}`); });
  return out.slice(0, 6).join('; ');
}

await main();
