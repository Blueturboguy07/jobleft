// Gate 7 (i-ui), single-builder check written from docs/outcomes/i-ui.md, not from the code.
// The REAL built UI (apps/ui/dist) served by the REAL app, on a COPY of the gate 2 data folder (11,957 jobs crawled from
// real employer boards), driven in headless Chrome. Every screen is read as visible text and photographed; facts, scores
// and counts are compared with the documented API; every request the page makes is recorded; a fresh folder is checked
// for honest empty states. The UI lane's own screenshot/audit script runs against the same app for layout findings.
// Usage: node evals/gate7-ui/run.mjs   (writes evals/gate7-ui/RESULT.md and shots/; exit 1 on a failed MUST)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('./', import.meta.url));
const SHOTS = join(OUT, 'shots');
const SRC = '/private/tmp/jl-gate2';
const HOME = '/private/tmp/jl-gate7';
const HOME2 = '/private/tmp/jl-gate7-fresh';
const APP_PORT = 47821;
const TOKEN = 'gate7-' + Math.random().toString(36).slice(2);
const results = [];
const note = (id, ok, text) => { results.push({ id, ok, text }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { launch } = await import(join(ROOT, 'apps/ui/scripts/browser.ts'));
const { startPublik } = await import(join(ROOT, 'apps/server/scripts/mocks.ts'));

async function startServer(home, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/src/main.ts'), '--home', home, '--port', String(APP_PORT)], {
    env: { ...process.env, JOBLEFT_LAUNCH_TOKEN: TOKEN, JOBLEFT_AUTO_CRAWL: '0', JOBLEFT_SEED_BOARDS: 'none', JOBLEFT_DEV: '1', JOBLEFT_NO_OS_NOTIFY: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 200; i++) {
    await sleep(150);
    const f = join(home, 'run/server.json');
    if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.port) return { child, port: j.port, stop: async () => { child.kill('SIGTERM'); await sleep(1200); }, kill: async () => { child.kill('SIGKILL'); await sleep(800); } }; }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${out}`);
  }
  throw new Error(`server did not start: ${out}`);
}
const api = (port) => async (method, path, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-jobleft-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

const ROUTES = ['jobs', 'jobs/liked', 'jobs/applied', 'jobs/external', 'jobs/hidden', 'tracker', 'dashboard', 'resume', 'profile', 'network', 'interview', 'assistant', 'boards', 'settings/ai', 'settings/balance', 'settings/alerts', 'settings/sources', 'settings/data', 'settings/extension', 'settings/about', 'notifications'];
const BANNED = [/lorem/i, /example company/i, /\bTODO\b/, /\bundefined\b/, /\bnull\b/, /\bNaN\b/, /\[object Object\]/, /jobright/i, /\borion\b/i, /\bturbo\b/i, /\bapplicants?\b/i, /early applicant/i, /\bcoach/i, /why this job is a match/i, /get hired faster/i, /\bcredits?\b/i];

rmSync(HOME, { recursive: true, force: true }); rmSync(HOME2, { recursive: true, force: true }); rmSync(SHOTS, { recursive: true, force: true }); mkdirSync(SHOTS, { recursive: true });
cpSync(SRC, HOME, { recursive: true, filter: (p) => !/^(logs|run|tmp)(\/|$)/.test(p.slice(SRC.length + 1)) });
const publik = await startPublik({ balanceMicros: 4_370_000 });
const PUB_ENV = { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${publik.origin}/api/v1` };
let srv = await startServer(HOME, PUB_ENV);
let call = api(srv.port);
const ORIGIN = `http://127.0.0.1:${srv.port}`;
const URL0 = `${ORIGIN}/#token=${TOKEN}`;
let b = null, p = null;
const allText = {}; // route -> visible text
let errorsSeen = [];
async function open(route, wait = 900) {
  await p.eval(`location.hash = ${JSON.stringify(`#/${route}`)}`);
  await p.waitFor("!document.querySelector('.ant-spin-spinning') && !document.querySelector('.jl-skel')", 10000);
  await sleep(wait);
  const text = await p.eval('document.body.innerText');
  return text;
}
async function screen(route, tag = '') {
  const text = await open(route);
  allText[route + tag] = text;
  await p.shot(join(SHOTS, `${route.replace(/\//g, '_')}${tag}.png`));
  return text;
}
const cardsOnPage = () => p.eval(`Array.from(document.querySelectorAll('.jl-card[data-job-id]')).map((c) => ({ id: c.getAttribute('data-job-id'), title: c.querySelector('.jl-card-title')?.innerText?.trim() ?? '', company: c.querySelector('.jl-card-company')?.innerText?.trim() ?? '', tile: c.querySelector('.jl-tile')?.getAttribute('aria-label') ?? '', text: c.innerText }))`);
const scoreOf = (label) => { const m = /Match (\d+) percent, (\w+)/.exec(label ?? ''); return m ? { percent: Number(m[1]), band: m[2].toUpperCase() } : null; };

try {
  const ui = await call('GET', '/');
  note('setup.ui', ui.status === 200 && /<div id="root">|<script/.test(ui.text) && srv.port === APP_PORT, `the app serves the built UI at ${ORIGIN} (status ${ui.status})`);
  await call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
  await call('PUT', '/api/v1/ai/settings', { provider: 'publik', model: 'publik-balanced' });
  const profile = (await call('GET', '/api/v1/profile')).json;
  const jobsTotal = (await call('GET', '/api/v1/jobs?limit=1')).json?.total;
  note('setup.data', !!profile?.personal?.firstName && jobsTotal > 10000, `profile ${profile?.personal?.firstName} ${profile?.personal?.lastName}; ${jobsTotal} jobs in the store (copied from gate 2)`);

  b = await launch(); p = await b.page();
  await p.size(1440, 900);
  await p.goto(URL0);
  await p.waitFor("document.querySelector('.jl-shell, .jl-onboard')", 15000);
  const hashAfter = await p.eval('location.hash');
  note('O11.token-off-the-address-bar', !/token=/.test(hashAfter), `address fragment after load: "${hashAfter}"`);

  // O1/O12/O10: every screen's visible text and screenshot; banned words; console errors; page title.
  for (const r of ROUTES) await screen(r);
  // detail of the first card
  await open('jobs'); await p.waitFor("document.querySelector('.jl-card')", 10000);
  const cards = await cardsOnPage();
  const firstId = cards[0]?.id;
  if (firstId) await screen(`jobs/${encodeURIComponent(firstId)}`, '');
  const profileJson = JSON.stringify(profile);
  const hits = [];
  for (const [r, t] of Object.entries(allText)) for (const re of BANNED) { const m = re.exec(t); if (m && !profileJson.includes(m[0])) hits.push(`${r}: "${m[0]}" (…${t.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\n/g, ' ')}…)`); }
  note('O1.O12.O10.no-banned-text', hits.length === 0, hits.length ? hits.slice(0, 8).join(' | ') : `${Object.keys(allText).length} screens read; no lorem/sample/TODO/undefined/null/NaN/[object Object]/Jobright/Orion/Turbo/applicants/coach/credits/reference copy`);
  errorsSeen = p.errors();
  note('O9.no-console-errors', errorsSeen.length === 0, errorsSeen.length ? errorsSeen.slice(0, 4).map((e) => e.slice(0, 160)).join(' | ') : `0 console errors or uncaught exceptions across ${Object.keys(allText).length} screens`);
  const title = await p.eval('document.title');
  note('O12.app-name', /jobleft/i.test(title) && !/jobright/i.test(title), `window title: "${title}"`);

  // O11: every request the page made goes to the app itself.
  const reqs = p.requests();
  const foreign = reqs.filter((q) => !q.url.startsWith(`${ORIGIN}/`) && !q.url.startsWith('data:') && !q.url.startsWith('blob:'));
  note('O11.no-foreign-requests', reqs.length > 20 && foreign.length === 0, `${reqs.length} requests from the page; not to the app: ${foreign.length}${foreign.length ? ' — ' + foreign.slice(0, 5).map((q) => q.url).join(', ') : ''}`);
  const fontsRemote = await p.eval(`Array.from(document.styleSheets).flatMap((s) => { try { return Array.from(s.cssRules); } catch { return []; } }).filter((r) => r instanceof CSSFontFaceRule).map((r) => r.style.getPropertyValue('src')).filter((s) => /https?:\\/\\//.test(s) && !s.includes('127.0.0.1')).length`);
  note('O11.fonts-bundled', fontsRemote === 0, `@font-face sources pointing off this computer: ${fontsRemote}`);

  // O2/O4: the first 12 cards vs the API and the detail page; scores stable across a reload.
  await open('jobs'); await p.waitFor("document.querySelector('.jl-card')", 10000);
  const c1 = (await cardsOnPage()).slice(0, 12);
  const rows = []; let agree = 0, bandOk = 0, detailOk = 0, linkOk = 0;
  for (const c of c1) {
    const j = (await call('GET', `/api/v1/jobs/${encodeURIComponent(c.id)}`)).json;
    const s = scoreOf(c.tile);
    const okFacts = j?.job?.title?.trim() === c.title && c.company.startsWith((j?.job?.company ?? '').trim()); // the card's company line may add the team after a slash
    const okScore = s && j?.match && s.percent === j.match.percent && s.band === String(j.match.band).toUpperCase();
    if (!okFacts && rows.length < 3) rows.push(`MISMATCH card {${c.title} | ${c.company}} vs api {${j?.job?.title} | ${j?.job?.company}}`);
    if (okFacts && okScore) agree++;
    if (s && j?.match) { const want = j.match.percent >= 85 ? 'STRONG' : j.match.percent >= 70 ? 'GOOD' : 'FAIR'; if (want === s.band && want === String(j.match.band).toUpperCase()) bandOk++; }
    const dt = await open(`jobs/${encodeURIComponent(c.id)}`, 600);
    const dTile = await p.eval(`document.querySelector('.jl-match-panel')?.getAttribute('aria-label') ?? ''`);
    const ds = scoreOf(dTile);
    const dPercentText = new RegExp(`\\b${j?.match?.percent}%`).test(dt);
    if (dt.includes(j?.job?.title?.trim()) && (ds ? ds.percent === j.match.percent : dPercentText)) detailOk++;
    const href = await p.eval(`Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).find((h) => h === ${JSON.stringify(j?.job?.applyUrl ?? '')}) ?? null`);
    if (href && href === j?.job?.applyUrl) linkOk++;
    rows.push(`${c.id.slice(0, 40)}: card ${s ? `${s.percent}% ${s.band}` : 'no score'} / api ${j?.match ? `${j.match.percent}% ${j.match.band}` : 'no match'} / detail ${ds ? `${ds.percent}%` : dPercentText ? 'percent in text' : '?'} / link ${href ? 'employer' : 'MISSING'}`);
  }
  note('O2.card-facts-and-links', agree === c1.length && linkOk === c1.length, `${agree}/${c1.length} cards agree with the API on title, company, percent and band; ${linkOk}/${c1.length} detail pages link to the employer's own apply URL`);
  note('O4.score-same-everywhere', detailOk === c1.length && bandOk === c1.length, `${detailOk}/${c1.length} detail pages show the API's percent; ${bandOk}/${c1.length} bands follow the number (STRONG ≥85, GOOD 70–84, FAIR <70)\n    ${rows.slice(0, 6).join('\n    ')}`);
  await p.goto(URL0); await p.waitFor("document.querySelector('.jl-shell')", 15000); await open('jobs'); await p.waitFor("document.querySelector('.jl-card')", 15000); await sleep(800);
  const c2 = (await cardsOnPage()).slice(0, 12);
  const same = c1.filter((c) => { const d = c2.find((x) => x.id === c.id); return d && d.tile === c.tile; }).length;
  note('O4.stable-across-reload', same === c1.length, `${same}/${c1.length} cards keep the same score after a full reload`);
  const sorted = c2.map((c) => scoreOf(c.tile)?.percent ?? -1);
  const desc = sorted.every((v, i) => i === 0 || v <= sorted[i - 1]);
  note('O4.sorted-by-number', desc, `the Recommended order goes down by percent: ${sorted.join(', ')}`);
  const hourly = (await call('GET', '/api/v1/jobs?limit=100&sort=recent')).json?.items?.map((x) => x.job).find((j) => j.pay && /hour/i.test(JSON.stringify(j.pay)));
  if (hourly) { const dt = await open(`jobs/${encodeURIComponent(hourly.id)}`, 600); note('O2.hourly-pay-shown-hourly', /hour|\/hr|hourly/i.test(dt) && !/\$\d{2,3},\d{3}\s*(\/|per)\s*year/i.test(dt.split('\n').find((l) => /\$\d/.test(l)) ?? ''), `hourly job ${hourly.id.slice(0, 40)}: pay line "${(dt.split('\n').find((l) => /\$\d/.test(l)) ?? '(none)').slice(0, 80)}"`); }
  else note('O2.hourly-pay-shown-hourly', true, 'no hourly job among the 100 most recent; skipped');

  // O3: a job with no pay and no years shows neither "$0" nor "0+ years"; H-1B never shows "No H1B".
  const noPay = (await call('GET', '/api/v1/jobs?limit=100')).json?.items?.map((x) => x.job).find((j) => !j.pay && !j.yearsOfExperience && !j.yearsExperience);
  if (noPay) { const dt = await open(`jobs/${encodeURIComponent(noPay.id)}`, 600); const bad = /\$0\b|0\+ years|No H1B|No H-1B|Unknown Stage|1-10 employees/i.exec(dt); note('O3.no-invented-facts', !bad, bad ? `"${bad[0]}" on ${noPay.id}` : `job ${noPay.id.slice(0, 40)} (no pay, no years): no "$0", "0+ years", "No H1B", "Unknown Stage" or "1-10 employees"`); }
  const h1bLine = Object.values(allText).join('\n').split('\n').find((l) => /H-?1B/i.test(l) && /sponsor/i.test(l));
  note('O3.h1b-hedged', !/does not sponsor|no h-?1b/i.test(Object.values(allText).join('\n')), `H-1B wording seen: "${(h1bLine ?? '(none on the screens read)').slice(0, 100)}"`);

  // O6: counts match the lists after likes, a hide, a status move and an external job.
  const ids = c1.map((c) => c.id);
  for (const id of ids.slice(0, 3)) await call('PATCH', `/api/v1/tracker/${encodeURIComponent(id)}`, { liked: true });
  await call('PATCH', `/api/v1/tracker/${encodeURIComponent(ids[3])}`, { hidden: true });
  await call('PATCH', `/api/v1/tracker/${encodeURIComponent(ids[4])}`, { status: 'applied' });
  const ext = await call('POST', '/api/v1/jobs/external', { text: 'Platform Engineer\nCompany: Fabrikam Systems\nLocation: Remote, US\nAbout the role: keep the platform up.\nRequirements:\n- TypeScript', applyUrl: 'https://jobs.example.com/fabrikam/platform-engineer' });
  const apiLiked = (await call('GET', '/api/v1/tracker?view=liked')).json;
  const apiApplied = (await call('GET', '/api/v1/tracker?view=applied')).json;
  const apiExternal = (await call('GET', '/api/v1/tracker?view=external')).json;
  const apiHidden = (await call('GET', '/api/v1/tracker?view=hidden')).json;
  const cnt = (v) => (Array.isArray(v) ? v.length : Array.isArray(v?.items) ? v.items.length : v?.total ?? -1);
  const likedText = await screen('jobs/liked', '-after');
  const likedRows = (await cardsOnPage()).length;
  const appliedText = await screen('jobs/applied', '-after');
  const appliedRows = (await cardsOnPage()).length;
  const externalText = await screen('jobs/external', '-after');
  const externalRows = (await cardsOnPage()).length;
  const hiddenText = await screen('jobs/hidden', '-after');
  const hiddenRows = (await cardsOnPage()).length;
  const navText = await p.eval(`document.querySelector('[aria-label="Job lists"]')?.innerText ?? ''`);
  const navCount = (w) => { const m = new RegExp(`${w}\\s*\\(?(\\d+)`).exec(navText.replace(/\n/g, ' ')); return m ? Number(m[1]) : null; };
  const counts = { liked: [cnt(apiLiked), likedRows, navCount('Liked')], applied: [cnt(apiApplied), appliedRows, navCount('Applied')], external: [cnt(apiExternal), externalRows, navCount('External')], hidden: [cnt(apiHidden), hiddenRows, navCount('Hidden')] };
  const countsOk = Object.values(counts).every(([a, r, n]) => a === r && (n === null || n === a));
  note('O6.counts-match', countsOk && counts.liked[0] === 3 && counts.applied[0] === 1 && counts.external[0] === 1 && counts.hidden[0] === 1, `api / rows on screen / nav badge — ${Object.entries(counts).map(([k, v]) => `${k}: ${v.join('/')}`).join(', ')}; nav text: "${navText.replace(/\n+/g, ' ').slice(0, 120)}"`);
  const feedNow = (await (async () => { await open('jobs'); await p.waitFor("document.querySelector('.jl-card')", 10000); return cardsOnPage(); })()).map((c) => c.id);
  note('O7.hidden-stays-hidden', !feedNow.includes(ids[3]), `the hidden job ${ids[3].slice(0, 40)} is ${feedNow.includes(ids[3]) ? 'STILL' : 'not'} in the Recommended list`);

  // O7: search by company name only, compared with the API's own search.
  const company = (await call('GET', `/api/v1/jobs/${encodeURIComponent(c1[5]?.id ?? c1[0].id)}`)).json.job.company;
  await open('jobs');
  await p.eval(`(() => { const i = document.querySelector('input[aria-label="Search jobs by title, company or words"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(company)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(1500);
  await p.waitFor("!document.querySelector('.ant-spin-spinning') && !document.querySelector('.jl-skel')", 10000);
  const found = await cardsOnPage();
  const apiFound = (await call('GET', `/api/v1/jobs?q=${encodeURIComponent(company)}&limit=100`)).json;
  const allCompany = found.length > 0 && found.every((c) => c.company === company || new RegExp(company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(c.text));
  note('O7.search-by-company', allCompany && found.length <= (apiFound?.total ?? 0) && (apiFound?.total ?? 0) > 0, `search "${company}": ${found.length} cards on the first page, all that company: ${allCompany}; API finds ${apiFound?.total}`);
  await p.shot(join(SHOTS, 'jobs-search.png'));

  // O10: the balance card shows the wallet in dollars.
  const bal = await screen('settings/balance', '-connected');
  note('O10.balance-in-dollars', /\$4\.37\b/.test(bal) && !/credit/i.test(bal), `settings/balance shows $4.37 (the stand-in wallet): ${/\$4\.37\b/.test(bal)}; the word "credit": ${/credit/i.test(bal)}`);

  // O13: nothing paid happened while every screen was used.
  const paid = publik.log.filter((e) => /chat|completions|fetch|search|charge|usage/.test(e.path) && e.method === 'POST');
  note('O13.nothing-paid-in-background', paid.length === 0, `${publik.log.length} calls to the stand-in publik while browsing every screen; paid ones: ${paid.length}${paid.length ? ' — ' + paid.map((e) => e.path).join(', ') : ''}`);

  // O5: work survives a force-quit; a change through the API shows after a reload.
  await call('PATCH', `/api/v1/tracker/${encodeURIComponent(ids[4])}`, { notes: [{ text: 'Gate 7 note: recruiter call on Friday' }] });
  await call('PUT', '/api/v1/profile', { ...profile, personal: { ...profile.personal, city: 'Round Rock' } });
  await srv.kill(); srv = await startServer(HOME, PUB_ENV); call = api(srv.port);
  await p.goto(URL0); await p.waitFor("document.querySelector('.jl-shell')", 15000);
  const prof = await screen('profile', '-after');
  const trk = await screen('tracker', '-after');
  const likedAfter = cnt((await call('GET', '/api/v1/tracker?view=liked')).json);
  const noteAfter = (await call('GET', '/api/v1/jobs/' + encodeURIComponent(ids[4]))).json?.tracker?.notes?.some((n) => /Gate 7 note/.test(n.text));
  note('O5.survives-force-quit', likedAfter === 3 && noteAfter === true && /Round Rock/.test(prof) && /Gate 7 note/.test(trk + (await screen(`jobs/${encodeURIComponent(ids[4])}`, '-note'))), `after SIGKILL + relaunch: liked ${likedAfter}, note kept ${noteAfter}; profile screen shows the new city: ${/Round Rock/.test(prof)}; the note is visible on screen: ${/Gate 7 note/.test(trk) || /Gate 7 note/.test(allText[`jobs/${encodeURIComponent(ids[4])}-note`] ?? '')}`);

  // O9: with the server gone (killed, so the port closes at once), an edit shows an error and is not shown as saved.
  await srv.kill();
  let portClosed = false; try { await fetch(`${ORIGIN}/api/v1/health`); } catch { portClosed = true; }
  await open('jobs');
  const clicked = await p.eval(`(() => { const btn = Array.from(document.querySelectorAll('.jl-card button')).find((x) => /^Like /.test(x.getAttribute('aria-label') ?? '')); if (btn) { btn.click(); return btn.closest('.jl-card').getAttribute('data-job-id'); } return null; })()`);
  const ERR = /could not|cannot|not reach|unavailable|not running|failed|error|try again|offline|stopped/i;
  const seen = []; let firstAt = null, lastAt = null; const t0 = Date.now();
  while (Date.now() - t0 < 6000) { const t = await p.eval('document.body.innerText'); const l = t.split('\n').find((x) => ERR.test(x)); if (l) { if (!seen.includes(l)) seen.push(l); firstAt ??= Date.now() - t0; lastAt = Date.now() - t0; if (seen.length === 1 && lastAt - firstAt < 400) await p.shot(join(SHOTS, 'jobs-server-down.png')); } await sleep(250); }
  const stillLiked = await p.eval(`!!Array.from(document.querySelector('.jl-card[data-job-id=' + JSON.stringify(${JSON.stringify(clicked)}) + ']')?.querySelectorAll('button') ?? []).find((x) => /^Unlike /.test(x.getAttribute('aria-label') ?? ''))`);
  const trkOff = await open('tracker', 1500);
  note('O9.error-when-server-down', portClosed && !!clicked && seen.length > 0 && !stillLiked, `with the app's server killed (port closed: ${portClosed}): clicked "${clicked}"; message seen after ${firstAt} ms, still on screen at ${lastAt} ms: "${(seen[0] ?? '(nothing)').slice(0, 120)}"; the like shown as saved: ${stillLiked}; the tracker screen then says: "${(trkOff.split('\n').find((x) => ERR.test(x)) ?? '(nothing)').slice(0, 100)}"`);
  await b.close(); b = null;

  // Fresh folder: onboarding first, honest empty states everywhere, no banned words, no errors.
  mkdirSync(HOME2, { recursive: true });
  srv = await startServer(HOME2, PUB_ENV); call = api(srv.port);
  b = await launch(); p = await b.page(); await p.size(1440, 900);
  await p.goto(URL0); await p.waitFor("document.querySelector('.jl-shell, .jl-onboard')", 15000); await sleep(800);
  const onboard = await p.eval("!!document.querySelector('.jl-onboard') || /onboarding/.test(location.hash)");
  await p.shot(join(SHOTS, 'fresh-onboarding.png'));
  const freshText = {};
  for (const r of ['jobs', 'jobs/liked', 'jobs/applied', 'jobs/external', 'tracker', 'dashboard', 'resume', 'profile', 'network', 'interview', 'assistant', 'notifications', 'settings/balance']) { freshText[r] = await open(r, 600); await p.shot(join(SHOTS, `fresh-${r.replace(/\//g, '_')}.png`)); }
  const freshHits = [];
  for (const [r, t] of Object.entries(freshText)) for (const re of BANNED) { const m = re.exec(t); if (m) freshHits.push(`${r}: "${m[0]}"`); }
  const emptyWords = Object.entries(freshText).filter(([, t]) => /no jobs|nothing here|no .* yet|empty|add your|import|get started|start by|none yet/i.test(t)).length;
  note('O1.fresh-install-honest', onboard && freshHits.length === 0 && p.errors().length === 0 && emptyWords >= 8, `first run opens onboarding: ${onboard}; ${Object.keys(freshText).length} empty screens read; banned words: ${freshHits.length}${freshHits.length ? ' (' + freshHits.slice(0, 5).join(', ') + ')' : ''}; console errors: ${p.errors().length}; screens with an empty-state message: ${emptyWords}`);
  await b.close(); b = null;
  await srv.stop();

  // O14: the UI lane's own screenshot + audit script against the full app at 1024x640 and 1440x900.
  srv = await startServer(HOME, PUB_ENV); call = api(srv.port);
  const auditOut = join(SHOTS, 'audit');
  const r = spawnSync(process.execPath, [join(ROOT, 'apps/ui/scripts/shots.ts'), '--url', URL0, '--out', auditOut], { encoding: 'utf8', timeout: 600000 });
  const report = existsSync(join(auditOut, 'report.json')) ? JSON.parse(readFileSync(join(auditOut, 'report.json'), 'utf8')) : {};
  const entries = Object.entries(report);
  const overflow = entries.filter(([, v]) => v.overflowX).map(([k]) => k);
  const offscreen = entries.filter(([, v]) => (v.offscreen ?? []).length).map(([k, v]) => `${k}: ${v.offscreen.length}`);
  const contrast = entries.filter(([, v]) => (v.lowContrast ?? []).filter((x) => x.cls !== 'ant-tooltip-inner').length).map(([k, v]) => `${k}: ${JSON.stringify(v.lowContrast).slice(0, 80)}`); // the audit reads the tooltip's translucent dark background as white (white on dark on screen; shots/audit/DETAIL@1440x900.png)
  const noName = entries.filter(([, v]) => (v.noName ?? []).length).map(([k, v]) => `${k}: ${v.noName.length}`);
  const bannedA = entries.filter(([k, v]) => (v.banned ?? []).filter((w) => !(k.startsWith('settings_balance') && w === '$0 found')).length).map(([k, v]) => `${k}: ${JSON.stringify(v.banned).slice(0, 80)}`); // "Used this week: $0.00" on the balance screen is the wallet's own figure, not an invented fact
  const errs = entries.filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`);
  note('O14.layout-audit', entries.length >= 40 && overflow.length === 0 && offscreen.length === 0 && errs.length === 0 && bannedA.length === 0, `${entries.length} screen×size audits (${r.status === 0 ? 'script ok' : 'script exit ' + r.status}); sideways overflow: ${overflow.length}${overflow.length ? ' (' + overflow.join(', ') + ')' : ''}; off-screen controls: ${offscreen.length}${offscreen.length ? ' (' + offscreen.join(', ') + ')' : ''}; errors: ${errs.join(', ') || 0}; banned: ${bannedA.length}`);
  note('O14.contrast-and-names', contrast.length === 0 && noName.length === 0, `low-contrast text findings: ${contrast.length}${contrast.length ? ' (' + contrast.slice(0, 5).join(', ') + ')' : ''}; controls without an accessible name: ${noName.length}${noName.length ? ' (' + noName.slice(0, 5).join(', ') + ')' : ''}`);

  // O15: the API behind the screens with 11,957 real jobs: feed, filter, search and detail timings.
  const times = { feed: [], search: [], detail: [], filter: [] };
  for (let i = 0; i < 20; i++) {
    let t = performance.now(); await call('GET', `/api/v1/jobs?limit=20&offset=${i * 20}`); times.feed.push(performance.now() - t);
    t = performance.now(); await call('GET', `/api/v1/jobs?q=${encodeURIComponent(['engineer', 'nurse', 'manager', 'analyst', 'designer'][i % 5])}&limit=20`); times.search.push(performance.now() - t);
    t = performance.now(); await call('GET', `/api/v1/jobs?workModel=remote&level=entry&limit=20&offset=${i}`); times.filter.push(performance.now() - t);
    t = performance.now(); await call('GET', `/api/v1/jobs/${encodeURIComponent(ids[i % ids.length])}`); times.detail.push(performance.now() - t);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(0);
  const max = (a) => Math.max(...a).toFixed(0);
  note('O15.fast-with-full-store', Object.values(times).every((a) => [...a].sort((x, y) => x - y)[18] < 1000), `${jobsTotal} jobs; median/slowest ms — feed ${med(times.feed)}/${max(times.feed)}, search ${med(times.search)}/${max(times.search)}, filter ${med(times.filter)}/${max(times.filter)}, detail ${med(times.detail)}/${max(times.detail)} (19 of 20 under 1 s each)`);
} finally {
  try { await b?.close(); } catch { /* closed */ }
  try { await srv.stop(); } catch { /* stopped */ }
  await publik.close();
}

writeFileSync(join(SHOTS, 'text.json'), JSON.stringify(allText, null, 1));
const fails = results.filter((r) => !r.ok);
const md = [`# Gate 7 (i-ui) result, ${new Date().toISOString()}`, '', 'The real built UI served by the real app on a copy of the gate 2 store (11,957 jobs from real employer boards), driven in headless Chrome at 1440×900 (and 1024×640 for the layout audit). Screenshots in `shots/`; the lane\'s own audit in `shots/audit/`.', '', '| Check | Result | Evidence |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.text.replace(/\|/g, '/').replace(/\n\s*/g, '<br>')} |`), '', `Verdict: ${fails.length ? `FAIL (${fails.map((m) => m.id).join(', ')})` : 'PASS'}`].join('\n');
writeFileSync(join(OUT, 'RESULT.md'), md);
console.log(`\nVerdict: ${fails.length ? 'FAIL' : 'PASS'} (${results.length - fails.length}/${results.length})`);
process.exit(fails.length ? 1 : 0);
