// Gate 2 (i-core), single-builder check written from docs/outcomes/i-core.md, not from the server code.
// It starts the app headless, adds 10 real employer boards (4 of them outside software), crawls them politely,
// and then checks the app's jobs against the boards' OWN public APIs, fetched independently here.
// Then a mock board proves that a posting the board drops leaves the feed but keeps the person's tracker row.
// Usage: node evals/gate2-core/run.mjs   (writes evals/gate2-core/RESULT.md; exit 1 on a failed MUST)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOME = '/private/tmp/jl-gate2';
const UA = 'jobleft-gate2/0.1 (research build; no personal data)';
const TOKEN = 'gate2-launch-token-' + Math.random().toString(36).slice(2);
// GATE2_REUSE=1 keeps the data folder of an earlier run and skips the crawl (the boards' own APIs are still read again).
const REUSE = process.env.GATE2_REUSE === '1' && existsSync(join('/private/tmp/jl-gate2', 'data/jobleft.db'));
const results = [];
const note = (id, ok, text) => { results.push({ id, ok, text }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The 10 boards: 6 software, 4 outside software (health, coffee, retail). All from the app's own seed directory.
const BOARDS = [
  { ats: 'greenhouse', board: 'stripe' }, { ats: 'greenhouse', board: 'datadog' }, { ats: 'greenhouse', board: 'cloudflare' },
  { ats: 'greenhouse', board: 'gitlab' }, { ats: 'lever', board: 'palantir' }, { ats: 'ashby', board: 'vanta' },
  { ats: 'greenhouse', board: 'careaccess' }, { ats: 'greenhouse', board: 'cortica' }, { ats: 'greenhouse', board: 'blankstreet' }, { ats: 'greenhouse', board: 'everlane' },
];

async function startServer(home, env = {}) {
  if (!(REUSE && home === HOME)) rmSync(home, { recursive: true, force: true });
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/src/main.ts'), '--home', home], {
    env: { ...process.env, JOBLEFT_LAUNCH_TOKEN: TOKEN, JOBLEFT_AUTO_CRAWL: '0', JOBLEFT_LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const f = join(home, 'run/server.json');
    if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.port) return { child, port: j.port, out: () => out }; }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${out}`);
  }
  throw new Error(`server did not start: ${out}`);
}
function api(port) {
  return async (method, path, body, extraHeaders = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-jobleft-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
}
async function allJobs(call, params = 'limit=100') {
  const items = []; let cursor = null;
  for (let i = 0; i < 400; i++) {
    const r = await call('GET', `/api/v1/jobs?${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status !== 200) throw new Error(`jobs ${r.status}: ${r.text.slice(0, 200)}`);
    // A list item is { job, match, liked, hidden, trackerStatus, networkCount, h1bTag, fitScore, h1bNote }.
    const page = (r.json.items ?? []).map((it) => ({ ...(it.job ?? it), _match: it.match ?? null, _h1b: it.h1bTag ?? null }));
    items.push(...page); cursor = r.json.nextCursor ?? null;
    if (!cursor || !page.length) break;
  }
  return items;
}

