// Gate 4 (i-network), single-builder check written from docs/outcomes/i-network.md, not from the code.
// The fixtures are made-up people. The only outbound traffic allowed is to loopback mocks; the mock keeps every
// request body so what leaves the app for a draft can be read back.
// Usage: node evals/gate4-network/run.mjs   (writes evals/gate4-network/RESULT.md; exit 1 on a failed MUST)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('./', import.meta.url));
const HOME = '/private/tmp/jl-gate4';
const TOKEN = 'gate4-' + Math.random().toString(36).slice(2);
const results = [];
const note = (id, ok, text) => { results.push({ id, ok, text }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixture A: 50 made-up people, plus LinkedIn's 3 note lines, a BOM, 1 malformed row and 1 blank row. Traps: 3 at
// "Stripe, Inc." and 1 at "Stripe Tax Advisors LLP" (a different firm); 6 at Woodgrove Cloud with different roles
// and ages; a Japanese and a Hebrew name; blank email, blank company, blank position.
const csvRow = (f, l, url, email, company, position, on) => [f, l, url, email, company.includes(',') ? `"${company}"` : company, position, on].join(',');
const people = [];
const add = (f, l, company, position, on, email = '', url = null) => people.push({ f, l, company, position, on, email, url: url ?? (f ? `https://www.linkedin.com/in/${f.toLowerCase()}-${l.toLowerCase()}-x${people.length}` : '') });
add('Ana', 'Recruiterson', 'Woodgrove Cloud', 'Technical Recruiter', '04 Mar 2025', 'ana.recruiterson@example.com');
add('Ben', 'Enginerd', 'Woodgrove Cloud', 'Platform Engineer', '12 Jan 2024');
add('Cara', 'Managerly', 'Woodgrove Cloud', 'Senior Engineering Manager', '20 Aug 2023');
add('Dev', 'Internly', 'Woodgrove Cloud', 'Software Engineering Intern', '01 Jun 2026');
add('Eli', 'Longago', 'Woodgrove Cloud', 'Staff Engineer', '15 Feb 2018');
add('Fay', 'Blankpos', 'Woodgrove Cloud', '', '03 Mar 2026');
add('Gus', 'Stripey', 'Stripe, Inc.', 'Software Engineer', '05 May 2024');
add('Hana', 'Stripes', 'Stripe, Inc.', 'Recruiter', '06 Jun 2024', 'hana.stripes@example.com');
add('Ivo', 'Striper', 'Stripe, Inc.', 'Product Manager', '07 Jul 2024');
add('Jun', 'Taxman', 'Stripe Tax Advisors LLP', 'Partner', '08 Aug 2024');
add('Kai', 'Fabrikamer', 'Fabrikam Payments', 'Engineering Manager', '09 Sep 2024', 'kai@example.com');
add('太郎', '山田', 'Contoso Example Corp', 'Engineer', '10 Oct 2024');
add('דוד', 'לוי', 'Contoso Example Corp', 'Designer', '11 Nov 2024');
add('Lea', 'Nocompany', '', 'Consultant', '12 Dec 2024');
for (let i = people.length; i < 50; i++) add(`Person${i}`, `Sample${i}`, `Employer ${i % 7}`, ['Analyst', 'Engineer', 'Nurse', 'Teacher', 'Manager'][i % 5], `0${(i % 9) + 1} Jan 202${i % 5}`);
const HEADER = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';
const NOTES = '﻿Notes:\r\n"When exporting your connection data, you may notice that some of the email addresses are missing, because of privacy settings."\r\n\r\n';
const rows = people.map((p) => csvRow(p.f, p.l, p.url, p.email, p.company, p.position, p.on));
const FIXTURE_A = NOTES + HEADER + '\r\n' + rows.join('\r\n') + '\r\n,,,,,,\r\nMalformed row with no commas\r\n';
// Fixture B: 45 of A (2 with a new company), 10 new people, 5 of A left out.
const bPeople = people.slice(5).map((p, i) => (i < 2 ? { ...p, company: 'Moved Co ' + i } : p));
for (let i = 0; i < 10; i++) bPeople.push({ f: `New${i}`, l: `Person${i}`, company: 'Northwind Sample Labs', position: 'Engineer', on: '01 Feb 2026', email: '', url: `https://www.linkedin.com/in/new-${i}` });
const FIXTURE_B = NOTES + HEADER + '\r\n' + bPeople.map((p) => csvRow(p.f, p.l, p.url, p.email, p.company, p.position, p.on)).join('\r\n') + '\r\n';

async function startServer(home, env = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/src/main.ts'), '--home', home], {
    env: { ...process.env, JOBLEFT_LAUNCH_TOKEN: TOKEN, JOBLEFT_AUTO_CRAWL: '0', JOBLEFT_SEED_BOARDS: 'none', JOBLEFT_DEV: '1', JOBLEFT_LOG_LEVEL: 'info', JOBLEFT_NO_OS_NOTIFY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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
function api(port) {
  return async (method, path, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-jobleft-token': TOKEN, ...(body !== undefined && !isBuf ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
}
const allContacts = async (call, extra = '') => { const out = []; for (let off = 0; off < 2000; off += 100) { const r = await call('GET', `/api/v1/network/contacts?limit=100&offset=${off}${extra}`); if (r.status !== 200) throw new Error(`contacts ${r.status} ${r.text.slice(0, 160)}`); out.push(...r.json); if (r.json.length < 100) break; } return out; };
const walk = (d) => { const out = []; for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p); } return out; };

const { startAi } = await import(join(ROOT, 'apps/server/scripts/mocks.ts'));
const ai = await startAi({ reply: 'Hi Ana, I saw the Platform Engineer opening at Woodgrove Cloud and would love 15 minutes to hear how your team works. Jordan' });
rmSync(HOME, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true });
let srv = await startServer(HOME);
let call = api(srv.port);
const PROFILE = {
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 0100', addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US', links: [] },
  summary: 'Software engineer with 3 years of backend experience.', education: [], work: [], projects: [], certifications: [],
  skills: [{ name: 'TypeScript', years: 3, source: 'user' }, { name: 'PostgreSQL', years: 3, source: 'user' }],
  preferences: { jobFunctions: ['software'], targetTitles: ['Software Engineer'], employmentTypes: [], workModels: [], levels: [], countries: ['US'], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};
try {
  await call('PUT', '/api/v1/profile', PROFILE);
  // Target companies: jobs the person liked or added. Four companies, two with people in the file (one under a suffix).
  const addJob = async (title, company, extra = '') => { const r = await call('POST', '/api/v1/jobs/external', { text: `${title}\nCompany: ${company}\nLocation: Austin, TX\nWe build things. ${extra}`, applyUrl: `https://example.org/${company.replace(/\W+/g, '-').toLowerCase()}/${title.replace(/\W+/g, '-').toLowerCase()}` }); if (r.status !== 200) throw new Error(`job ${r.status} ${r.text.slice(0, 200)}`); return r.json.job.id; };
  const jWood = await addJob('Platform Engineer', 'Woodgrove Cloud'); const jStripe = await addJob('Software Engineer', 'Stripe'); const jAcme = await addJob('Data Engineer', 'Acme Robotics'); const jTail = await addJob('Analyst', 'Tailspin Toys');
  for (const id of [jWood, jStripe, jAcme, jTail]) await call('PATCH', `/api/v1/tracker/${encodeURIComponent(id)}`, { liked: true });

  // O3 (negative), empty state first.
  const emptyContacts = await allContacts(call); const emptyDetail = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jWood)}`)).json;
  note('O3.empty-before-import', Array.isArray(emptyContacts) && emptyContacts.length === 0 && (emptyDetail.networkCount ?? 0) === 0, `before any import: ${emptyContacts.length} contacts, job network count ${emptyDetail.networkCount}`);

  // O1: import with an honest report.
  const imp = await call('POST', '/api/v1/network/import', Buffer.from(FIXTURE_A), { 'content-type': 'text/csv' });
  const s = imp.json ?? {};
  note('O1.import-report', imp.status === 200 && s.imported === 50 && (s.skipped ?? []).length === 1 && /broken|malformed|fields|no name/i.test(JSON.stringify(s.skipped)) && !s.notAConnectionsFile, `import -> ${imp.status}: imported ${s.imported}, skipped ${JSON.stringify(s.skipped)}, warnings ${JSON.stringify(s.warnings).slice(0, 160)}, inFile ${s.inFile}`);
  const contacts = await allContacts(call);
  const names = new Set(contacts.map((c) => `${c.firstName} ${c.lastName}`));
  note('O13.messy-file', names.has('太郎 山田') && names.has('דוד לוי') && contacts.some((c) => c.firstName === 'Lea' && c.company === null) && contacts.some((c) => c.firstName === 'Fay' && c.position === null), `BOM, Japanese and Hebrew names kept as written: ${names.has('太郎 山田')} ${names.has('דוד לוי')}; blank company -> null: ${contacts.some((c) => c.firstName === 'Lea' && c.company === null)}; blank position -> null: ${contacts.some((c) => c.firstName === 'Fay' && c.position === null)}`);

  // O2: the job card count and the names, with the near name not counted.
  const dStripe = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jStripe)}`)).json;
  const stripeKey = dStripe.job.companyKey;
  const atStripe = (await call('GET', `/api/v1/network/contacts?companyKey=${encodeURIComponent(stripeKey)}`)).json;
  const expl = (await call('GET', `/api/v1/network/match?companyKey=${encodeURIComponent(stripeKey)}&companyName=Stripe`)).json;
  note('O2.count-and-names', dStripe.networkCount === 3 && atStripe.length === 3 && atStripe.every((c) => c.company === 'Stripe, Inc.') && !atStripe.some((c) => c.lastName === 'Taxman'), `job at Stripe: count ${dStripe.networkCount}; names ${atStripe.map((c) => c.lastName).join(', ')}; "Stripe Tax Advisors LLP" counted: ${atStripe.some((c) => c.lastName === 'Taxman')}; explanation: ${JSON.stringify(expl).slice(0, 200)}`);
  // O3: nothing beyond the file. Every name the app returns for the target jobs is in the fixture.
  const allNames = new Set(people.map((p) => `${p.f} ${p.l}`));
  const returned = [];
  for (const id of [jWood, jStripe, jAcme, jTail]) { const d = (await call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json; if (d.job.companyKey) returned.push(...(await call('GET', `/api/v1/network/contacts?companyKey=${encodeURIComponent(d.job.companyKey)}`)).json); }
  const foreign = returned.filter((c) => !allNames.has(`${c.firstName} ${c.lastName}`));
  note('O3.only-the-file', foreign.length === 0, `${returned.length} people shown across 4 target jobs; not in the file: ${foreign.length}`);

  // O4: who to contact first at Woodgrove, with reasons; the same after a restart.
  const dWood = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jWood)}`)).json; const woodKey = dWood.job.companyKey;
  const rank1 = (await call('GET', `/api/v1/network/rank?companyKey=${encodeURIComponent(woodKey)}&jobId=${encodeURIComponent(jWood)}`)).json;
  const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));
  const order = rank1.map((r) => byId[r.contactId]?.lastName);
  const top2 = order.slice(0, 2);
  const reasonsOk = rank1.every((r) => Array.isArray(r.reasons) && r.reasons.length > 0 && r.reasons.every((x) => typeof x.text === 'string' && x.text.length > 10));
  const top3 = order.slice(0, 3);
  // A stranger's expectation: the recruiter, the person doing the same job and the manager in the field come first; the intern and the 8-year-old contact come after them.
  note('O4.rank', rank1.length === 6 && ['Recruiterson', 'Enginerd', 'Managerly'].every((n) => top3.includes(n)) && order.indexOf('Longago') > 2 && order.indexOf('Internly') > 2 && reasonsOk, `order at Woodgrove: ${order.join(' > ')}; every entry has plain-word reasons: ${reasonsOk}; first reasons: ${(rank1[0]?.reasons ?? []).map((x) => x.text).join(' / ').slice(0, 200)}`);

  // O5: the coffee-chat plan is the person's: top 2 in, restart, remove one.
  const planned = await call('POST', '/api/v1/network/plan', { companyKey: woodKey, count: 2, jobId: jWood });
  await srv.stop(); srv = await startServer(HOME); call = api(srv.port);
  const rank2 = (await call('GET', `/api/v1/network/rank?companyKey=${encodeURIComponent(woodKey)}&jobId=${encodeURIComponent(jWood)}`)).json;
  note('O4.stable-after-restart', JSON.stringify(rank2.map((r) => r.contactId)) === JSON.stringify(rank1.map((r) => r.contactId)), `ranking identical after a restart`);
  let plan = (await call('GET', '/api/v1/network/plan')).json;
  const woodPlan = plan.find((p) => p.companyKey === woodKey);
  note('O5.plan', planned.status === 200 && woodPlan && woodPlan.contacts.length === 2 && woodPlan.contacts.every((c) => c.nextStep), `plan after restart: ${plan.map((p) => `${p.companyName}: ${p.contacts.map((c) => `${c.lastName} (${c.nextStep})`).join(', ')}`).join(' | ').slice(0, 300)}`);
  const dropId = woodPlan.contacts[1].contactId;
  await call('PATCH', `/api/v1/network/contacts/${dropId}`, { inPlan: false });
  plan = (await call('GET', '/api/v1/network/plan')).json;
  const stillThere = (await call('GET', `/api/v1/network/contacts?companyKey=${encodeURIComponent(woodKey)}`)).json.some((c) => c.id === dropId);
  note('O5.remove-from-plan', (plan.find((p) => p.companyKey === woodKey)?.contacts.length ?? 0) === 1 && stillThere, `removed one: plan has ${plan.find((p) => p.companyKey === woodKey)?.contacts.length} at Woodgrove; the person is still in the network: ${stillThere}`);

  // O6/O14: a draft without AI (template) names the person and the job; with the mock AI only this contact and job leave.
  const ana = contacts.find((c) => c.lastName === 'Recruiterson');
  const tpl = await call('POST', `/api/v1/network/contacts/${ana.id}/draft`, { variant: 'short', jobId: jWood, template: true });
  const t = tpl.json?.text ?? '';
  note('O14.template-draft', tpl.status === 200 && /\bAna\b/.test(t) && /Woodgrove/.test(t) && /Platform Engineer/.test(t) && /Jordan/.test(t) && !/\bcredits?\b/i.test(t), `template draft -> ${tpl.status}: "${t.replace(/\n+/g, ' / ').slice(0, 220)}"`);
  const noAi = await call('POST', `/api/v1/network/contacts/${ana.id}/draft`, { variant: 'short', jobId: jWood });
  note('O14.no-provider-plain', noAi.status !== 200 && /provider|AI|set up/i.test(noAi.json?.error?.message ?? ''), `AI draft with no provider -> ${noAi.status}: ${noAi.json?.error?.message?.slice(0, 160)}`);
  await call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: `${ai.origin}/v1`, model: 'mock-model' });
  const prev = (await call('POST', `/api/v1/network/contacts/${ana.id}/draft/preview`, { variant: 'short', jobId: jWood })).json;
  const before = ai.log.length;
  const dr = await call('POST', `/api/v1/network/contacts/${ana.id}/draft`, { variant: 'short', jobId: jWood, confirmRemote: true });
  const sentBodies = ai.log.slice(before).map((e) => e.body).join('\n');
  const otherNames = people.filter((p) => p.l !== 'Recruiterson').map((p) => p.l).filter((l) => sentBodies.includes(l));
  note('O6.ai-draft', dr.status === 200 && /Ana/.test(dr.json?.text ?? '') && /Woodgrove/.test(dr.json?.text ?? ''), `AI draft -> ${dr.status}; provider ${dr.json?.provider}; text: "${(dr.json?.text ?? '').slice(0, 120)}"; preview said it sends: contact ${prev?.sends?.contact?.firstName}, job ${prev?.sends?.job?.title}, aboutMe ${String(prev?.sends?.aboutMe ?? '').length} chars`);
  note('O10.only-this-contact-leaves', ai.log.length > before && otherNames.length === 0 && sentBodies.includes('Recruiterson') && !sentBodies.includes('ana.recruiterson@example.com') === (prev?.sends?.contact?.email === undefined), `${ai.log.length - before} model call(s); other people's names in what was sent: ${otherNames.length}; the contact's own name present: ${sentBodies.includes('Recruiterson')}`);

  // O7: stages and a reminder that arrives.
  const gus = contacts.find((c) => c.lastName === 'Stripey'); const hana = contacts.find((c) => c.lastName === 'Stripes'); const ivo = contacts.find((c) => c.lastName === 'Striper');
  await call('PATCH', `/api/v1/network/contacts/${gus.id}`, { stage: 'messaged', note: 'sent on Monday' });
  await call('PATCH', `/api/v1/network/contacts/${hana.id}`, { stage: 'replied' });
  const today = new Date(); const due = new Date(today.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const setFu = await call('PATCH', `/api/v1/network/contacts/${ivo.id}`, { stage: 'met', followUpOn: due });
  await srv.stop(); srv = await startServer(HOME); call = api(srv.port);
  const after = await allContacts(call); const byId2 = Object.fromEntries(after.map((c) => [c.id, c]));
  note('O7.stages-survive', setFu.status === 200 && byId2[gus.id].stage === 'messaged' && byId2[gus.id].note === 'sent on Monday' && byId2[hana.id].stage === 'replied' && byId2[ivo.id].stage === 'met' && byId2[ivo.id].followUpOn === due, `after restart: ${[gus, hana, ivo].map((c) => `${c.lastName}=${byId2[c.id].stage}`).join(', ')}; follow-up ${byId2[ivo.id].followUpOn}`);
  await call('POST', '/api/v1/dev/clock', { offset: '30h' });
  let notif = []; for (let i = 0; i < 40; i++) { notif = (await call('GET', '/api/v1/notifications')).json ?? []; if (notif.some((n) => /Striper|follow/i.test(JSON.stringify(n)))) break; await sleep(500); }
  const fu = notif.find((n) => /Striper|follow/i.test(JSON.stringify(n)));
  note('O7.reminder-arrives', !!fu, `after moving the clock 30 h: ${notif.length} notification(s); follow-up notice: ${JSON.stringify(fu ?? null).slice(0, 200)}`);

  // O8: a new import keeps the person's work.
  const imp2 = await call('POST', '/api/v1/network/import', Buffer.from(FIXTURE_B), { 'content-type': 'text/csv' });
  const s2 = imp2.json ?? {};
  const after2 = await allContacts(call); const byId3 = Object.fromEntries(after2.map((c) => [c.id, c]));
  note('O8.reimport', imp2.status === 200 && s2.imported === 10 && s2.updated === 2 && s2.missingFromFile === 5 && byId3[gus.id]?.stage === 'messaged' && byId3[gus.id]?.note === 'sent on Monday', `second import: added ${s2.imported}, updated ${s2.updated}, missing ${s2.missingFromFile}; Stripey still messaged with the note: ${byId3[gus.id]?.stage === 'messaged' && byId3[gus.id]?.note === 'sent on Monday'}; the 5 missing people still listed: ${people.slice(0, 5).every((p) => after2.some((c) => c.lastName === p.l))}`);

  // O9: the map of target companies with nobody.
  const cov = (await call('GET', '/api/v1/network/coverage')).json;
  const nobody = cov.filter((c) => c.count === 0).map((c) => c.companyName);
  note('O9.map', cov.length >= 4 && nobody.includes('Acme Robotics') && nobody.includes('Tailspin Toys') && !nobody.includes('Stripe') && (cov.find((c) => /stripe/i.test(c.companyName))?.count ?? 0) >= 2 /* one Stripe person moved company in fixture B */, `coverage: ${cov.map((c) => `${c.companyName}=${c.count}`).join(', ')}`);

  // O11: never LinkedIn; every request in the app's log stays on loopback.
  const reqLog = existsSync(join(HOME, 'logs/requests.ndjson')) ? readFileSync(join(HOME, 'logs/requests.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const offBox = reqLog.filter((e) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(e.host));
  note('O11.no-linkedin', offBox.length === 0 && !reqLog.some((e) => /linkedin/i.test(e.host)), `${reqLog.length} logged outbound requests, off this computer: ${offBox.length} (${offBox.map((e) => e.host).slice(0, 5).join(', ')})`);

  // O12: delete everything; the names are gone from the app and from the data folder.
  const del = await call('DELETE', '/api/v1/network');
  const gone = await allContacts(call);
  await srv.stop(); srv = await startServer(HOME); call = api(srv.port);
  const gone2 = await allContacts(call);
  const notif2 = (await call('GET', '/api/v1/notifications')).json ?? [];
  let hits = 0; for (const f of walk(HOME)) { if (/\.(db|db-wal|json|ndjson|log|txt|csv)$/.test(f)) { const t = readFileSync(f, 'latin1'); for (const n of ['Recruiterson', 'Stripey', 'Fabrikamer', 'Taxman', 'Longago']) if (t.includes(n)) hits++; } }
  const d2 = (await call('GET', `/api/v1/jobs/${encodeURIComponent(jWood)}`)).json;
  note('O12.delete-all', del.status === 200 && gone.length === 0 && gone2.length === 0 && hits === 0 && (d2.networkCount ?? 0) === 0 && !notif2.some((n) => /Striper/.test(JSON.stringify(n))), `delete -> ${del.status} ${JSON.stringify(del.json).slice(0, 80)}; contacts after restart ${gone2.length}; fixture names found in data files: ${hits}; job network count ${d2.networkCount}`);
} finally { await srv.stop(); await ai.close(); }

const fails = results.filter((r) => !r.ok);
const md = [`# Gate 4 (i-network) result, ${new Date().toISOString()}`, '', 'Fixture A: 50 made-up people with LinkedIn note lines, a BOM, one malformed and one blank row, near-name and messy-field traps. Fixture B: 45 of A (2 moved), 10 new, 5 left out. A loopback mock model keeps every request body.', '', '| Check | Result | Evidence |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.text.replace(/\|/g, '/').replace(/\n\s*/g, '<br>')} |`), '', `Verdict: ${fails.length ? `FAIL (${fails.map((m) => m.id).join(', ')})` : 'PASS'}`].join('\n');
writeFileSync(join(OUT, 'RESULT.md'), md);
console.log(`\nVerdict: ${fails.length ? 'FAIL' : 'PASS'} (${results.length - fails.length}/${results.length})`);
process.exit(fails.length ? 1 : 0);
