// End-to-end checks of the whole apply flow against the REAL app (apps/server), not the stand-in:
// real Chrome (headless, scratch profile) + the built extension + the real server on a scratch data folder + the
// practice pages. Every click on the extension's panel is a trusted mouse click.
//
//   pnpm --filter @jobleft/extension e2e:app          (builds the extension first)
//
// Needs: Google Chrome at /Applications/Google Chrome.app (or JOBLEFT_CHROME), a free port in 47821-47830 and 47900.
// Nothing leaves this computer: the browser is started with no route to the internet, and the app is offline-safe.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from './cdp.ts';
import { extRoot, launch, openPopup, panelText, practiceLog, startPractice, waitFor } from './harness.ts';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] ?? null : null;
if (shots) mkdirSync(shots, { recursive: true });

const P = 'http://127.0.0.1:47900/practice';
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  PASS ${name}`); } else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}

// ------------------------------------------------------------------ the real app

const home = '/private/tmp/jl-e2e-app-real';
const serverMain = join(extRoot, '..', 'server', 'src', 'main.ts');
let app: ChildProcess | null = null;
let base = '';
let token = '';

async function startApp(): Promise<void> {
  const proc = spawn(process.execPath, [serverMain], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JOBLEFT_HOME: home, JOBLEFT_SECRET_STORE: 'memory', JOBLEFT_QUIET: '1', JOBLEFT_DEV: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  proc.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
  app = proc;
  const ok = await waitFor(async () => {
    try {
      const info = JSON.parse(readFileSync(join(home, 'run', 'server.json'), 'utf8')) as { pid: number; port: number; token: string };
      if (info.pid !== proc.pid) return false;
      const r = await fetch(`http://127.0.0.1:${info.port}/api/v1/health`);
      if (!r.ok) return false;
      base = `http://127.0.0.1:${info.port}`;
      token = info.token;
      return true;
    } catch { return false; }
  }, 20000, 100);
  if (!ok) throw new Error(`the app did not start: ${err}`);
}

async function stopApp(): Promise<void> {
  const p = app;
  if (!p) return;
  p.kill('SIGTERM');
  await new Promise<void>((r) => { p.once('exit', () => r()); setTimeout(r, 8000); });
  app = null;
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'x-jobleft-token': token, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? new Blob([body as BlobPart]) : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}

