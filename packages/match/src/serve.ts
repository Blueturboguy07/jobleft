// A local preview of the match engine for people and testers: the documented endpoint GET /api/v1/match/:jobId,
// a "Top Matched" feed with band filters, a job detail, and "I have this" / "I don't have this" on a job's skills.
// It reads a profile file and a folder of postings, and re-reads them when they change, so no view is ever stale.
// Security (same rules as the app server): 127.0.0.1 only; Host and Origin checks; a random token in a header for
// every API call (never in a URL query); JSON bodies only, at most 64 KiB; no CORS; logs hold no profile text.
// It makes no outbound request.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Company, Job, Profile } from '@jobleft/contracts';
import { nowMs } from '@jobleft/contracts';
import {
  bandCounts, bucketOf, cardText, detailText, rankTopMatched, scoreMatch, setSkillClaim, summarize, undoSkillClaim,
  ENGINE_VERSION, type FullMatchResult, type MatchConfigInput, type SkillClaimChange,
} from './index.ts';
import { readCompanies, readJobs, readProfile } from './io.ts';

export interface PreviewOptions {
  profilePath: string;
  jobPaths: string[];
  companiesPath?: string;
  port?: number;
  now?: number;
  config?: MatchConfigInput | null;
  /** Default: stderr. Lines hold the method, the path, the status and the time only. */
  log?: (line: string) => void;
}

export interface PreviewServer { origin: string; port: number; token: string; close(): Promise<void> }

const BODY_LIMIT = 64 * 1024;

function stamp(paths: string[]): string {
  const parts: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) { parts.push(`${p}:missing`); continue; }
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.startsWith('.')) continue;
        const fp = join(p, f);
        const s = statSync(fp);
        if (s.isFile()) parts.push(`${fp}:${s.size}:${s.mtimeMs}`);
      }
    } else parts.push(`${p}:${st.size}:${st.mtimeMs}`);
  }
  return parts.join('|');
}