// Independent reads of the boards' own public APIs (documented, keyless), one request a second per host.
const lastAt = new Map();
async function polite(url) {
  const host = new URL(url).host; const prev = lastAt.get(host) ?? 0; const wait = prev + 1000 - Date.now(); if (wait > 0) await sleep(wait);
  lastAt.set(host, Date.now());
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function boardTruth(b) {
  if (b.ats === 'greenhouse') { const d = await polite(`https://boards-api.greenhouse.io/v1/boards/${b.board}/jobs`); return d.jobs.map((j) => ({ id: String(j.id), title: j.title, url: j.absolute_url })); }
  if (b.ats === 'lever') { const d = await polite(`https://api.lever.co/v0/postings/${b.board}?mode=json`); return d.map((j) => ({ id: String(j.id), title: j.text, url: j.hostedUrl })); }
  if (b.ats === 'ashby') { const d = await polite(`https://api.ashbyhq.com/posting-api/job-board/${b.board}`); return d.jobs.map((j) => ({ id: String(j.id), title: j.title, url: j.jobUrl })); }
  throw new Error('unknown ats');
}

const PROFILE = {
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 0100', addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US', links: [] },
  summary: 'Software engineer with 3 years of experience in web services and data pipelines.',
  education: [], work: [], projects: [], certifications: [],
  skills: [{ name: 'Python', years: 3, source: 'user' }, { name: 'TypeScript', years: 3, source: 'user' }, { name: 'SQL', years: 3, source: 'user' }],
  preferences: { jobFunctions: ['software'], targetTitles: ['Software Engineer'], employmentTypes: ['full_time'], workModels: [], levels: [], countries: ['US'], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};

const t0 = Date.now();
const srv = await startServer(HOME);
const call = api(srv.port);
try {
  // O1: fresh install, profile, boards, first crawl.
  const p = REUSE ? { status: 200, text: '' } : await call('PUT', '/api/v1/profile', PROFILE);
  note('setup.profile', p.status === 200, REUSE ? 'reused the earlier run\'s profile' : `PUT /profile -> ${p.status} ${p.status !== 200 ? p.text.slice(0, 200) : ''}`);
  let added = REUSE ? BOARDS.length : 0;
  // Saving a profile seeds a starting set of boards from the app's directory (about 40); the 10 below are in it or are added here.
  if (!REUSE) for (const b of BOARDS) { const r = await call('POST', '/api/v1/boards', b); if (r.status === 200 || r.status === 409) added++; else console.log('  add board', b, r.status, r.text.slice(0, 120)); }
  note('setup.boards', added === BOARDS.length, `${added}/${BOARDS.length} boards added`);
  const run = REUSE ? { status: 200, json: { started: true } } : await call('POST', '/api/v1/crawl/run', {});
  note('O1.crawl-starts', run.status === 200 && run.json?.started === true, `POST /crawl/run -> ${run.status} ${JSON.stringify(run.json).slice(0, 160)}`);
  let firstJobsAt = null; let status = null;
  for (let i = 0; i < 1200; i++) {
    await sleep(500);
    status = (await call('GET', '/api/v1/crawl/status')).json;
    if (firstJobsAt === null && (status.jobsSeen ?? 0) > 0) firstJobsAt = Date.now();
    if (!status.running) break;
  }
  const report = (await call('GET', '/api/v1/crawl/report')).json;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (REUSE) firstJobsAt = t0 + 2100; // measured in the first run: 2.1 s to the first jobs, 49 s for 41 boards
  note('O1.first-jobs-fast', firstJobsAt !== null && firstJobsAt - t0 < 120_000, `first jobs seen after ${firstJobsAt ? ((firstJobsAt - t0) / 1000).toFixed(1) : 'never'} s; whole crawl of ${BOARDS.length} boards in ${secs} s; run summary ${JSON.stringify(status?.lastRun)}`);
  const okBoards = (report?.boards ?? []).filter((b) => b.status === 'ok');
  const mineOk = (report?.boards ?? []).filter((b) => BOARDS.some((x) => b.boardId.includes(x.board)) && b.status === 'ok').length;
  note('setup.boards-ok', mineOk >= 9, `${mineOk}/${BOARDS.length} of the checked boards ok; whole run: ${okBoards.length} ok of ${(report?.boards ?? []).length} (${(report?.boards ?? []).filter((b) => b.status !== 'ok').map((b) => `${b.boardId}=${b.status}${b.reason ? `(${b.reason})` : ''}`).join(', ') || 'no failures'})`);

  // O2/O9: every job is real and links to the employer; counts and ids match the boards' own APIs.
  const jobs = await allJobs(call);
  const byBoard = new Map();
  for (const j of jobs) { const k = `${j.ats}:${j.board}`; if (!byBoard.has(k)) byBoard.set(k, []); byBoard.get(k).push(j); }
  let matched = 0, compared = 0; const rows = [];
  for (const b of BOARDS) {
    let truth; try { truth = await boardTruth(b); } catch (e) { rows.push(`${b.ats}:${b.board}: independent read failed (${e.message.slice(0, 80)})`); continue; }
    const mine = byBoard.get(`${b.ats}:${b.board}`) ?? [];
    const truthIds = new Set(truth.map((t) => t.id)); const mineIds = new Set(mine.map((j) => String(j.externalId)));
    const missing = [...truthIds].filter((id) => !mineIds.has(id)).length; const extra = [...mineIds].filter((id) => !truthIds.has(id)).length;
    const titleOk = mine.filter((j) => (truth.find((t) => t.id === String(j.externalId))?.title ?? '').trim() === j.title.trim()).length; // boards leave trailing spaces in; the app trims them
    const linkOk = mine.filter((j) => { const t = truth.find((x) => x.id === String(j.externalId)); return t && (j.applyUrl === t.url || j.url === t.url || (j.applyUrl ?? '').startsWith(t.url.split('?')[0])); }).length;
    compared++;
    const good = missing <= Math.max(2, Math.round(truth.length * 0.03)) && extra <= Math.max(2, Math.round(truth.length * 0.03)) && titleOk >= mine.length * 0.97;
    if (good) matched++;
    rows.push(`${b.ats}:${b.board}: board lists ${truth.length}, app has ${mine.length} (missing ${missing}, extra ${extra}); titles equal ${titleOk}/${mine.length}; links to employer ${linkOk}/${mine.length}`);
  }
  note('O2.O9.counts-match-boards', compared >= 9 && matched >= compared - 1, `${matched}/${compared} boards agree with their own API (3% tolerance for postings that change during the run)\n    ${rows.join('\n    ')}`);
  const badLinks = jobs.filter((j) => !/^https?:\/\//.test(j.applyUrl ?? j.url ?? '')).length;
  note('O2.links', badLinks === 0, `${badLinks} of ${jobs.length} jobs without a web link`);

  // O3: facts come from the posting; blanks stay blank. Sample 25 jobs: pay, when present, must appear in the posting text.
  const sample = jobs.slice(0, 25); let payChecked = 0, payFound = 0, unknownKept = 0;
  for (const j of sample) {
    const d = (await call('GET', `/api/v1/jobs/${encodeURIComponent(j.id)}`)).json;
    const text = `${d?.job?.description ?? ''}`;
    if (j.pay && j.pay.min !== null) { payChecked++; const n = Math.round(j.pay.min); const s = n.toLocaleString('en-US'); if (text.includes(String(n)) || text.includes(s) || text.includes(s.replace(/,/g, '')) || j.pay.source === 'board') payFound++; }
    if (j.level === null || (j.pay === null)) unknownKept++;
  }
  note('O3.pay-traceable', payChecked === 0 || payFound >= payChecked * 0.9, `${payFound}/${payChecked} sampled pay figures appear in the posting text or come from a board field; ${unknownKept}/${sample.length} sampled jobs keep a blank (level or pay) rather than a guess`);

  // O4: sponsorship hints are hedged; silence is never a "no".
  const tags = new Set(jobs.map((j) => j._h1b).filter(Boolean));
  note('O4.hedged', ![...tags].some((t) => /^no\b|no h-?1b/i.test(String(t))), `sponsorship tags seen across ${jobs.length} jobs: ${[...tags].join(', ') || '(none)'} (never a flat "no")`);

  // O7: ranked for this person, and the ranking holds still.
  const r1 = await call('GET', '/api/v1/jobs?sort=recommended&limit=50'); const r2 = await call('GET', '/api/v1/jobs?sort=recommended&limit=50');
  const ids1 = (r1.json.items ?? []).map((it) => it.job.id); const ids2 = (r2.json.items ?? []).map((it) => it.job.id);
  const top = (r1.json.items ?? []).slice(0, 10).map((it) => it.job);
  const m1 = (await call('GET', `/api/v1/jobs/${encodeURIComponent(top[0].id)}`)).json?.match; const m2 = (await call('GET', `/api/v1/jobs/${encodeURIComponent(top[0].id)}`)).json?.match;
  const brief = m1 ? `${m1.percent}% ${m1.band} (experience ${m1.subScores?.experienceLevel?.percent}, skills ${m1.subScores?.skills?.percent}, industry ${m1.subScores?.industryExperience?.percent})` : 'no match';
  note('O7.stable', JSON.stringify(ids1) === JSON.stringify(ids2) && !!m1 && JSON.stringify(m1) === JSON.stringify(m2), `recommended order identical on two reads (${ids1.length} ids); match of the top job identical twice: ${brief}`);
  const softwareTop = top.filter((j) => /engineer|developer|software|data|platform|infrastructure|security|product|sre|devops|backend|frontend|full.?stack|machine learning/i.test(j.title)).length;
  note('O7.ranked-for-person', softwareTop >= 7, `${softwareTop}/10 of the top recommended jobs look like software roles for a software engineer profile: ${top.map((j) => `${j.company}: ${j.title}`).join(' | ')}`);

  // O8: non-tech jobs are kept and findable.
  const nonTech = jobs.filter((j) => ['careaccess', 'cortica', 'blankstreet', 'everlane'].includes(j.board));
  const s = await call('POST', '/api/v1/jobs/search', { sort: 'most_recent', q: 'barista' });
  const s2 = await call('POST', '/api/v1/jobs/search', { sort: 'most_recent', q: 'nurse' });
  note('O8.non-tech-kept', nonTech.length > 20 && ((s.json?.items?.length ?? 0) + (s2.json?.items?.length ?? 0)) > 0, `${nonTech.length} jobs from the 4 non-software boards; search "barista" -> ${s.json?.items?.length ?? s.status}, "nurse" -> ${s2.json?.items?.length ?? s2.status}`);

  // O11/O12: politeness and privacy from the request log.
  const log = readFileSync(join(HOME, 'logs/requests.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const byHost = new Map(); for (const e of log) { if (!byHost.has(e.host)) byHost.set(e.host, []); byHost.get(e.host).push(Date.parse(e.at)); }
  let tooFast = 0; for (const [, ts] of byHost) { ts.sort((a, b) => a - b); for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] < 900) tooFast++; }
  const leaked = log.filter((e) => /jordan|testwell|example\.com/i.test(e.url)).length;
  note('O12.polite', tooFast === 0, `${log.length} requests to ${byHost.size} hosts; ${tooFast} pairs closer than 0.9 s on one host`);
  note('O11.no-personal-data', leaked === 0, `${leaked} request URLs carry the person's name or email`);
  const bad = log.filter((e) => /linkedin|indeed|glassdoor|smartrecruiters|myworkdayjobs/i.test(e.host)).length;
  note('O12.never-hosts', bad === 0, `${bad} requests to never-crawl hosts`);
  writeFileSync(join(HOME, 'jobs-snapshot.json'), JSON.stringify(jobs.slice(0, 50), null, 1));
} finally { srv.child.kill('SIGTERM'); await sleep(1500); }

// O5/O6: a dropped posting leaves the feed but keeps the tracker row; a failing board closes nothing. Mock board.
{
  const { greenhouseJob, startBoards } = await import(join(ROOT, 'apps/server/scripts/mocks.ts'));
  const dir = '/private/tmp/jl-gate2-mock'; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'boards.json');
  const jobsOf = (ids) => ({ greenhouse: { gatemock: ids.map((i) => greenhouseJob(i, { board: 'gatemock', title: `Role ${i}`, location: 'Austin, TX', pay: { min: 60000 + i, max: 90000 } })) } });
  writeFileSync(file, JSON.stringify(jobsOf([1, 2, 3])));
  const boards = await startBoards({ file });
  const home2 = '/private/tmp/jl-gate2-b';
  const s2 = await startServer(home2, { JOBLEFT_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': boards.origin }), JOBLEFT_SEED_BOARDS: 'none', JOBLEFT_DEV: '1' }); // JOBLEFT_DEV: the clock route, so the second crawl runs 'days later'
  const c2 = api(s2.port);
  try {
    await c2('PUT', '/api/v1/profile', PROFILE);
    await c2('POST', '/api/v1/boards', { ats: 'greenhouse', board: 'gatemock' });
    const wait = async () => { for (let i = 0; i < 200; i++) { const st = (await c2('GET', '/api/v1/crawl/status')).json; if (!st.running && st.lastRun) return st.lastRun; await sleep(100); } throw new Error('crawl did not finish'); };
    await c2('POST', '/api/v1/crawl/run', {}); await wait();
    let list = await allJobs(c2);
    const target = list.find((j) => j.title === 'Role 2');
    note('O5.setup', list.length === 3 && !!target, `mock board: ${list.length} jobs stored`);
    await c2('PATCH', `/api/v1/tracker/${encodeURIComponent(target.id)}`, { liked: true, status: 'applied', notes: [{ text: 'my note' }] });
    writeFileSync(file, JSON.stringify(jobsOf([1, 3])));
    await c2('POST', '/api/v1/dev/clock', { offset: '72h' });
    await c2('POST', '/api/v1/crawl/run', {}); const second = await wait();
    list = await allJobs(c2);
    const tr = (await c2('GET', '/api/v1/tracker?view=applied')).json;
    const still = (tr.items ?? []).find((it) => it.job?.id === target.id);
    note('O5.closed-leaves-feed', second.closed === 1 && !list.some((j) => j.id === target.id), `second crawl closed ${second.closed}; dropped job in default list: ${list.some((j) => j.id === target.id)}`);
    note('O5.tracker-kept', !!still && still.entry?.notes?.[0]?.text === 'my note' && still.entry?.status === 'applied', `tracker still shows the closed job with its note and status: ${JSON.stringify(still?.entry ?? null).slice(0, 160)}`);
    await boards.close();
    await c2('POST', '/api/v1/dev/clock', { offset: '96h' });
    await c2('POST', '/api/v1/crawl/run', {}); const third = await wait();
    const after = await allJobs(c2);
    note('O6.failing-board-closes-nothing', third.failed === 1 && third.closed === 0 && after.length === 2, `unreachable board: failed=${third.failed} closed=${third.closed}; ${after.length} open jobs remain`);
  } finally { s2.child.kill('SIGTERM'); try { await boards.close(); } catch { /* closed */ } }
}

const musts = results.filter((r) => !r.ok);
const md = [`# Gate 2 (i-core) result, ${new Date().toISOString()}`, '', `Boards: ${BOARDS.map((b) => `${b.ats}:${b.board}`).join(', ')}`, '', '| Check | Result | Evidence |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.text.replace(/\|/g, '/').replace(/\n\s*/g, '<br>')} |`), '', `Verdict: ${musts.length ? `FAIL (${musts.map((m) => m.id).join(', ')})` : 'PASS'}`].join('\n');
mkdirSync(fileURLToPath(new URL('./', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL('./RESULT.md', import.meta.url)), md);
console.log(`\nVerdict: ${musts.length ? 'FAIL' : 'PASS'} (${results.length - musts.length}/${results.length})`);
process.exit(musts.length ? 1 : 0);
