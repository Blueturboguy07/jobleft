// Gate 9 (System), single-builder check written from docs/outcomes/sys-e2e.md, sys-security.md and sys-perf.md.
//  A. Three personas (software engineer, registered nurse, accountant who needs sponsorship) run the 8-task journey
//     through the documented API on a COPY of the gate 2 store (11,957 real jobs from 41 employer boards), with
//     loopback stand-ins for the AI model, the assistant model and one "employer" job page. Every step must end with
//     a visible result (a job list, a fit breakdown, a saved file, a tracker row, a contact list, an answer).
//  B. Security: a page on ANOTHER origin in headless Chrome tries to use the app; the same requests are sent from
//     here with browser headers; every one must fail with no data.
//  C. Egress: every outbound request in this run and in the gate 2 crawl goes to loopback or an approved host, and
//     no request to an employer or a job board carries the persona's data.
//  D. Perf: a 100,000-job store (the store's own synthetic seed); search, filter and detail through the API.
// Usage: node evals/gate9-system/run.mjs   (writes evals/gate9-system/RESULT.md; exit 1 on a failed MUST)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('./', import.meta.url));
const HOME = '/private/tmp/jl-gate9';
const HOME_BIG = '/private/tmp/jl-gate9-100k';
const STORE_SRC = '/private/tmp/jl-gate2';
const TOKEN = 'gate9-' + Math.random().toString(36).slice(2);
const results = [];
const note = (id, ok, text) => { results.push({ id, ok, text }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const { startAi } = await import(join(ROOT, 'apps/server/scripts/mocks.ts'));
const { startScriptedModel, defaultScript } = await import(join(ROOT, 'packages/assistant/src/mock/scripted-model.ts'));

async function startServer(home, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/src/main.ts'), '--home', home], {
    env: { ...process.env, JOBLEFT_LAUNCH_TOKEN: TOKEN, JOBLEFT_AUTO_CRAWL: '0', JOBLEFT_SEED_BOARDS: 'none', JOBLEFT_DEV: '1', JOBLEFT_NO_OS_NOTIFY: '1', JOBLEFT_LOG_LEVEL: 'info', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 300; i++) {
    await sleep(150);
    const f = join(home, 'run/server.json');
    if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.port) return { child, port: j.port, stop: async () => { child.kill('SIGTERM'); await sleep(1500); } }; }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${out}`);
  }
  throw new Error(`server did not start: ${out}`);
}
const api = (port) => async (method, path, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-jobleft-token': TOKEN, ...(body !== undefined && !isBuf ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer()); const text = buf.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, buf, ms: performance.now() - t0, type: r.headers.get('content-type') ?? '' };
};
const raw = (port, opts) => new Promise((resolve) => { const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {} }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers })); }); req.on('error', () => resolve({ status: 0, body: '', headers: {} })); if (opts.body) req.write(opts.body); req.end(); });
const parseSse = (text) => text.split(/\n\n+/).map((b) => b.split('\n').find((l) => l.startsWith('data:'))).filter(Boolean).map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
const pdfText = (buf, name) => { const p = join(HOME, 'tmp', name); mkdirSync(join(HOME, 'tmp'), { recursive: true }); writeFileSync(p, buf); return sh('pdftotext', ['-layout', p, '-']).stdout; };
const docxText = (buf, name) => { const p = join(HOME, 'tmp', name); mkdirSync(join(HOME, 'tmp'), { recursive: true }); writeFileSync(p, buf); return sh('unzip', ['-p', p, 'word/document.xml']).stdout.replace(/<[^>]+>/g, ' '); };

// ---------------------------------------------------------------- personas (fake data only)
const base = (p) => ({
  personal: { firstName: p.first, middleName: null, lastName: p.last, email: p.email, phone: '+1 555 0100', addressLine: null, city: p.city, region: p.region, postalCode: null, country: 'US', links: [] },
  summary: p.summary, education: p.education, certifications: p.certs ?? [], projects: [],
  work: p.work, skills: p.skills.map((name) => ({ name, years: 3, source: 'user' })),
  preferences: { jobFunctions: p.functions, targetTitles: p.titles, employmentTypes: [], workModels: p.remote ? ['remote', 'hybrid', 'onsite'] : [], levels: [], countries: ['US'], places: p.places ?? [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: p.sponsor ? 'no' : 'yes', needsSponsorship: p.sponsor ? 'yes' : 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
});
const PERSONAS = {
  A: { key: 'A', label: 'Jordan Testwell, new-grad software engineer', first: 'Jordan', last: 'Testwell', email: 'jordan.testwell@example.com', city: 'Austin', region: 'TX', remote: true,
    summary: 'Software engineer with 3 years of experience in web services and data pipelines.', titles: ['Software Engineer'], functions: ['software'], skills: ['Python', 'TypeScript', 'React', 'SQL'],
    education: [{ id: 'e1', school: 'Sample State University', degree: "Bachelor's", major: 'Computer Science', gpa: null, startDate: '2016-08', endDate: '2020-05', current: false, achievements: [], coursework: [] }],
    work: [{ id: 'w1', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: null, location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Built a billing API in TypeScript used by 40 customers.', 'Cut a nightly data pipeline from 3 hours to 40 minutes with SQL and Python.'] }],
    resumePdf: join(ROOT, 'packages/resume/test/fixtures/jordan-one-column.pdf'), wantTitle: /software|developer|engineer/i, wantNot: /nurse|accountant/i,
    tailorReply: 'B1: Cut batch-job time by 40% by rewriting the scheduler in TypeScript.\nB2: Led a migration of 12 services to PostgreSQL with zero downtime.\nSUMMARY: Software engineer with 3 years of backend experience building APIs and data pipelines.',
    contacts: [['Priya', 'Sampleton', 'Recruiter'], ['Omar', 'Testerson', 'Software Engineer']] },
  B: { key: 'B', label: 'Riley Careford, registered nurse open to Texas and California', first: 'Riley', last: 'Careford', email: 'riley.careford@example.com', city: 'Dallas', region: 'TX', remote: false, places: [{ text: 'Dallas, TX', placeId: null, radiusMiles: null }, { text: 'Sacramento, CA', placeId: null, radiusMiles: null }],
    summary: 'Registered nurse with 5 years in ICU and telemetry: patient assessment, medication administration, charting.', titles: ['Registered Nurse', 'RN'], functions: ['healthcare'], skills: ['Patient assessment', 'Medication administration', 'BLS', 'ACLS', 'Epic charting'], certs: [],
    education: [{ id: 'e1', school: 'Sample State University', degree: 'BSN', major: 'Nursing', gpa: null, startDate: '2014-08', endDate: '2018-05', current: false, achievements: [], coursework: [] }],
    work: [{ id: 'w1', company: 'Sample Regional Hospital', title: 'Registered Nurse, ICU', employmentType: null, location: 'Dallas, TX', startDate: '2019-06', endDate: null, current: true, summary: null, bullets: ['Cared for 4 to 6 ICU patients a shift on a 20-bed unit.', 'Charted assessments and medications in Epic for every patient.'] }],
    resumePdf: null, wantTitle: /nurse|\bRN\b|nursing/i, wantNot: /software|engineer|accountant/i,
    tailorReply: 'B1: Cared for 4 to 6 ICU patients a shift on a 20-bed unit, with assessments and medications charted in Epic.\nB2: Charted assessments and medications in Epic for every patient.\nSUMMARY: Registered nurse, 5 years in ICU and telemetry: patient assessment, medication administration and charting in Epic.',
    contacts: [['Nia', 'Wardsley', 'Nurse Manager'], ['Tom', 'Chartwell', 'Registered Nurse']] },
  C: { key: 'C', label: 'Sam Ledgerly, accountant with 5 years who needs visa sponsorship', first: 'Sam', last: 'Ledgerly', email: 'sam.ledgerly@example.com', city: 'Chicago', region: 'IL', remote: true, sponsor: true,
    summary: 'Accountant with 5 years of month-end close, reconciliations and GAAP reporting.', titles: ['Accountant', 'Senior Accountant'], functions: ['finance'], skills: ['GAAP', 'Reconciliations', 'Month-end close', 'Excel', 'NetSuite'],
    education: [{ id: 'e1', school: 'Sample State University', degree: "Bachelor's", major: 'Accounting', gpa: null, startDate: '2015-08', endDate: '2019-05', current: false, achievements: [], coursework: [] }],
    work: [{ id: 'w1', company: 'Contoso Example Corp', title: 'Senior Accountant', employmentType: null, location: 'Chicago, IL', startDate: '2019-07', endDate: null, current: true, summary: null, bullets: ['Closed the books in 5 days each month for 3 entities.', 'Reconciled 120 balance-sheet accounts a quarter.'] }],
    resumePdf: null, wantTitle: /account|tax|audit|controller|finance/i, wantNot: /nurse|software engineer/i,
    tailorReply: 'B1: Closed the books in 5 days each month for 3 entities.\nB2: Reconciled 120 balance-sheet accounts a quarter.\nSUMMARY: Accountant with 5 years of month-end close, reconciliations and GAAP reporting.',
    contacts: [['Ana', 'Booksmith', 'Controller'], ['Lee', 'Auditwell', 'Senior Accountant']] },
};
const MARKERS = ['Testwell', 'Careford', 'Ledgerly', 'jordan.testwell@example.com', 'riley.careford@example.com', 'sam.ledgerly@example.com', '555 0100', 'Northwind Sample Labs', 'Sample Regional Hospital', 'Gate 9 tracker note', 'Sampleton', 'Wardsley', 'Booksmith'];

// ---------------------------------------------------------------- an "employer" job page on loopback, reached by a mapped host name
const employerLog = [];
const employer = http.createServer((req, res) => {
  employerLog.push({ url: req.url, headers: req.headers });
  if (req.url.startsWith('/jobs/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Operations Analyst - Example Employer</title></head><body><h1>Operations Analyst</h1><div>Example Employer · Denver, CO · Full-time</div><h2>About the role</h2><p>Run weekly reporting and improve processes.</p><h2>Requirements</h2><ul><li>Excel</li><li>SQL</li></ul><a href="https://careers.example-employer.test/apply/777">Apply</a></body></html>');
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => employer.listen(47991, '127.0.0.1', r));

rmSync(HOME, { recursive: true, force: true });
cpSync(STORE_SRC, HOME, { recursive: true, filter: (p) => !/^(logs|run|tmp)(\/|$)/.test(p.slice(STORE_SRC.length + 1)) });
const model = await startScriptedModel({ script: defaultScript });
const ai = {}; for (const k of Object.keys(PERSONAS)) ai[k] = await startAi({ reply: PERSONAS[k].tailorReply });
let srv = await startServer(HOME, { JOBLEFT_HOST_MAP: JSON.stringify({ 'careers.example-employer.test': 'http://127.0.0.1:47991' }) });
let call = api(srv.port);
let reqN = 0;
const ask = async (content) => { const r = await call('POST', '/api/v1/ai/chat', { requestId: `g9-${++reqN}`, messages: [{ role: 'user', content }] }); const ev = r.status === 200 ? parseSse(r.text) : []; return { status: r.status, text: ev.filter((e) => e.type === 'delta').map((e) => e.text).join(''), events: ev, body: r.text }; };
const feed = async (n = 20) => (await call('GET', `/api/v1/jobs?limit=${n}`)).json?.items ?? [];
const tops = {};
let browser = null;
try {
  const total = (await call('GET', '/api/v1/jobs?limit=1')).json?.total;
  note('setup', total > 10000, `${total} real jobs in the store (copy of gate 2); model stand-ins on loopback; employer page on 127.0.0.1:47991 as careers.example-employer.test`);

  // ---------------------------------------------------------------- A. the journey, three times
  for (const P of Object.values(PERSONAS)) {
    const id = P.key;
    // 1. onboarding: profile (job function, titles, location, pay, work authorization) and a resume.
    const put = await call('PUT', '/api/v1/profile', base(P));
    let resumeId = null, importNote = '';
    if (P.resumePdf) {
      // Onboarding with a resume: the app proposes a profile read from the file; the person keeps it and adds preferences.
      const imp = await call('POST', '/api/v1/resumes/import', readFileSync(P.resumePdf), { 'content-type': 'application/pdf', 'x-jobleft-filename': 'resume.pdf' });
      resumeId = imp.json?.resume?.id ?? null;
      const pp = imp.json?.proposedProfile;
      const put2 = pp ? await call('PUT', '/api/v1/profile', { ...pp, preferences: base(P).preferences, workAuthorization: base(P).workAuthorization }) : { status: 0 };
      importNote = `resume PDF imported ${imp.status}; the proposed profile (${(pp?.work ?? []).length} jobs, ${(pp?.skills ?? []).length} skills) saved ${put2.status}`;
    }
    else { const cr = await call('POST', '/api/v1/resumes', { name: `${P.first} ${P.last} resume` }); resumeId = cr.json?.id ?? null; importNote = `resume built from the profile ${cr.status}`; }
    note(`${id}.1.onboarding`, put.status === 200 && !!resumeId, `${P.label}: profile saved ${put.status}${put.status !== 200 ? ' ' + put.text.slice(0, 160) : ''}; ${importNote}`);

    // 2. five open jobs that suit the persona (the Recommended feed, no filters).
    const top = await feed(20);
    tops[id] = top.map((x) => x.job.id);
    const five = top.slice(0, 5);
    const suits = five.filter((x) => P.wantTitle.test(x.job.title) && !P.wantNot.test(x.job.title)).length;
    const openAll = five.every((x) => !x.job.closedAt);
    note(`${id}.2.five-jobs`, five.length === 5 && suits >= 4 && openAll, `top 5: ${five.map((x) => `"${x.job.title.slice(0, 40)}" ${x.match?.percent ?? '-'}%`).join('; ')} — ${suits}/5 fit the persona's line of work; all open: ${openAll}`);

    // 3. why one job is a good or poor fit.
    const j1 = five[0].job.id;
    const detail = (await call('GET', `/api/v1/jobs/${encodeURIComponent(j1)}`)).json;
    const m = detail?.match;
    const reasons = Object.values(m?.subScores ?? {}).flatMap((s) => s?.reasons ?? []);
    note(`${id}.3.why-fit`, !!m && typeof m.percent === 'number' && reasons.length >= 2 && ['experienceLevel', 'skills', 'industryExperience'].every((k) => k in (m.subScores ?? {})), `job "${detail?.job?.title?.slice(0, 40)}": ${m?.percent}% ${m?.band}; parts ${Object.entries(m?.subScores ?? {}).map(([k, v]) => `${k} ${v?.percent ?? 'n/a'}`).join(', ')}; ${reasons.length} reasons, e.g. "${String(reasons[0]?.text ?? '').slice(0, 90)}"; ${(m?.whyFit ?? []).length} why-fit chips`);

    // 4. a tailored resume for that job, saved as PDF and DOCX (the model stand-in answers with the persona's own facts).
    await call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: `${ai[id].origin}/v1`, model: 'mock-model' });
    const prop = await call('POST', `/api/v1/resumes/${resumeId}/tailor`, { jobId: j1 });
    const changes = prop.json?.changes ?? [];
    const acc = prop.status === 200 ? await call('POST', `/api/v1/resumes/${resumeId}/versions`, { proposalId: prop.json.id, acceptChangeIds: changes.map((c) => c.id) }) : { status: prop.status, text: prop.text };
    const tId = acc.json?.id;
    const pdf = tId ? await call('GET', `/api/v1/resumes/${tId}/export?format=pdf`) : { status: 0 };
    const docx = tId ? await call('GET', `/api/v1/resumes/${tId}/export?format=docx`) : { status: 0 };
    const pt = pdf.status === 200 ? pdfText(pdf.buf, `${id}.pdf`) : ''; const dt = docx.status === 200 ? docxText(docx.buf, `${id}.docx`) : '';
    const named = pt.includes(P.last) && dt.includes(P.last);
    const invented = /Kubernetes|PhD|Stanford/.test(pt);
    note(`${id}.4.tailored-pdf-docx`, prop.status === 200 && acc.status === 200 && pdf.status === 200 && docx.status === 200 && named && !invented, `tailor -> ${prop.status} (${changes.length} proposed changes, each shown with its text); accept -> ${acc.status}${acc.status !== 200 ? ' ' + String(acc.text).slice(0, 120) : ''}; PDF ${pdf.status} (${pt.length} chars, names ${P.last}: ${pt.includes(P.last)}); DOCX ${docx.status} (names ${P.last}: ${dt.includes(P.last)})`);

    // 5. applied + a reminder.
    const at = new Date(Date.now() + 3 * 86400_000).toISOString();
    const tr = await call('PATCH', `/api/v1/tracker/${encodeURIComponent(j1)}`, { status: 'applied', resumeId: tId ?? resumeId, notes: [{ text: `Gate 9 tracker note ${id}` }], reminders: [{ at, text: 'Follow up', done: false }] });
    const applied = (await call('GET', '/api/v1/tracker?view=applied')).json;
    const row = (applied?.items ?? []).find((it) => it.job?.id === j1);
    note(`${id}.5.tracker`, tr.status === 200 && !!row && row.entry?.status === 'applied' && (row.entry?.reminders ?? []).length === 1, `PATCH tracker -> ${tr.status}; Applied tab shows the job with status "${row?.entry?.status}" and ${row?.entry?.reminders?.length ?? 0} reminder (${at.slice(0, 10)})`);

    // 6. a job from a link found elsewhere (the employer page on the mapped host).
    const ext = await call('POST', '/api/v1/jobs/external', { url: `https://careers.example-employer.test/jobs/${id}77` });
    const extJob = ext.json?.job;
    const external = (await call('GET', '/api/v1/tracker?view=external')).json;
    note(`${id}.6.external-job`, ext.status === 200 && /Operations Analyst/.test(extJob?.title ?? '') && (external?.items ?? []).some((it) => it.job?.id === extJob?.id), `POST /jobs/external {url} -> ${ext.status}${ext.status !== 200 ? ' ' + ext.text.slice(0, 160) : `: "${extJob?.title}" at ${extJob?.company}; in the External tab: ${(external?.items ?? []).some((it) => it.job?.id === extJob?.id)}`}`);

    // 7. the connections file: two contacts at the top job's company, plus filler.
    const company = detail?.job?.company ?? 'Example Co';
    const csv = ['﻿Notes:', '"When exporting your connection data, you may notice that some of the email addresses are missing, because of privacy settings."', '', 'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      ...P.contacts.map(([f, l, pos], i) => `${f},${l},https://www.linkedin.com/in/${f.toLowerCase()}-${l.toLowerCase()},,"${company.replace(/"/g, '""')}",${pos},0${i + 1} Mar 2025`),
      ...Array.from({ length: 12 }, (_, i) => `Person${i},Filler${i},https://www.linkedin.com/in/filler-${i},,Employer ${i % 4},Analyst,0${(i % 9) + 1} Jan 2024`)].join('\r\n') + '\r\n';
    const imp = await call('POST', '/api/v1/network/import', Buffer.from(csv), { 'content-type': 'text/csv' });
    const rank = detail?.job?.companyKey ? (await call('GET', `/api/v1/network/rank?companyKey=${encodeURIComponent(detail.job.companyKey)}&jobId=${encodeURIComponent(j1)}`)).json : null;
    const ranked = Array.isArray(rank) ? rank : rank?.items ?? rank?.contacts ?? [];
    const first = ranked[0];
    const atCo = detail?.job?.companyKey ? (await call('GET', `/api/v1/network/contacts?companyKey=${encodeURIComponent(detail.job.companyKey)}&limit=100`)).json : null;
    const contacts = Array.isArray(atCo) ? atCo : atCo?.items ?? [];
    const person = contacts.find((c) => (c.id ?? c.contactId) === first?.contactId) ?? null;
    const firstName = person ? `${person.firstName ?? person.name ?? ''} ${person.lastName ?? ''}`.trim() : '(unknown)';
    note(`${id}.7.network`, imp.status === 200 && ranked.length >= 2 && P.contacts.some(([f, l]) => firstName.includes(f) && firstName.includes(l)), `import -> ${imp.status} (${imp.json?.imported ?? imp.json?.added ?? '?'} new contacts); who to contact at ${company}: ${ranked.length} ranked, first "${firstName}" (${(first?.reasons ?? []).map((r) => r.text).join('; ').slice(0, 80)})`);

    // 8. the assistant, about that job (the scripted model reads the stored match through the app's own tools).
    await call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: model.url, model: 'scripted-model' });
    const a = await ask(`How well do I match job ${j1}?`);
    note(`${id}.8.assistant`, a.status === 200 && a.text.length > 20 && !/undefined|\[object Object\]/.test(a.text), `chat -> ${a.status}; answer (${a.text.length} chars): "${a.text.replace(/\s+/g, ' ').slice(0, 140)}"`);
  }
  // O3: different goals, different feeds.
  const ov = (x, y) => tops[x].filter((i) => tops[y].includes(i)).length;
  note('O3.feeds-differ', ov('A', 'B') <= 2 && ov('A', 'C') <= 2 && ov('B', 'C') <= 2, `overlap of the top 20 between personas: A/B ${ov('A', 'B')}, A/C ${ov('A', 'C')}, B/C ${ov('B', 'C')}`);
  // Sponsorship wording for persona C stays hedged and sourced.
  const cTop = (await call('GET', `/api/v1/jobs/${encodeURIComponent(tops.C[0])}`)).json;
  const spons = JSON.stringify(cTop?.job?.sponsorship ?? cTop?.sponsorship ?? cTop?.company ?? {});
  note('C.sponsorship-hedged', !/does not sponsor|no h-?1b/i.test(JSON.stringify(cTop)), `top job for C: sponsorship facts ${spons.slice(0, 160) || '(none stated)'}; the words "does not sponsor"/"No H1B" appear: ${/does not sponsor|no h-?1b/i.test(JSON.stringify(cTop))}`);

  // ---------------------------------------------------------------- B. security from another origin
  const port = srv.port;
  const attackerLog = [];
  const attacker = http.createServer((req, res) => {
    attackerLog.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><script>
      const R = {}; const api = 'http://127.0.0.1:${port}/api/v1';
      const done = () => { document.title = 'PROBE:' + JSON.stringify(R); };
      (async () => {
        try { const r = await fetch(api + '/profile'); R.fetchNoToken = 'readable status ' + r.status; } catch (e) { R.fetchNoToken = 'blocked: ' + e.name; }
        try { const r = await fetch(api + '/profile', { headers: { 'x-jobleft-token': '${TOKEN}' } }); R.fetchWithToken = 'readable status ' + r.status + ' body ' + (await r.text()).slice(0, 40); } catch (e) { R.fetchWithToken = 'blocked: ' + e.name; }
        try { const r = await fetch(api + '/profile', { mode: 'no-cors', headers: { 'x-jobleft-token': '${TOKEN}' } }); R.noCors = 'type ' + r.type + ' status ' + r.status + ' body ' + (await r.text()).length; } catch (e) { R.noCors = 'blocked: ' + e.name; }
        await new Promise((res) => { const s = document.createElement('script'); s.src = api + '/profile'; s.onload = () => { R.scriptTag = 'loaded'; res(); }; s.onerror = () => { R.scriptTag = 'error'; res(); }; document.body.appendChild(s); });
        await new Promise((res) => { const i = new Image(); i.onload = () => { R.imgTag = 'loaded'; res(); }; i.onerror = () => { R.imgTag = 'error'; res(); }; i.src = api + '/resumes/x/export?format=pdf'; });
        try { const r = await fetch(api + '/tracker/x', { method: 'PATCH', mode: 'no-cors', body: '{"liked":true}' }); R.formLikePost = 'type ' + r.type; } catch (e) { R.formLikePost = 'blocked: ' + e.name; }
        R.leaked = JSON.stringify(R).includes('Testwell') || JSON.stringify(R).includes('Ledgerly');
        done();
      })();
    </script></body></html>`);
  });
  await new Promise((r) => attacker.listen(47992, '127.0.0.1', r));
  const { launch } = await import(join(ROOT, 'apps/ui/scripts/browser.ts'));
  browser = await launch(); const page = await browser.page();
  await page.goto('http://127.0.0.1:47992/evil.html');
  let probe = null; for (let i = 0; i < 100 && !probe; i++) { const t = await page.eval('document.title'); if (t.startsWith('PROBE:')) probe = JSON.parse(t.slice(6)); else await sleep(200); }
  await browser.close(); browser = null; attacker.close();
  const browserOk = !!probe && /blocked/.test(probe.fetchNoToken) && /blocked/.test(probe.fetchWithToken) && /opaque|blocked/.test(probe.noCors) && probe.scriptTag === 'error' && probe.imgTag === 'error' && !probe.leaked;
  // The same requests from here with the headers a browser would send: the server's own answers.
  const h = { origin: 'http://127.0.0.1:47992', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' };
  const s1 = await raw(port, { path: '/api/v1/profile', headers: { ...h, 'x-jobleft-token': TOKEN } });
  const s2 = await raw(port, { path: '/api/v1/profile', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script', 'x-jobleft-token': TOKEN } });
  const s3 = await raw(port, { method: 'OPTIONS', path: '/api/v1/profile', headers: { ...h, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-jobleft-token' } });
  const s4 = await raw(port, { method: 'POST', path: '/api/v1/jobs/external', headers: { ...h, 'content-type': 'text/plain', 'x-jobleft-token': TOKEN }, body: '{"text":"x"}' });
  const s5 = await raw(port, { path: '/api/v1/profile?token=' + TOKEN });
  const acao = [s1, s2, s3, s4].some((r) => r.headers['access-control-allow-origin']);
  const bodies = [s1, s2, s3, s4, s5].map((r) => r.body).join('');
  note('SEC.O1.other-origin-gets-nothing', browserOk && s1.status === 403 && s2.status === 403 && [403, 404, 405].includes(s3.status) && [403, 415].includes(s4.status) && s5.status === 400 && !acao && !MARKERS.some((m) => bodies.includes(m)), `in headless Chrome from http://127.0.0.1:47992: fetch ${probe?.fetchNoToken} / with token ${probe?.fetchWithToken} / no-cors ${probe?.noCors} / script tag ${probe?.scriptTag} / img ${probe?.imgTag} / cross-site PATCH ${probe?.formLikePost} / data seen: ${probe?.leaked}; from Node with browser headers: cross-site+token ${s1.status}, script-dest ${s2.status}, preflight ${s3.status}, text/plain POST ${s4.status}, token in query ${s5.status}; any Access-Control-Allow-Origin: ${acao}; persona data in any answer: ${MARKERS.some((m) => bodies.includes(m))}`);
  const lan = sh('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN']).stdout;
  note('SEC.O2.loopback-only', /127\.0\.0\.1:\d+ \(LISTEN\)/.test(lan) && !/\*:\d+/.test(lan), `listening sockets on port ${port}: ${lan.split('\n').slice(1).map((l) => l.split(/\s+/)[8]).filter(Boolean).join(', ')}`);

  // ---------------------------------------------------------------- C. egress
  const reqLog = existsSync(join(HOME, 'logs/requests.ndjson')) ? readFileSync(join(HOME, 'logs/requests.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const hostsRun = [...new Set(reqLog.map((e) => e.host))];
  const gate2 = existsSync(join(STORE_SRC, 'logs/requests.ndjson')) ? readFileSync(join(STORE_SRC, 'logs/requests.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const APPROVED = /^(boards-api\.greenhouse\.io|api\.lever\.co|api\.eu\.lever\.co|api\.ashbyhq\.com|apply\.workable\.com|.*\.recruitee\.com|.*\.jobs\.personio\.(de|com)|.*\.teamtailor\.com|api\.gem\.com|jobs\.lever\.co|jobs\.ashbyhq\.com|remoteok\.com|www\.themuse\.com|hn\.algolia\.com|raw\.githubusercontent\.com)$/;
  const hosts2 = [...new Set(gate2.map((e) => e.host))];
  const notApproved = hosts2.filter((h) => !APPROVED.test(h));
  const runLoopback = hostsRun.every((h) => /^(127\.0\.0\.1|localhost|careers\.example-employer\.test)$/.test(h));
  note('EGRESS.approved-hosts-only', runLoopback && notApproved.length === 0 && gate2.length > 30, `this run: ${reqLog.length} crawl-side requests to ${hostsRun.join(', ') || '(none)'}; the gate 2 crawl of 41 real boards: ${gate2.length} requests to ${hosts2.join(', ')}; not on the approved list: ${notApproved.join(', ') || 'none'}`);
  const employerText = JSON.stringify(employerLog);
  const gate2Text = JSON.stringify(gate2);
  const uaOk = employerLog.every((e) => /jobleft/i.test(e.headers['user-agent'] ?? '') && !/@/.test(e.headers['user-agent'] ?? ''));
  const leaks = MARKERS.filter((m) => employerText.includes(m) || gate2Text.includes(m));
  const aiLeaks = MARKERS.filter((m) => Object.values(ai).some((x) => JSON.stringify(x.log).includes(m)));
  note('EGRESS.no-personal-data-to-employers', employerLog.length >= 3 && uaOk && leaks.length === 0, `${employerLog.length} requests reached the employer page; User-Agent names jobleft and carries no address: ${uaOk} ("${employerLog[0]?.headers['user-agent']}"); persona markers in employer or job-board requests: ${leaks.length}; (markers do reach the chosen AI stand-in, as designed: ${aiLeaks.length > 0})`);

  await srv.stop();

  // ---------------------------------------------------------------- D. perf on 100,000 jobs
  rmSync(HOME_BIG, { recursive: true, force: true }); mkdirSync(HOME_BIG, { recursive: true });
  const { greenhouseJob, startBoards } = await import(join(ROOT, 'apps/server/scripts/mocks.ts'));
  const TITLES = ['Software Engineer', 'Registered Nurse', 'Accountant', 'Product Manager', 'Data Analyst', 'Sales Associate', 'Barista', 'Teacher', 'Designer', 'Mechanical Engineer', 'Recruiter', 'Warehouse Associate'];
  const CITIES = ['Austin, TX', 'Dallas, TX', 'Denver, CO', 'Remote', 'Chicago, IL', 'Sacramento, CA', 'New York, NY', 'Seattle, WA'];
  const boardsFile = join(HOME_BIG, 'boards.json');
  const gh = {};
  let n = 0;
  for (let b = 0; b < 50; b++) {
    const board = `bigco${b}`;
    gh[board] = Array.from({ length: 2000 }, (_, i) => { n++; return greenhouseJob(n, { board, title: `${TITLES[n % TITLES.length]} ${n % 7 === 0 ? 'II' : ''}`.trim(), location: CITIES[n % CITIES.length], content: `<p>About the role: ${TITLES[n % TITLES.length]} work on team ${n % 40}.</p><h3>Requirements</h3><ul><li>${['Python', 'SQL', 'Excel', 'BLS', 'GAAP', 'React'][n % 6]}</li><li>${n % 3} years of experience</li></ul>`, pay: n % 4 === 0 ? { min: 50000 + (n % 90) * 1000, max: 90000 + (n % 90) * 1000 } : undefined }); });
  }
  writeFileSync(boardsFile, JSON.stringify({ greenhouse: gh }));
  const mock = await startBoards({ file: boardsFile });
  const t0 = Date.now();
  const bigEnv = { JOBLEFT_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': mock.origin }) };
  const seed = { status: 0 };
  let seedS = '0';
  const big = await startServer(HOME_BIG, bigEnv);
  const cb = api(big.port);
  try {
    await cb('PUT', '/api/v1/profile', base(PERSONAS.A));
    for (let b = 0; b < 50; b++) await cb('POST', '/api/v1/boards', { ats: 'greenhouse', board: `bigco${b}` });
    await cb('POST', '/api/v1/crawl/run', {});
    for (let i = 0; i < 6000; i++) { const st = (await cb('GET', '/api/v1/crawl/status')).json; if (!st?.running && st?.lastRun) break; await sleep(250); }
    seedS = ((Date.now() - t0) / 1000).toFixed(0);
    await mock.close();
    const totalBig = (await cb('GET', '/api/v1/jobs?limit=1')).json?.total;
    // The first search after launch (a cold page cache) is timed on its own; then 100 varied searches: 20 words x 5
    // filter combinations, Recommended sort, as sys-perf O1 asks.
    const words = ['engineer', 'nurse', 'manager', 'analyst', 'designer', 'python', 'remote', 'sales', 'data', 'teacher', 'barista', 'recruiter', 'warehouse', 'product', 'mechanical', 'excel', 'sql', 'react', 'gaap', 'associate'];
    const combos = ['', '&workModel=remote', '&level=entry', '&postedWithin=7d', '&workModel=onsite&level=mid'];
    const cold = (await cb('GET', '/api/v1/jobs?q=engineer&limit=20')).ms;
    const times = { search: [], feed: [], detail: [] };
    let anyId = null; let bad = 0;
    for (const c of combos) for (const w of words) { const r = await cb('GET', `/api/v1/jobs?q=${encodeURIComponent(w)}&limit=20${c}`); if (r.status !== 200) bad++; times.search.push(r.ms); anyId ??= r.json?.items?.[0]?.job?.id ?? null; }
    for (let i = 0; i < 20; i++) { let r = await cb('GET', `/api/v1/jobs?limit=20&offset=${i * 20}`); times.feed.push(r.ms); if (anyId) { r = await cb('GET', `/api/v1/jobs/${encodeURIComponent(anyId)}`); times.detail.push(r.ms); } }
    // Awkward input: quotes, hyphens, C++, C#, a lone *, and a term with no results.
    const odd = [];
    for (const q of ['"senior engineer"', 'full-stack', 'C++', 'C#', '*', 'zzqqxxnothing']) { const r = await cb('GET', `/api/v1/jobs?q=${encodeURIComponent(q)}&limit=20`); odd.push(`${q} -> ${r.status} in ${r.ms.toFixed(0)} ms (${r.json?.total ?? r.json?.error?.code ?? '?'})`); }
    const oddOk = odd.every((o) => /-> (200|400) in \d+ ms/.test(o) && Number(/in (\d+) ms/.exec(o)[1]) < 200);
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const med = (a) => sorted(a)[Math.floor(a.length / 2)]?.toFixed(0);
    const p95 = (a) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * 0.95))]?.toFixed(0);
    const max = (a) => Math.max(...a).toFixed(0);
    const mb = Number(sh('du', ['-sm', join(HOME_BIG, 'data')]).stdout.split('\t')[0]);
    note('PERF.O1.search-fast-at-100k', seed.status === 0 && totalBig >= 100000 && bad === 0 && Number(med(times.search)) < 100 && Number(p95(times.search)) < 200 && Number(p95(times.feed)) < 200 && Number(p95(times.detail)) < 200, `${totalBig} jobs crawled from 50 stand-in boards in ${seedS} s (${mb} MB on disk); first search after launch (cold): ${cold.toFixed(0)} ms; then 100 varied searches (20 words x 5 filter sets, Recommended sort): median ${med(times.search)} ms, p95 ${p95(times.search)} ms, slowest ${max(times.search)} ms, failures ${bad}; feed page median/p95 ${med(times.feed)}/${p95(times.feed)}; detail ${med(times.detail)}/${p95(times.detail)}`);
    note('PERF.O1.awkward-input', oddOk, odd.join('; '));
  } finally { await big.stop(); }
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  try { await srv.stop(); } catch { /* stopped */ }
  await model.close?.(); for (const x of Object.values(ai)) await x.close();
  employer.close();
}

const fails = results.filter((r) => !r.ok);
const md = [`# Gate 9 (System) result, ${new Date().toISOString()}`, '', 'Three personas through the documented API on a copy of the gate 2 store (11,957 real jobs), with loopback stand-ins for the model, the assistant model and one employer page; cross-origin probes from headless Chrome; egress and marker checks; a 100,000-job store for timing.', '', '| Check | Result | Evidence |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.text.replace(/\|/g, '/').replace(/\n\s*/g, '<br>')} |`), '', `Verdict: ${fails.length ? `FAIL (${fails.map((m) => m.id).join(', ')})` : 'PASS'}`].join('\n');
writeFileSync(join(OUT, 'RESULT.md'), md);
console.log(`\nVerdict: ${fails.length ? 'FAIL' : 'PASS'} (${results.length - fails.length}/${results.length})`);
process.exit(fails.length ? 1 : 0);