export async function startPreview(opts: PreviewOptions): Promise<PreviewServer> {
  const token = randomBytes(24).toString('base64url');
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  let profileStamp = '';
  let profile: Profile | null = null;
  let jobsStamp = '';
  let jobs: Job[] = [];
  let companyOf: (j: Job) => Company | null = () => null;
  let companiesStamp = '';
  const cache = new Map<string, FullMatchResult>();

  const fresh = () => {
    const ps = stamp([opts.profilePath]);
    if (ps !== profileStamp) { profile = readProfile(opts.profilePath); profileStamp = ps; }
    const js = stamp(opts.jobPaths);
    if (js !== jobsStamp) { jobs = readJobs(opts.jobPaths); jobsStamp = js; }
    const cs = opts.companiesPath ? stamp([opts.companiesPath]) : '';
    if (cs !== companiesStamp) { companyOf = readCompanies(opts.companiesPath); companiesStamp = cs; cache.clear(); }
  };
  const matchOf = (job: Job): FullMatchResult => {
    const now = opts.now ?? nowMs();
    const month = new Date(now).toISOString().slice(0, 7);
    const key = `${profile!.version}|${job.id}|${job.contentHash}|${month}|${ENGINE_VERSION}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const r = scoreMatch({ profile: profile!, job, company: companyOf(job), now, config: opts.config ?? null });
    if (cache.size > 5000) cache.clear();
    cache.set(key, r);
    return r;
  };

  const undoPath = opts.profilePath.replace(/\.json$/i, '') + '.undo.json';
  const writeJson = (path: string, data: unknown) => {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  };

  let port = 0;
  const server = createServer((req, res) => {
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0];
    res.on('finish', () => log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`));
    handle(req, res).catch(() => sendError(res, 500, 'internal', 'Something went wrong in the preview.'));
  });

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  };
  const sendError = (res: ServerResponse, status: number, code: string, message: string) => {
    if (res.headersSent) { res.end(); return; }
    sendJson(res, status, { error: { code, message } });
  };
  const tokenOk = (req: IncomingMessage) => {
    const got = req.headers['x-jobleft-token'];
    if (typeof got !== 'string') return false;
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const readBody = (req: IncomingMessage) => new Promise<unknown>((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > BODY_LIMIT) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendError(res, 403, 'forbidden_host', 'This preview answers only on 127.0.0.1.');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return sendError(res, 403, 'forbidden_origin', 'Requests from other web pages are refused.');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p.startsWith('/job/'))) {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(PAGE.replaceAll('%NONCE%', nonce));
      return;
    }
    if (!p.startsWith('/api/') && !p.startsWith('/preview/api/')) return sendError(res, 404, 'not_found', 'No such page.');
    if (url.searchParams.has('token')) return sendError(res, 401, 'unauthorized', 'A token in a URL is refused; send it in the x-jobleft-token header.');
    if (!tokenOk(req)) return sendError(res, 401, 'unauthorized', 'Missing or wrong x-jobleft-token header.');
    if (req.method === 'POST') {
      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return sendError(res, 415, 'unsupported_media_type', 'Send JSON.');
    }
    try { fresh(); } catch (e) { return sendError(res, 409, 'needs_profile', `The profile or a posting could not be read: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`); }

    let m: RegExpExecArray | null;
    if (req.method === 'GET' && (m = /^\/api\/v1\/match\/(.+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      const job = jobs.find((j) => j.id === id);
      if (!job) return sendError(res, 404, 'not_found', 'No job with that id.');
      return sendJson(res, 200, matchOf(job));
    }
    if (req.method === 'GET' && p === '/preview/api/feed') {
      const all = rankTopMatched(jobs.map((job) => ({ job, match: matchOf(job) as FullMatchResult })));
      const band = url.searchParams.get('band');
      const shown = all.filter((x) => !band || bucketOf(x.match) === band);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 500);
      return sendJson(res, 200, {
        profileVersion: profile!.version, engineVersion: ENGINE_VERSION, counts: bandCounts(all.map((x) => x.match)), total: all.length,
        items: shown.slice(0, limit).map((x, i) => ({
          rank: i + 1, jobId: x.job.id, title: x.job.title, company: x.job.company, where: x.job.places.map((pl) => pl.text).slice(0, 2).join('; '),
          workModel: x.match.jobFacts.workModel.value, percent: x.match.percent, band: x.match.band, bucket: bucketOf(x.match), complete: x.match.complete,
          summary: summarize(x.match), card: cardText(x.match, x.job),
        })),
      });
    }
    if (req.method === 'GET' && (m = /^\/preview\/api\/jobs\/(.+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      const job = jobs.find((j) => j.id === id);
      if (!job) return sendError(res, 404, 'not_found', 'No job with that id.');
      const r = matchOf(job);
      return sendJson(res, 200, {
        job: { id: job.id, title: job.title, company: job.company, places: job.places, description: job.description, url: job.url },
        match: r, summary: summarize(r), card: cardText(r, job), detail: detailText(r, job),
        profileSkills: profile!.skills.map((s) => s.name), declinedSkills: (profile as Profile & { declinedSkills?: string[] }).declinedSkills ?? [],
      });
    }
    if (req.method === 'POST' && p === '/preview/api/skills') {
      let body: { skill?: unknown; have?: unknown };
      try { body = await readBody(req) as typeof body; } catch (e) { return sendError(res, (e as Error).message === 'too_large' ? 413 : 400, (e as Error).message === 'too_large' ? 'payload_too_large' : 'bad_request', 'The body must be JSON, at most 64 KiB.'); }
      if (typeof body.skill !== 'string' || !body.skill.trim() || body.skill.length > 100 || typeof body.have !== 'boolean') return sendError(res, 400, 'bad_request', 'Send {"skill": "<name>", "have": true|false}.');
      const raw = JSON.parse(readFileSync(opts.profilePath, 'utf8'));
      const base = raw.profile ?? raw;
      base.skills = (base.skills ?? []).map((s: unknown) => (typeof s === 'string' ? { name: s, years: null, source: 'user' } : s));
      const { profile: next, change, notice } = setSkillClaim(base, body.skill, body.have);
      const history: SkillClaimChange[] = existsSync(undoPath) ? JSON.parse(readFileSync(undoPath, 'utf8')) : [];
      history.push(change);
      writeJson(opts.profilePath, raw.profile ? { ...raw, profile: next } : next);
      writeJson(undoPath, history);
      fresh();
      return sendJson(res, 200, { notice, profileVersion: profile!.version, undo: history.length });
    }
    if (req.method === 'POST' && p === '/preview/api/skills/undo') {
      try { await readBody(req); } catch { return sendError(res, 400, 'bad_request', 'The body must be JSON.'); }
      const history: SkillClaimChange[] = existsSync(undoPath) ? JSON.parse(readFileSync(undoPath, 'utf8')) : [];
      const last = history.pop();
      if (!last) return sendError(res, 409, 'conflict', 'Nothing to undo.');
      const raw = JSON.parse(readFileSync(opts.profilePath, 'utf8'));
      const next = undoSkillClaim(raw.profile ?? raw, last);
      writeJson(opts.profilePath, raw.profile ? { ...raw, profile: next } : next);
      writeJson(undoPath, history);
      fresh();
      return sendJson(res, 200, { notice: `Undone: ${last.skill} is back as it was in your profile.`, profileVersion: profile!.version, undo: history.length });
    }
    return sendError(res, 404, 'not_found', 'No such route.');
  }

  const wanted = opts.port ?? 0;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(wanted, '127.0.0.1', () => resolveListen());
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : wanted;
  // Load once at start so a broken file is reported now.
  fresh();
  return {
    origin: `http://127.0.0.1:${port}`, port, token,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}


// The page: text only (job text is never rendered as markup), no external assets.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>jobleft match preview</title>
<style nonce="%NONCE%">
:root{--bg:#f5f6f7;--card:#fff;--ink:#16181b;--mute:#5b636e;--line:#e3e6ea;--strong:#1f6b4f;--good:#1d5a86;--fair:#6b5b1d;--warn:#9a2b1d;--accent:#0a8f63}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--card:#1b1e21;--ink:#eceef0;--mute:#a1a9b3;--line:#2b3035;--strong:#5fd3a4;--good:#77b7ea;--fair:#d8c26a;--warn:#ff8f7d;--accent:#3ed39a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);background:var(--card);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header h1{font-size:18px;margin:0}header .meta{color:var(--mute);font-size:13px}
main{max-width:980px;margin:0 auto;padding:16px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 16px}.filters button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:16px;padding:6px 12px;cursor:pointer}
.filters button[aria-pressed=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:10px;display:grid;grid-template-columns:110px 1fr;gap:14px}
.tile{border-radius:10px;padding:10px;text-align:center;color:#fff;background:#222}.tile.strong{background:linear-gradient(#111,#284e41)}.tile.good{background:linear-gradient(#111,#1d465c)}.tile.fair{background:linear-gradient(#111,#4d4428)}
.tile .pct{font-size:28px;font-weight:650}.tile .band{font-size:11px;font-weight:650;letter-spacing:.04em}.tile .inc{font-size:10px;margin-top:4px;opacity:.9}
.title{font-size:17px;font-weight:620;margin:0 0 2px}.title a{color:inherit;text-decoration:none}.title a:hover{text-decoration:underline}
.sub{color:var(--mute);font-size:13px}.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.chip{font-size:12px;border-radius:8px;padding:3px 8px;background:color-mix(in srgb,var(--accent) 12%,transparent)}
.chip.neg{background:color-mix(in srgb,var(--warn) 14%,transparent)}.warn{color:var(--warn);font-size:13px;margin-top:8px}
.updating{opacity:.55}.badge{display:inline-block;font-size:11px;padding:2px 6px;border-radius:6px;border:1px solid var(--line);color:var(--mute);margin-left:6px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:12px}section h2{font-size:15px;margin:0 0 8px}
.parts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.part{border:1px solid var(--line);border-radius:10px;padding:8px}.part b{font-size:20px}
ul{margin:4px 0;padding-left:18px}li{margin:3px 0}.q{color:var(--mute)}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-top:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
button.small{font-size:12px;padding:3px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.notice{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:10px;padding:8px 12px;margin-bottom:12px}
@media (max-width:640px){.card{grid-template-columns:1fr}.parts{grid-template-columns:1fr}}
</style></head><body>
<header><h1>jobleft · match preview</h1><span class="meta" id="meta"></span></header>
<main id="app"><p>Loading…</p></main>
<script nonce="%NONCE%">
(function(){
  var frag = new URLSearchParams(location.hash.slice(1));
  var token = frag.get('token') || sessionStorage.getItem('jobleft-preview-token') || '';
  if (frag.get('token')) { sessionStorage.setItem('jobleft-preview-token', token); history.replaceState(null, '', location.pathname); }
  var app = document.getElementById('app');
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function api(path, body){
    var init = { headers: { 'x-jobleft-token': token } };
    if (body) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j.error ? j.error.message : r.status); return j; }); });
  }
  var BANDS = { strong: 'STRONG MATCH', good: 'GOOD MATCH', fair: 'FAIR MATCH' };
  function tile(m){ var t = el('div', 'tile ' + m.band); t.appendChild(el('div','pct', m.percent + '%')); t.appendChild(el('div','band', BANDS[m.band])); if (m.complete === false) t.appendChild(el('div','inc','INCOMPLETE')); return t; }
  function chips(list){ var c = el('div','chips'); (list || []).forEach(function(x){ c.appendChild(el('span', 'chip' + (x.positive ? '' : ' neg'), (x.positive ? '✓ ' : '● ') + x.label)); }); return c; }
  function feed(band){
    var list = document.querySelector('.list'); if (list) list.classList.add('updating');
    api('/preview/api/feed' + (band ? '?band=' + band : '')).then(function(d){
      app.textContent = '';
      document.getElementById('meta').textContent = 'profile ' + d.profileVersion + ' · engine ' + d.engineVersion;
      var f = el('div','filters');
      [['', 'All', d.counts.total], ['strong','Strong', d.counts.strong], ['good','Good', d.counts.good], ['fair','Fair', d.counts.fair], ['incomplete','Incomplete', d.counts.incomplete]].forEach(function(b){
        var btn = el('button', '', b[1] + ' ' + b[2]); btn.setAttribute('aria-pressed', String((band || '') === b[0])); btn.onclick = function(){ feed(b[0]); }; f.appendChild(btn);
      });
      app.appendChild(el('p','sub','Top Matched: highest percent first; equal percents keep one fixed order.'));
      app.appendChild(f);
      var l = el('div','list'); app.appendChild(l);
      d.items.forEach(function(it){
        var c = el('div','card'); c.appendChild(tile(it));
        var body = el('div'); var h = el('p','title'); var a = el('a', '', it.title); a.href = '/job/' + encodeURIComponent(it.jobId); h.appendChild(a); body.appendChild(h);
        body.appendChild(el('div','sub', it.company + (it.where ? ' · ' + it.where : '') + (it.workModel ? ' · ' + it.workModel : '')));
        body.appendChild(chips(it.summary.whyFit));
        if (it.summary.warning) body.appendChild(el('div','warn', '! ' + it.summary.warning + (it.summary.blockerCount > 1 ? ' (+' + (it.summary.blockerCount - 1) + ' more)' : '')));
        c.appendChild(body); l.appendChild(c);
      });
    }).catch(function(e){ app.textContent = 'Could not load: ' + e.message; });
  }
  function detail(id, notice){
    api('/preview/api/jobs/' + encodeURIComponent(id)).then(function(d){
      var m = d.match; app.textContent = '';
      var back = el('a', '', '← Top Matched'); back.href = '/'; app.appendChild(back);
      if (notice) app.appendChild(el('div','notice', notice));
      var head = el('section'); var top = el('div','card'); top.appendChild(tile(m));
      var hb = el('div'); hb.appendChild(el('p','title', d.job.title)); hb.appendChild(el('div','sub', d.job.company + ' · ' + d.job.places.map(function(p){return p.text;}).join('; ')));
      hb.appendChild(chips(m.whyFit)); top.appendChild(hb); head.appendChild(top);
      var parts = el('div','parts'); [['Experience Level', m.subScores.experienceLevel], ['Skills', m.subScores.skills], ['Industry Experience', m.subScores.industryExperience]].forEach(function(p){
        var x = el('div','part'); x.appendChild(el('div','sub', p[0])); x.appendChild(el('b','', p[1].percent === null ? 'not enough information' : p[1].percent + '%')); parts.appendChild(x);
      }); head.appendChild(parts);
      var ul = el('ul'); m.reasons.forEach(function(r){ ul.appendChild(el('li','', r.text)); }); head.appendChild(ul);
      app.appendChild(head);
      if (m.blockers.length){ var w = el('section'); w.appendChild(el('h2','', 'Warnings')); var wl = el('ul'); m.blockers.forEach(function(b){ wl.appendChild(el('li','warn', b.message)); }); w.appendChild(wl); app.appendChild(w); }
      [['Experience Level', m.subScores.experienceLevel], ['Skills', m.subScores.skills], ['Industry Experience', m.subScores.industryExperience]].forEach(function(p){
        var s = el('section'); s.appendChild(el('h2','', p[0] + ': ' + (p[1].percent === null ? 'not enough information' : p[1].percent + '%')));
        var l = el('ul'); p[1].reasons.forEach(function(r){ l.appendChild(el('li','', r.text)); }); s.appendChild(l);
        if (p[0] === 'Skills' && m.skillDetail.length){
          s.appendChild(el('p','sub','Marking a skill changes your profile: every job that names it updates, and you can undo.'));
          var t = el('table'); var tr = el('tr'); ['Skill','Posting says','In your profile',''].forEach(function(h){ tr.appendChild(el('th','',h)); }); t.appendChild(tr);
          m.skillDetail.forEach(function(c){
            var row = el('tr'); row.appendChild(el('td','', c.name + ' (' + c.importance + ')')); row.appendChild(el('td','q', '"' + c.quote + '"'));
            row.appendChild(el('td','', c.state === 'met' ? '✓ from ' + c.heldFrom : c.state === 'related' ? 'no (related: ' + c.via + ', half credit)' : c.state === 'implied' ? 'not listed (your role ' + c.via + ' suggests it)' : 'no'));
            var act = el('td'); var have = el('button','small', c.state === 'met' ? "I don't have this" : 'I have this');
            have.onclick = function(){ api('/preview/api/skills', { skill: c.name, have: c.state !== 'met' }).then(function(r){ detail(id, r.notice); }).catch(function(e){ alert(e.message); }); };
            act.appendChild(have); row.appendChild(act); t.appendChild(row);
          });
          s.appendChild(t);
          var undo = el('button','small','Undo my last skill change'); undo.onclick = function(){ api('/preview/api/skills/undo', {}).then(function(r){ detail(id, r.notice); }).catch(function(e){ alert(e.message); }); };
          s.appendChild(undo);
        }
        app.appendChild(s);
      });
      if (m.mustHaves.length){ var mh = el('section'); mh.appendChild(el('h2','', 'Must-haves the posting states')); var ml = el('ul'); m.mustHaves.forEach(function(x){ ml.appendChild(el('li', x.state === 'unmet' ? 'warn' : '', '[' + x.state.replace(/_/g,' ') + '] ' + x.message)); }); mh.appendChild(ml); app.appendChild(mh); }
      if (m.dealBreakers.length){ var db = el('section'); db.appendChild(el('h2','', 'Your firm preferences')); var dl = el('ul'); m.dealBreakers.forEach(function(x){ dl.appendChild(el('li', x.state === 'broken' ? 'warn' : '', '[' + x.state.replace(/_/g,' ') + '] ' + x.message)); }); db.appendChild(dl); app.appendChild(db); }
      var fs = el('section'); fs.appendChild(el('h2','', 'What the posting states')); var fl = el('ul');
      var names = { level:'Level', years:'Years of experience', pay:'Pay', sponsorship:'Visa sponsorship', industry:'Industry', workModel:'Work model', employmentType:'Job type' };
      Object.keys(m.jobFacts).forEach(function(k){ var f = m.jobFacts[k]; fl.appendChild(el('li','', names[k] + ': ' + f.text + (f.quote && f.quote !== f.text ? ' — "' + f.quote + '"' : ''))); }); fs.appendChild(fl); app.appendChild(fs);
      var ex = el('section'); ex.appendChild(el('h2','', 'Years of experience used: ' + m.experience.text)); var el2 = el('ul');
      m.experience.rolesCounted.forEach(function(r){ el2.appendChild(el('li','', 'counted: ' + r.title + ' at ' + r.company + ', ' + r.from + ' to ' + r.to + ' (' + r.months + ' months)')); });
      m.experience.rolesNotCounted.forEach(function(r){ el2.appendChild(el('li','', 'not counted: ' + r.title + ' at ' + r.company + ' (' + r.why + ')')); });
      ex.appendChild(el2); ex.appendChild(el('p','sub','Overlapping months count once; a current role counts up to this month. Change the dates in your profile to correct them.')); app.appendChild(ex);
      var post = el('section'); post.appendChild(el('h2','', 'The posting')); var pre = el('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = d.job.description; post.appendChild(pre); app.appendChild(post);
      app.appendChild(el('p','sub', 'engine ' + m.engineVersion + ' · profile ' + m.profileVersion + ' · job ' + m.jobId));
    }).catch(function(e){ app.textContent = 'Could not load: ' + e.message; });
  }
  if (!token) { app.textContent = 'Open this page with the address the preview printed (it holds the token after #).'; return; }
  var m = /^\\/job\\/(.+)$/.exec(location.pathname);
  if (m) detail(decodeURIComponent(m[1])); else feed('');
})();
</script></body></html>`;
