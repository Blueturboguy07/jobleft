// Gate 6 (i-ext), single-builder check written from docs/outcomes/i-ext.md, not from the code.
// The REAL extension runs in headless Chrome (scratch profile, no internet) against the REAL app (not the stand-in),
// on the extension lane's practice pages, which log every submit and "Next" press. Field values are read from the
// page itself; refusals are checked over plain HTTP from outside the browser.
// Usage: node evals/gate6-extension/run.mjs   (writes evals/gate6-extension/RESULT.md; exit 1 on a failed MUST)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('./', import.meta.url));
const HOME = '/private/tmp/jl-gate6';
const APP_PORT = 47821;
const P = 'http://127.0.0.1:47900/practice';
const TOKEN = 'gate6-' + Math.random().toString(36).slice(2);
const results = [];
const note = (id, ok, text) => { results.push({ id, ok, text }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = await import(join(ROOT, 'apps/extension/scripts/harness.ts'));

async function startServer(home) {
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/src/main.ts'), '--home', home, '--port', String(APP_PORT)], {
    env: { ...process.env, JOBLEFT_LAUNCH_TOKEN: TOKEN, JOBLEFT_AUTO_CRAWL: '0', JOBLEFT_SEED_BOARDS: 'none', JOBLEFT_DEV: '1', JOBLEFT_LOG_LEVEL: 'info', JOBLEFT_NO_OS_NOTIFY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const f = join(home, 'run/server.json');
    if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.port) return { child, port: j.port, stop: async () => { child.kill('SIGTERM'); await sleep(1200); } }; }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${out}`);
  }
  throw new Error(`server did not start: ${out}`);
}
const api = (port) => async (method, path, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-jobleft-token': TOKEN, ...(body !== undefined && !isBuf ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
const raw = (port, opts) => new Promise((resolve) => { const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {} }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); req.on('error', () => resolve({ status: 0, body: '' })); if (opts.body) req.write(opts.body); req.end(); });
const valueOf = (d, id) => d.find((f) => f.id === id)?.value;

const PROFILE = {
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 0100', addressLine: null, city: 'Round Rock', region: 'TX', postalCode: null, country: 'US', links: [] },
  summary: 'Software engineer.', education: [{ id: 'e0', school: 'Sample State University', degree: "Bachelor's", major: 'Computer Science', gpa: null, startDate: '2016-08', endDate: '2020-05', current: false, achievements: [], coursework: [] }], certifications: [], projects: [],
  work: [{ id: 'w0', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: null, location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Built a billing API.'] }],
  skills: [{ name: 'TypeScript', years: 3, source: 'user' }],
  preferences: { jobFunctions: ['software'], targetTitles: ['Software Engineer'], employmentTypes: [], workModels: [], levels: [], countries: ['US'], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};

rmSync(HOME, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true });
const CHROME_PROFILE = `--user-data-dir=${HOME}/chrome-profile`; // repeated after the harness's scratch profile: the last value wins
let srv = await startServer(HOME);
let call = api(srv.port);
const practice = await H.startPractice(47900);
const practiceTls = await H.startPractice(47943, true);
import { spawnSync } from 'node:child_process';
const spawnSyncText = (c, a) => String(spawnSync(c, a).stdout ?? '');
let browser = null, extId = null;
try {
  note('setup.app', srv.port === APP_PORT, `real app on port ${srv.port}`);
  await call('PUT', '/api/v1/profile', PROFILE);
  const pdf = readFileSync(join(ROOT, 'packages/resume/test/fixtures/jordan-one-column.pdf'));
  const imp = await call('POST', '/api/v1/resumes/import', pdf, { 'content-type': 'application/pdf', 'x-jobleft-filename': 'Jordan_Testwell_Resume.pdf' });
  const baseId = imp.json?.resume?.id;
  const addJob = async (title, company, url) => { const r = await call('POST', '/api/v1/jobs/external', { text: `${title}\nCompany: ${company}\nLocation: Austin, TX\nAbout the role: build software.\nRequirements:\n- TypeScript`, applyUrl: url }); if (r.status !== 200) throw new Error(`job ${r.status} ${r.text.slice(0, 200)}`); return r.json.job.id; };
  const jobA = await addJob('Software Engineer', 'Acme Robotics', `${P}/job-a.html`);
  const jobB = await addJob('Software Engineer', 'Woodgrove Cloud', `${P}/job-b.html`);
  // A second base resume with its own file name stands in for a tailored version (tailoring needs a model; gate 3 covers it).
  const imp2 = await call('POST', '/api/v1/resumes/import', pdf, { 'content-type': 'application/pdf', 'x-jobleft-filename': 'Jordan_Testwell_Acme.pdf' });
  const tailoredId = imp2.json?.resume?.id ?? null;
  note('setup.data', !!baseId && !!tailoredId && baseId !== tailoredId, `resumes imported: ${baseId ? 'Jordan_Testwell_Resume.pdf' : 'FAILED ' + imp.text.slice(0, 100)}, ${tailoredId ? 'Jordan_Testwell_Acme.pdf' : 'FAILED ' + imp2.text.slice(0, 100)}`);

  // O2 (negative): no pairing -> refused from curl and from a page on another port.
  const noTok = await raw(srv.port, { method: 'POST', path: '/api/v1/extension/fill', headers: { 'content-type': 'application/json' }, body: '{}' });
  const other = await raw(srv.port, { method: 'POST', path: '/api/v1/extension/check', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:47999' }, body: '{}' });
  const fakeExt = await raw(srv.port, { method: 'POST', path: '/api/v1/extension/check', headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'x-jobleft-pairing': 'A'.repeat(43) }, body: '{}' });
  note('O2.unpaired-refused', [noTok.status, other.status, fakeExt.status].every((s) => s === 401 || s === 403), `curl no pairing ${noTok.status}; page on another port ${other.status}; unpaired extension id with a made-up token ${fakeExt.status}`);

  // O1: pair once through the real popup with the app's 6-digit code; the pairing shows in the app and survives restarts.
  ({ browser, extId } = await H.launch({ headless: true, args: [CHROME_PROFILE] }));
  const s = { browser, extId, appPort: srv.port, appToken: TOKEN };
  let tab = await browser.newPage(`${P}/job-a.html?utm_term=1`);
  const before = await H.pressFill(s, tab);
  const dumpBefore = await H.dump(tab);
  note('O2.unpaired-popup', /not paired|pair/i.test(before) && dumpBefore.every((f) => !f.value || f.type === 'select-one' || f.type === 'hidden'), `unpaired popup says: "${before.replace(/\n+/g, ' / ').slice(0, 140)}"; fields still empty: ${dumpBefore.filter((f) => f.value && f.type === 'text').length === 0}`);
  const pairText = await H.pair(s, tab);
  const pairings = (await call('GET', '/api/v1/extension/pairings')).json;
  note('O1.paired', /Paired with jobleft/.test(pairText) && Array.isArray(pairings) && pairings.length === 1 && !!pairings[0].pairedAt, `popup: "${pairText.replace(/\n+/g, ' / ').slice(0, 100)}"; app lists ${pairings?.length} paired browser(s) with a date: ${pairings?.[0]?.pairedAt}`);

  // O5: the right job name for each page; unknown for a page that is no job.
  const pop = await H.openPopup(browser, extId, tab); const popA = await pop.eval('document.body.innerText'); await pop.close();
  const tabB = await browser.newPage(`${P}/job-b.html?utm_term=2`); const popB0 = await H.openPopup(browser, extId, tabB); const popB = await popB0.eval('document.body.innerText'); await popB0.close();
  const tabG = await browser.newPage(`${P}/generic.html?utm_term=3`); const popG0 = await H.openPopup(browser, extId, tabG); const popG = await popG0.eval('document.body.innerText'); await popG0.close();
  note('O5.job-named', /Acme Robotics/.test(popA) && !/Woodgrove Cloud/.test(popA) && /Woodgrove Cloud/.test(popB) && !/Acme Robotics/.test(popB) && !/Acme Robotics|Woodgrove Cloud/.test(popG) && /does not know this job/.test(popG), `job A popup names: ${/Acme Robotics/.test(popA)}; job B popup names: ${/Woodgrove Cloud/.test(popB)}; a page that is no stored job names neither and offers to add it: ${!/Acme Robotics|Woodgrove Cloud/.test(popG) && /does not know this job/.test(popG)} ("${popG.replace(/\n+/g, ' / ').slice(0, 100)}")`);
  await tabB.close(); await tabG.close();

  // O6/O7/O8/O9/O10/O11/O12: fill job A with the tailored resume.
  await fetch('http://127.0.0.1:47900/__reset', { method: 'POST' });
  tab = await browser.newPage(`${P}/job-a.html?utm_term=4`);
  await tab.eval(`(function(){ var e = document.getElementById('preferred_name'); if (e) e.value = 'JT typed this'; })()`);
  const d0 = await H.dump(tab);
  const fillText = await H.pressFill(s, tab, tailoredId);
  await H.waitFor(async () => /Done\.|Stopped|did not run|Undone/.test(await H.panelText(tab)), 30000);
  const report = await H.panelText(tab);
  const d = await H.dump(tab);
  const filled = (id) => valueOf(d, id);
  note('O7.saved-facts-only', filled('first_name') === 'Jordan' && filled('last_name') === 'Testwell' && filled('email') === 'jordan.testwell@example.com' && !filled('linkedin') && !filled('website') && !filled('github'), `first ${filled('first_name')}, last ${filled('last_name')}, email ${filled('email')}, phone ${filled('phone')}; links (none saved) left empty: ${!filled('linkedin') && !filled('website') && !filled('github')}`);
  note('O6.only-the-application-form', !filled('alert_name') && !filled('alert_email') && !filled('outside_ssn') && !filled('trap_phone') && !filled('trap_address') && !filled('trap_ssn') && !filled('trap_hidden_email'), `job-alert sign-up, outside and hidden trap fields untouched: alert ${JSON.stringify(filled('alert_email'))}, outside ssn ${JSON.stringify(filled('outside_ssn'))}, hidden email ${JSON.stringify(filled('trap_hidden_email'))}`);
  const eeoIds = d.filter((f) => /gender|veteran|disab|race|ethnic|hispanic/i.test(f.id + ' ' + f.name)).map((f) => f.id);
  const eeoSame = eeoIds.every((id) => filled(id) === valueOf(d0, id));
  note('O8.sensitive-untouched', eeoIds.length > 0 && eeoSame, `sensitive fields on the page: ${eeoIds.join(', ')}; all unchanged (nothing saved in the profile): ${eeoSame}; now: ${eeoIds.map((id) => JSON.stringify(filled(id))).join(', ')}`);
  const drafts = (report.match(/Insert into the form/g) ?? []).length;
  const openQ = d.filter((f) => f.type === 'textarea').map((f) => [f.id, f.value]);
  note('O9.drafts-not-inserted', drafts >= 1 && openQ.every(([, v]) => !v), `${drafts} draft(s) offered; open-question fields still empty: ${openQ.every(([, v]) => !v)} (${openQ.map(([id]) => id).join(', ')})`);
  note('O14.typed-value-kept', filled('preferred_name') === 'JT typed this', `the value the person typed before the fill: ${JSON.stringify(filled('preferred_name'))}`);
  const resumeField = d.find((f) => f.id === 'resume');
  note('O10.right-resume', /Resume attached/.test(report) && String(resumeField?.value ?? '').startsWith('Jordan_Testwell_Acme.pdf'), `the chosen (second) resume goes in, not the first: report "${(report.match(/Resume attached[^\n]*/) ?? ['(no line)'])[0].slice(0, 80)}"; file field holds: ${JSON.stringify(resumeField?.value)}`);
  const log1 = await H.practiceLog();
  note('O12.never-submits', log1.counts.submit === 0 && log1.counts.next === 0, `submits ${log1.counts.submit}, next presses ${log1.counts.next} after a fill`);
  const requiredEmpty = d.filter((f) => /required/.test(String(f.type)) || false).length;
  note('O11.honest-report', /Done\./.test(report) && /Kept as they were|left|needs you|did not fill/i.test(report), `report says Done and lists what it left: ${/Kept as they were|left|needs you|did not fill/i.test(report)}; excerpt: "${report.replace(/\n+/g, ' / ').slice(0, 220)}"`);

  // O13: the tracker changes only when the person confirms they submitted.
  const trBefore = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jobA)}`)).json.tracker;
  await tab.close();
  const trAfterClose = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jobA)}`)).json.tracker;
  note('O13.no-confirm-no-change', trAfterClose.status === trBefore.status && trAfterClose.status !== 'applied', `tracker after a fill and a closed tab: "${trAfterClose.status}"`);
  tab = await browser.newPage(`${P}/job-a.html?utm_term=5`);
  await H.pressFill(s, tab, tailoredId);
  await H.waitFor(async () => /Done\.|Stopped|did not run/.test(await H.panelText(tab)), 30000);
  const c1 = await tab.clickDeep('button', 'I submitted this application'); await sleep(300);
  const trMid = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jobA)}`)).json.tracker;
  const c2 = await tab.clickDeep('button', 'Yes, I submitted it');
  let saved = false; try { await H.waitFor(async () => /Saved: your jobleft tracker/.test(await H.panelText(tab)), 8000); saved = true; } catch { /* not saved */ }
  const trAfterConfirm = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jobA)}`)).json.tracker;
  note('O13.confirm-marks-applied', c1 && c2 && (!trMid || trMid.status !== 'applied') && saved && trAfterConfirm?.status === 'applied' && trAfterConfirm?.resumeId === tailoredId, `two-step confirm: after step 1 "${trMid?.status ?? null}", after "Yes, I submitted it" "${trAfterConfirm?.status}" with resume ${trAfterConfirm?.resumeId === tailoredId ? 'the one used in the fill' : JSON.stringify(trAfterConfirm?.resumeId)}; panel: ${saved}`);

  // O12: a CAPTCHA page: the panel says a person must complete it; nothing is submitted.
  const tabC = await browser.newPage(`${P}/captcha.html?utm_term=6`);
  await H.pressFill(s, tabC);
  await H.waitFor(async () => (await H.panelText(tabC)).length > 0, 15000);
  const capReport = await H.panelText(tabC);
  note('O12.captcha', /captcha|human|person must|you must complete|robot/i.test(capReport), `captcha page report: "${capReport.replace(/\n+/g, ' / ').slice(0, 160)}"`);
  await tabC.close();


  // O4: what the extension reads: the manifest's permissions and hosts.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'apps/extension/dist/manifest.json'), 'utf8'));
  const hosts = [...(manifest.host_permissions ?? []), ...(manifest.content_scripts ?? []).flatMap((c) => c.matches ?? [])];
  note('O4.permissions', !hosts.some((h) => /linkedin|indeed|glassdoor/i.test(h)) && !(manifest.permissions ?? []).some((p) => /tabs$|history|bookmarks|cookies|webRequestBlocking/.test(p)), `permissions: ${(manifest.permissions ?? []).join(', ')}; hosts: ${hosts.join(', ').slice(0, 200)}`);

  // O1: still paired after both restart; O3: unpair stops the token at once.
  await srv.stop(); srv = await startServer(HOME); call = api(srv.port);
  const BLOCKED = ['www.linkedin.com', 'www.indeed.com', 'www.glassdoor.com'];
  await browser.close(); ({ browser, extId } = await H.launch({ headless: true, args: [`--host-resolver-rules=${BLOCKED.map((h) => `MAP ${h} 127.0.0.1:47943`).join(', ')}`, '--ignore-certificate-errors', `--proxy-bypass-list=${BLOCKED.join(';')}`, CHROME_PROFILE] }));
  const s2 = { browser, extId, appPort: srv.port, appToken: TOKEN };
  tab = await browser.newPage(`${P}/job-b.html?utm_term=8`);
  const popR0 = await H.openPopup(browser, extId, tab); const popR = await popR0.eval('document.body.innerText'); await popR0.close();
  note('O1.survives-restart', /Fill this application|Woodgrove/.test(popR) && !/not paired/i.test(popR), `after restarting the app and the browser, the popup shows: "${popR.replace(/\n+/g, ' / ').slice(0, 120)}"`);
  // O15: the three blocked boards (host names mapped to a local https practice page): popup refuses, page untouched, app told nothing.
  const logLen = () => (existsSync(join(HOME, 'logs')) ? spawnSyncText('cat', [join(HOME, 'logs', 'server.log')]) : '').split('\n').filter((l) => /extension\/(page|fill|check)/.test(l)).length;
  const before15 = logLen();
  const o15 = [];
  for (const h of BLOCKED) {
    const t = await browser.newPage(`https://${h}/practice/job-a.html?utm_term=${h}`);
    const b = await H.dump(t); const pp = await H.openPopup(browser, extId, t); const txt = await pp.eval('document.body.innerText'); await pp.close();
    o15.push({ h, refused: /does not work on this site/.test(txt) && !/Fill this application/.test(txt), same: JSON.stringify(await H.dump(t)) === JSON.stringify(b), txt: txt.replace(/\n+/g, ' / ').slice(0, 90) });
    await t.close();
  }
  note('O15.blocked-boards', o15.every((x) => x.refused && x.same) && logLen() === before15, o15.map((x) => `${x.h}: refused ${x.refused}, page unchanged ${x.same}`).join('; ') + `; app log lines about those pages: ${logLen() - before15}; popup: "${o15[0].txt}"`);
  const ps = (await call('GET', '/api/v1/extension/pairings')).json;
  const un = await call('DELETE', `/api/v1/extension/pairings/${ps[0].extensionId}`);
  const psAfter = (await call('GET', '/api/v1/extension/pairings')).json;
  const popU0 = await H.openPopup(browser, extId, tab); await H.waitFor(() => popU0.eval(`document.body.innerText.indexOf('not paired') >= 0 || document.body.innerText.indexOf('Pair') >= 0`), 8000); const popU = await popU0.eval('document.body.innerText'); await popU0.close();
  const dU = await H.dump(tab);
  note('O3.unpair', un.status === 200 && psAfter.length === 0 && /not paired|pair/i.test(popU) && dU.filter((f) => f.type === 'text' && f.value).length === 0, `unpair -> ${un.status}; paired list ${psAfter.length}; popup: "${popU.replace(/\n+/g, ' / ').slice(0, 100)}"`);
  void s2;
} finally { try { await browser?.close(); } catch { /* closed */ } await srv.stop(); practice.kill('SIGTERM'); practiceTls.kill('SIGTERM'); }

const fails = results.filter((r) => !r.ok);
const md = [`# Gate 6 (i-ext) result, ${new Date().toISOString()}`, '', 'The real extension (apps/extension/dist) in headless Chrome with a scratch profile and no internet, against the real app on 127.0.0.1:47821, on the lane\'s practice pages (which log every submit and Next press).', '', '| Check | Result | Evidence |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.text.replace(/\|/g, '/').replace(/\n\s*/g, '<br>')} |`), '', `Verdict: ${fails.length ? `FAIL (${fails.map((m) => m.id).join(', ')})` : 'PASS'}`].join('\n');
writeFileSync(join(OUT, 'RESULT.md'), md);
console.log(`\nVerdict: ${fails.length ? 'FAIL' : 'PASS'} (${results.length - fails.length}/${results.length})`);
process.exit(fails.length ? 1 : 0);