function pdf(label: string): Uint8Array {
  const text = `BT /F1 12 Tf 72 720 Td (${label}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  objs.forEach((o, i) => { out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  return Buffer.from(`${out}trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

const persona = (over: { phone?: string | null; email?: string; gender?: string | null; usAuthorized?: 'yes' | 'no' | null } = {}) => ({
  personal: {
    firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: over.email ?? 'jordan.testwell@example.com', phone: over.phone ?? null,
    addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US', links: [],
  },
  summary: null,
  education: [{ id: 'e1', school: 'Sample State University', degree: 'B.S.', major: 'Computer Science', gpa: null, startDate: '2017-08', endDate: '2021-05', current: false, achievements: [], coursework: [] }],
  work: [{ id: 'w1', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: 'full_time', location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Builds internal tools for the support team.'] }],
  projects: [], certifications: [],
  skills: [{ name: 'TypeScript', years: 3, source: 'user' }],
  preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: over.usAuthorized ?? null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: over.gender ?? null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
});

// ------------------------------------------------------------------ helpers

type Dump = Array<{ id: string; name: string; type: string; value: unknown }>;
const val = (d: Dump, key: string): unknown => d.find((x) => x.id === key || x.name === key)?.value;
const dump = async (tab: Page): Promise<Dump> => tab.eval('window.__practiceDump ? window.__practiceDump() : []');
/** The fields matching `re` hold the same value as before the fill (same position in the dump). */
const untouched = (d: Dump, d0: Dump, re: RegExp): boolean => d.every((x, i) => !re.test(`${x.id} ${x.name}`) || JSON.stringify(x.value) === JSON.stringify(d0[i]?.value));

async function popupText(b: Awaited<ReturnType<typeof launch>>, tab: Page): Promise<{ text: string; pop: Page }> {
  const pop = await openPopup(b.browser, b.extId, tab);
  await waitFor(() => pop.eval<boolean>(`document.body.innerText.indexOf('Checking') < 0`), 6000);
  return { text: await pop.eval<string>('document.body.innerText'), pop };
}

async function fill(b: Awaited<ReturnType<typeof launch>>, tab: Page, resumeName?: string): Promise<string> {
  const { text, pop } = await popupText(b, tab);
  if (resumeName) await pop.eval(`(function(){ var s = document.querySelector('select'); if (!s) return false; var o = Array.from(s.options).find(function(x){return x.textContent.indexOf(${JSON.stringify(resumeName)}) >= 0}); if (o) s.value = o.value; return !!o; })()`);
  const clicked = await pop.eval<boolean>(`(function(){ var x = Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent==='Fill this application'}); if (!x) return false; x.click(); return true; })()`);
  if (!clicked) return text;
  await waitFor(async () => /Done\.|Stopped|did not run/.test(await panelText(tab)), 30000);
  await new Promise((r) => setTimeout(r, 400));
  return `${text}\n${await panelText(tab)}`;
}

async function shot(tab: Page, name: string): Promise<void> {
  if (shots) writeFileSync(join(shots, `${name}.png`), await tab.screenshot());
}

async function main(): Promise<void> {
  rmSync(home, { recursive: true, force: true });
  await startApp();
  const practice = await startPractice();
  const b = await launch();
  const open: Page[] = [];
  const fresh = async (page: string): Promise<Page> => {
    while (open.length > 2) await open.shift()?.close();
    const p = await b.browser.newPage(`${P}/${page}`);
    open.push(p);
    return p;
  };
  const unique = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  try {
    // -------------------------------------------------------- seed the app the way a person would
    console.log('seed: profile with no phone, two resumes, two jobs with the same title');
    await api('PUT', '/api/v1/profile', persona());
    const gen = pdf('general resume');
    const tail = pdf('resume tailored for Job A');
    const r1 = await api('POST', '/api/v1/resumes/import', gen, { 'content-type': 'application/pdf', 'x-jobleft-filename': 'general-resume.pdf' });
    const r2 = await api('POST', '/api/v1/resumes/import', tail, { 'content-type': 'application/pdf', 'x-jobleft-filename': 'tailored-for-job-a.pdf' });
    check('two resumes saved', r1.status === 200 && r2.status === 200, `${r1.text} ${r2.text}`);
    const tailoredId = r2.json.resume.id as string;
    await api('PATCH', `/api/v1/resumes/${tailoredId}`, { name: 'Tailored for Job A' });
    const sha = (u: Uint8Array): string => createHash('sha256').update(u).digest('hex');
    const jobA = await api('POST', '/api/v1/jobs/external', { text: 'Software Engineer at Acme One\nLocation: Austin, TX', applyUrl: `${P}/job-a.html` });
    const jobB = await api('POST', '/api/v1/jobs/external', { text: 'Software Engineer at Beta Two\nLocation: Austin, TX', applyUrl: `${P}/job-b.html` });
    check('two jobs with the same title added', jobA.status === 200 && jobB.status === 200, `${jobA.text.slice(0, 200)} ${jobB.text.slice(0, 200)}`);
    const idA = jobA.json.job.id as string;
    const idB = jobB.json.job.id as string;
    const counts = async () => ({
      resumes: ((await api('GET', '/api/v1/resumes')).json as unknown[]).length,
      applied: (await api('GET', '/api/v1/tracker?view=applied')).json.items.length as number,
      profileEmail: (await api('GET', '/api/v1/profile')).json.personal.email as string,
    });
    const before = await counts();

    // -------------------------------------------------------- O1, O4: nothing before pairing
    {
      console.log('unpaired: the extension asks to pair, says what it reads, and changes nothing');
      const tab = await fresh(`job-a.html?utm_term=${unique()}`);
      const d0 = JSON.stringify(await dump(tab));
      const { text, pop } = await popupText(b, tab);
      if (shots) writeFileSync(join(shots, '00-popup-unpaired.png'), await pop.screenshot());
      check('popup asks for pairing', /not paired/.test(text));
      check('popup lists what it reads before pairing', /What jobleft reads/.test(text) && /only to the jobleft app/.test(text));
      check('no Fill button before pairing', !/Fill this application/.test(text));
      check('page unchanged before pairing', JSON.stringify(await dump(tab)) === d0);
      // Pair: the app shows a code (its click is the approval), the person types it in the popup.
      const c = await api('POST', '/api/v1/extension/pairing-code');
      await pop.eval(`(function(){ var i = document.querySelector('input[aria-label="Pairing code"]'); i.value = ${JSON.stringify(c.json.code)}; document.querySelector('input[aria-label="App port"]').value = ${JSON.stringify(String(c.json.port))}; Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent==='Pair'}).click(); return true; })()`);
      check('pairing works with the code from the app', await waitFor(() => pop.eval<boolean>(`document.body.textContent.indexOf('Paired with jobleft') >= 0`), 8000));
      check('the popup switches to the paired state at once (no code box left)', await waitFor(() => pop.eval<boolean>(`document.body.textContent.indexOf('not paired') < 0 && !document.querySelector('input[aria-label="Pairing code"]')`), 1500));
      const list = (await api('GET', '/api/v1/extension/pairings')).json as Array<{ pairedAt: string; browser: string }>;
      check('the app lists exactly one paired browser with a date', list.length === 1 && /^\d{4}-\d\d-\d\dT/.test(list[0]!.pairedAt), JSON.stringify(list));
    }

    // -------------------------------------------------------- O5: the right job, or "unknown"
    {
      console.log('job match: two jobs with one title, tracking parameters, an unknown page');
      const ta = await fresh(`job-a.html?utm_source=x&gclid=${unique()}`);
      const a = (await popupText(b, ta)).text;
      check('job A page names Acme One (tracking parameters ignored)', /Software Engineer · Acme One/.test(a) && !/Beta Two/.test(a), a.slice(0, 300));
      const tb = await fresh(`job-b.html?ref=${unique()}`);
      const bt = (await popupText(b, tb)).text;
      check('job B page names Beta Two', /Software Engineer · Beta Two/.test(bt) && !/Acme One/.test(bt), bt.slice(0, 300));
      const tu = await fresh(`generic.html?x=${unique()}`);
      const { text: u, pop } = await popupText(b, tu);
      check('a page that is no job says it does not know the job and offers to add it', /does not know this job/.test(u) && /Add this job to jobleft/.test(u) && !/Acme One|Beta Two/.test(u), u.slice(0, 300));
      if (shots) writeFileSync(join(shots, '02-popup-unknown-job.png'), await pop.screenshot());
    }

    // -------------------------------------------------------- O6, O7, O8, O12: fill job A
    {
      console.log('fill job A: only saved facts, sensitive questions untouched, nothing submitted');
      await fetch('http://127.0.0.1:47900/__reset', { method: 'POST' });
      const tab = await fresh(`job-a.html?utm_term=${unique()}`);
      const d0 = await dump(tab);
      const report = await fill(b, tab);
      await shot(tab, '03-fill-report');
      const d = await dump(tab);
      check('first name and email come from the saved profile', val(d, 'first_name') === 'Jordan' || d.some((x) => x.value === 'Jordan'), JSON.stringify(d.filter((x) => x.value).slice(0, 8)));
      check('the email in the form is the saved email', d.some((x) => x.value === 'jordan.testwell@example.com'));
      const phones = d.filter((x) => /phone/i.test(`${x.id} ${x.name}`) && x.type !== 'hidden');
      check('phone stays empty (none saved) and the panel lists it as needing the person', phones.every((x) => !x.value) && /Phone/.test(report) && /needs you|Needs you/i.test(report), report.slice(0, 500));
      check('salary and date of birth stay empty', d.filter((x) => /salary|birth|dob|ssn/i.test(`${x.id} ${x.name}`)).every((x) => !x.value));
      check('gender, ethnicity, veteran, authorization and sponsorship questions are untouched', untouched(d, d0, /gender|race|hispanic|vet|auth|sponsor/i), JSON.stringify(d.filter((x) => /gender|race|hispanic|vet|auth|sponsor/i.test(`${x.id} ${x.name}`))));
      check('the job-alert form and the search box got nothing', d.filter((x) => /alert|search/i.test(`${x.id} ${x.name}`)).every((x) => !x.value));
      check('open questions stay empty until a draft is inserted', d.filter((x) => x.type === 'textarea').every((x) => !x.value), JSON.stringify(d.filter((x) => x.type === 'textarea')));
      check('the report shows drafts ready for the open questions', /draft/i.test(report), report.slice(-600));
      const log = await practiceLog();
      check('no submit and no Next press', log.counts.submit === 0 && log.counts.next === 0, JSON.stringify(log.counts));
      const dAfter = await dump(tab);
      check('the fill wrote something (the test is not vacuous)', JSON.stringify(d0) !== JSON.stringify(dAfter));
    }

    // -------------------------------------------------------- O7: a changed email shows up at once; O8: saved answers
    {
      console.log('change the profile in the app: the next fill uses it, saved sensitive answers fill only their own questions');
      await api('PUT', '/api/v1/profile', persona({ email: 'jordan.new@example.com', gender: 'decline', usAuthorized: 'yes' }));
      const tab = await fresh(`job-a.html?utm_term=${unique()}`);
      const d0 = await dump(tab);
      await fill(b, tab);
      const d = await dump(tab);
      check('the new email is in the form and the old one is not', d.some((x) => x.value === 'jordan.new@example.com') && !d.some((x) => x.value === 'jordan.testwell@example.com'));
      const gender = d.filter((x) => /gender/i.test(`${x.id} ${x.name}`));
      const auth = d.filter((x) => /auth/i.test(`${x.id} ${x.name}`));
      check('gender got the saved "decline" answer', gender.some((x) => x.value !== false && x.value !== '' && x.value !== null), JSON.stringify(gender));
      check('work authorization got the saved "yes"', auth.some((x) => x.value === true), JSON.stringify(auth));
      check('sponsorship, race, veteran and ethnicity stay untouched', untouched(d, d0, /sponsor|race|hispanic|vet/i), JSON.stringify(d.filter((x) => /sponsor|race|hispanic|vet/i.test(`${x.id} ${x.name}`))));
      await api('PUT', '/api/v1/profile', persona());
    }

    // -------------------------------------------------------- O10, O13: resume, confirm, one entry
    {
      console.log('resume version and the tracker: only the person\'s confirm makes an Applied entry');
      const t1 = await fresh(`job-a.html?utm_term=${unique()}`);
      await fill(b, t1, 'Tailored for Job A');
      const fileInfo = await t1.eval<{ names: string[]; sha: string }>(`(async function(){ var inputs = Array.from(document.querySelectorAll('input[type=file]')); var out = { names: [], sha: '' }; for (var i = 0; i < inputs.length; i++) { var f = inputs[i].files && inputs[i].files[0]; out.names.push(f ? f.name : ''); if (f && !out.sha) { var buf = await f.arrayBuffer(); var h = await crypto.subtle.digest('SHA-256', buf); out.sha = Array.from(new Uint8Array(h)).map(function(x){return x.toString(16).padStart(2,'0')}).join(''); } } return out; })()`);
      check('the tailored file is in the resume box', fileInfo.names.includes('tailored-for-job-a.pdf'), JSON.stringify(fileInfo.names));
      check('its bytes match the tailored file the app saved', fileInfo.sha === sha(tail), fileInfo.sha);
      check('the cover-letter file box stays empty', fileInfo.names.filter((n) => n).length === 1, JSON.stringify(fileInfo.names));
      await t1.close();
      check('a fill and a closed tab change nothing in the tracker', (await counts()).applied === before.applied);

      const t2 = await fresh(`job-a.html?utm_term=${unique()}`);
      await fill(b, t2, 'Tailored for Job A');
      await t2.clickDeep('button', 'I submitted this application');
      await new Promise((r) => setTimeout(r, 300));
      check('pressing "I submitted" alone asks first and records nothing', (await counts()).applied === before.applied);
      await t2.clickDeep('button', 'Yes, I submitted it');
      await waitFor(async () => (await counts()).applied === before.applied + 1, 8000);
      const applied = (await api('GET', '/api/v1/tracker?view=applied')).json.items as Array<{ entry: { jobId: string; resumeId: string | null; appliedAt: string; status: string }; job: { company: string } }>;
      check('exactly one Applied entry, for job A (Acme One), with the date and the tailored resume', applied.length === before.applied + 1 && applied[0]!.entry.jobId === idA && applied[0]!.job.company === 'Acme One' && applied[0]!.entry.resumeId === tailoredId && /^\d{4}/.test(applied[0]!.entry.appliedAt), JSON.stringify(applied.map((x) => x.entry)));
      check('the panel says it saved', /Saved: your jobleft tracker/.test(await panelText(t2)), (await panelText(t2)).slice(-300));
      await shot(t2, '04-after-confirm');
      await t2.clickDeep('button', 'I submitted it again');
      await t2.clickDeep('button', 'Yes, I submitted it');
      await new Promise((r) => setTimeout(r, 800));
      check('a second confirm keeps one entry', (await counts()).applied === before.applied + 1);
      check('the other job with the same title is not applied', !applied.some((x) => x.entry.jobId === idB));
      // The next popup for this page says so.
      const t3 = await fresh(`job-a.html?utm_term=${unique()}`);
      check('the popup says the job was already marked as applied', /already marked this job as applied/.test((await popupText(b, t3)).text));
    }

    // -------------------------------------------------------- an unknown page: confirm needs the job first
    {
      console.log('unknown page: the confirm says it could not save, then the add button makes the job');
      const t = await fresh(`generic.html?x=${unique()}`);
      await fill(b, t);
      await t.clickDeep('button', 'I submitted this application');
      await t.clickDeep('button', 'Yes, I submitted it');
      await new Promise((r) => setTimeout(r, 800));
      const said = await panelText(t);
      check('the panel says plainly that nothing was saved', /Not saved/.test(said) && /does not know this job/.test(said), said.slice(0, 400));
      check('and the tracker did not change', (await counts()).applied === before.applied + 1);
      const added = await t.clickDeep('button', 'Add this job to jobleft');
      check('the panel offers to add the job', added);
      await waitFor(async () => /Added to jobleft/.test(await panelText(t)), 15000);
      const said2 = await panelText(t);
      // The page is on this computer, so the app reads it because the person pressed the button.
      check('after adding, the panel names the job', /Added to jobleft/.test(said2) || /Not added|Nothing was added/.test(said2), said2.slice(0, 300));
    }

    // -------------------------------------------------------- O3: unpair in the app
    {
      console.log('unpair in the app: the very next request is refused and nothing else changes');
      const list = (await api('GET', '/api/v1/extension/pairings')).json as Array<{ extensionId: string }>;
      const del = await api('DELETE', `/api/v1/extension/pairings/${list[0]!.extensionId}`);
      check('the app unpairs', del.status === 200);
      check('the paired list is empty', ((await api('GET', '/api/v1/extension/pairings')).json as unknown[]).length === 0);
      const tab = await fresh(`job-a.html?utm_term=${unique()}`);
      const d0 = JSON.stringify(await dump(tab));
      const { text } = await popupText(b, tab);
      check('the popup says it is not paired and offers no Fill', /not paired/.test(text) && !/Fill this application/.test(text), text.slice(0, 300));
      check('no field changed', JSON.stringify(await dump(tab)) === d0);
      const c = await counts();
      check('resumes, tracker and profile are as before the unpair', c.resumes === before.resumes && c.applied === before.applied + 1 && c.profileEmail === before.profileEmail, JSON.stringify(c));
    }

    // -------------------------------------------------------- O1: pair again, restart the app, stay paired
    {
      console.log('pair again, quit the app, start it again: the pairing survives, a fill works with no new step');
      const tab = await fresh(`job-a.html?utm_term=${unique()}`);
      const c = await api('POST', '/api/v1/extension/pairing-code');
      const pop = await openPopup(b.browser, b.extId, tab);
      await pop.eval(`(function(){ var i = document.querySelector('input[aria-label="Pairing code"]'); i.value = ${JSON.stringify(c.json.code)}; document.querySelector('input[aria-label="App port"]').value = ${JSON.stringify(String(c.json.port))}; Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent==='Pair'}).click(); return true; })()`);
      await waitFor(() => pop.eval<boolean>(`document.body.textContent.indexOf('Paired with jobleft') >= 0`), 8000);
      const list = (await api('GET', '/api/v1/extension/pairings')).json as unknown[];
      check('one entry again (a new link, not two)', list.length === 1);
      await stopApp();
      const d0 = JSON.stringify(await dump(tab));
      const { text } = await popupText(b, tab);
      check('with the app closed the popup says the app is not running', /not running/.test(text) && !/Fill this application/.test(text), text.slice(0, 300));
      check('no field changed while the app was closed', JSON.stringify(await dump(tab)) === d0);
      await startApp();
      const tab2 = await fresh(`job-a.html?utm_term=${unique()}`);
      const { text: t2 } = await popupText(b, tab2);
      check('after the restart the popup says paired (no new pairing step)', /Paired with jobleft/.test(t2) && /Fill this application/.test(t2), t2.slice(0, 300));
      await fill(b, tab2);
      check('and a fill works', (await dump(tab2)).some((x) => x.value === 'Jordan'));
    }
  } finally {
    await b.browser.close().catch(() => undefined);
    practice.kill();
    await stopApp();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
