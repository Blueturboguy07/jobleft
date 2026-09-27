// Replay scenario for the jobleft Chrome extension (pairing + filling practice forms).
// Plain Node 24 ES module, no packages. Follows scenarios/README.md. Runs on Windows and macOS.
//
// Env: JOBLEFT_QA_URL, JOBLEFT_QA_API, JOBLEFT_QA_TOKEN, JOBLEFT_QA_FIXTURES, JOBLEFT_QA_SHOTS,
//      JOBLEFT_QA_STATE (fresh|golden), JOBLEFT_CHROME, JOBLEFT_QA_EXTENSION (built extension folder).
//
// The extension can only reach an app on ports 47821-47830 (its manifest). If JOBLEFT_QA_API is on
// another port, every extension check is skipped with a reason (this is a real product limit, not a
// scenario bug). Point JOBLEFT_QA_API at a port in that range to exercise the extension.
//
// The practice pages log submit/Next to /__event, which bin/practice-server.mjs does NOT record, so we
// inject our own recorder in every tab that POSTs submit/form.submit()/requestSubmit()/Next clicks to
// /__log. That makes the /__log counts real here.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ---- config from env
const API = (process.env.JOBLEFT_QA_API || 'http://127.0.0.1:47829/api/v1').replace(/\/$/, '');
const TOKEN = process.env.JOBLEFT_QA_TOKEN || '';
const SHOTS = process.env.JOBLEFT_QA_SHOTS || join(REPO, 'shots', 'extension');
const EXT = process.env.JOBLEFT_QA_EXTENSION || join(REPO, 'extension');
const PRACTICE = 'http://127.0.0.1:47900/practice/';
const APP_PORT = Number((API.match(/:(\d+)\//) || [])[1] || 0);
const EXT_PORT_OK = APP_PORT >= 47821 && APP_PORT <= 47830;

// Windows-safe Chrome default for ext-driver (its built-in default is Mac-only).
if (!process.env.JOBLEFT_CHROME && process.platform === 'win32') {
  process.env.JOBLEFT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

const { Browser } = await import(new URL('../bin/ext-driver.mjs', import.meta.url));
// Fail fast on any stuck CDP call so the scenario never hangs (and to point at the stuck method).
const _send = Browser.prototype.send;
Browser.prototype.send = function (method, params = {}, sessionId) {
  return Promise.race([
    _send.call(this, method, params, sessionId),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CDP timeout: ' + method)), 20000)),
  ]);
};

let failed = 0, ran = 0;
const ok = (n) => { ran++; console.log(`CHECK ok ${n}`); };
const fail = (n, why) => { ran++; failed++; console.log(`CHECK FAIL ${n}: ${why}`); };
const skip = (n, why) => { console.log(`CHECK skip ${n}: ${why}`); };
const assert = (n, cond, why) => cond ? ok(n) : fail(n, why || 'assertion failed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return null;
}
async function apiGet(path) {
  const r = await fetch(API + path, { headers: { 'x-jobleft-token': TOKEN } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function apiPost(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'x-jobleft-token': TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Recorder injected into every tab: mirrors submit / form.submit / requestSubmit / Next presses to /__log.
const RECORDER = `(() => { if (window.__qaRec) return; window.__qaRec = [];
  const rec = (t, d) => { window.__qaRec.push({t, d}); try { fetch('/__log', {method:'POST', body: JSON.stringify({type:t, page: location.pathname, detail:d}), keepalive:true}); } catch(e){} };
  document.addEventListener('submit', e => rec('submit', (e.target.id||'?') + (e.isTrusted?' trusted':' script')), true);
  document.addEventListener('click', e => { const b = e.target && e.target.closest ? e.target.closest('[data-next],button,a,input[type=submit],[role=button]') : null; if (!b) return; const x=(b.textContent||b.value||'').trim(); if (b.matches('[data-next]') || /next|continue|submit|apply|create account|send|subscribe/i.test(x)) rec('next', x.slice(0,40)); }, true);
  const S = HTMLFormElement.prototype.submit; HTMLFormElement.prototype.submit = function(){ rec('submit','submit()'); };
  const R = HTMLFormElement.prototype.requestSubmit; HTMLFormElement.prototype.requestSubmit = function(){ rec('submit','requestSubmit()'); };
})();`;

// ---- practice server (start if 47900 is not answering)
async function practiceUp() { try { const r = await fetch('http://127.0.0.1:47900/__log'); return r.ok; } catch { return false; } }
let practiceProc = null;
async function ensurePractice() {
  if (await practiceUp()) return true;
  practiceProc = spawn(process.execPath, [join(REPO, 'bin', 'practice-server.mjs')], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await practiceUp()) return true; await sleep(200); }
  return false;
}
async function resetLog() { try { await fetch('http://127.0.0.1:47900/__reset', { method: 'POST' }); } catch {} }
async function practiceLog() { try { return await (await fetch('http://127.0.0.1:47900/__log')).json(); } catch { return { submit: -1, next: -1 }; } }

// ---- browser / extension helpers
async function tabTarget(b, urlPart) {
  const tabs = (await b.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
  return tabs.find((t) => t.url.includes(urlPart));
}
async function openPage(b, url) {
  const r = await b.send('Target.createTarget', { url: 'about:blank' });
  const p = await b.attach(r.targetId);
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await p.goto(url);
  return p;
}
async function attachSW(b, id) {
  const t = await until(async () => (await b.targets()).find((x) => x.type === 'service_worker' && x.url.includes(id)), 8000);
  const s = await b.attach(t.targetId);
  await s.send('Network.enable').catch(() => {});
  const net = [];
  b.on((m) => { if (m.sessionId === s.sessionId && m.method === 'Network.requestWillBeSent') net.push({ url: m.params.request.url, method: m.params.request.method }); });
  return { sw: s, net };
}
async function openPopup(b, id, urlPart, page) {
  for (const t of await b.targets()) if (t.url.includes(id + '/popup.html')) await b.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  if (page) await page.send('Page.bringToFront').catch(() => {});
  const tab = await until(() => tabTarget(b, urlPart), 6000);
  if (!tab) throw new Error('no tab for ' + urlPart);
  await b.send('Extensions.triggerAction', { id, targetId: tab.targetId }).catch(() => {});
  const t = await until(async () => (await b.targets()).find((x) => x.url.includes(id + '/popup.html')), 8000);
  const pop = await b.attach(t.targetId);
  await until(async () => !/Checking/.test(await pop.eval('document.body.innerText').catch(() => 'Checking')), 15000);
  return pop;
}
async function pair(b, id, urlPart, page) {
  const pop = await openPopup(b, id, urlPart, page);
  const code = (await apiPost('/extension/pairing-code')).body?.code;
  if (!code) throw new Error('no pairing code from API');
  await pop.eval(`document.querySelector('input').focus()`);
  await pop.send('Input.insertText', { text: code });
  await pop.clickDeep('button', 'Pair');
  const okp = await until(async () => /Paired with/.test(await pop.eval('document.body.innerText')), 10000);
  return !!okp;
}
async function fillPage(b, id, p, { resume } = {}) {
  const pop = await openPopup(b, id, await urlOf(b, p), p);
  const pre = await pop.eval('document.body.innerText');
  if (resume) await pop.eval(`(() => { const s=document.querySelector('select'); if(!s) return; const o=[...s.options].find(o=>o.text.includes(${JSON.stringify(resume)})); if(o){s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true}));} })()`);
  const clicked = await pop.clickDeep('button', 'Fill this application');
  if (!clicked) return { clicked: false, pre };
  await until(async () => { const t = await pop.eval('document.body.innerText').catch(() => ''); return /Filled|filled|could not|left empty|nothing|Done\./i.test(t) && !/Filling…/.test(t); }, 20000);
  await sleep(1200);
  return { clicked: true, pre };
}
async function urlOf(b, p) { const ti = (await b.targets()).find((t) => t.targetId === p.targetId); return ti ? ti.url : ''; }
async function fieldMap(p) {
  return p.eval(`(() => { const o={}; document.querySelectorAll('input,textarea,select').forEach(e => { let v; if (e.type==='checkbox'||e.type==='radio') v=e.checked; else if (e.type==='file') v=[...e.files].map(f=>f.name).join('|'); else if (e.tagName==='SELECT') v = e.selectedIndex>=0 ? e.options[e.selectedIndex].text : ''; else v=e.value; o[e.id||e.name]=v; }); document.querySelectorAll('[data-combo-value]').forEach(e => { o[e.id]=e.textContent.trim(); }); return o; })()`);
}
async function shot(p, name) { try { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(SHOTS, { recursive: true }); writeFileSync(join(SHOTS, name), await p.screenshot()); } catch {} }

// ---- run
const BANNED = /\b(credits?|undefined|null|NaN)\b|\[object Object\]/;
let b, id, profile;
try {
  if (!(await ensurePractice())) { console.log('CHECK FAIL practice_server: could not start bin/practice-server.mjs on 47900'); process.exit(1); }

  const pr = await apiGet('/profile');
  profile = pr.body;
  assert('api_profile', pr.status === 200 && profile && profile.personal, `GET /profile -> ${pr.status}`);
  const per = profile?.personal || {};
  const wantName = (per.firstName || '') + ' ' + (per.lastName || '');

  if (!EXT_PORT_OK) {
    skip('extension_all', `app port ${APP_PORT || '?'} is outside the extension's range 47821-47830; the extension cannot pair. Point JOBLEFT_QA_API at a port in 47821-47830.`);
    console.log(`\n${failed} failed, ${ran} ran`);
    process.exit(failed ? 1 : 0);
  }

  ({ b, id } = await (async () => {
    const br = await Browser.launch({ headless: true, proxy: '127.0.0.1:9', args: [
      '--host-resolver-rules=MAP www.linkedin.com 127.0.0.1',
      '--proxy-bypass-list=127.0.0.1,localhost,www.linkedin.com',
    ] });
    const { id } = await br.send('Extensions.loadUnpacked', { path: EXT });
    return { b: br, id };
  })());
  const { sw, net } = await attachSW(b, id);

  // pairing
  const seed = await openPage(b, PRACTICE + 'job-a.html');
  const paired = await pair(b, id, 'job-a.html', seed);
  assert('pair', paired, 'popup did not reach the paired state');
  await seed.close().catch(() => {}); // avoid two job-a tabs (ambiguous popup target)
  await sleep(300);

  // storage holds only the pairing (no profile/resumes)
  const store = await sw.eval('chrome.storage.local.get(null)').catch(() => ({}));
  const keys = Object.keys(store || {});
  const onlyPairing = keys.length === 1 && keys[0] === 'pairing' && !JSON.stringify(store).match(/testwell|jordan\.testwell|resume|education|eeo/i);
  assert('storage_minimal', onlyPairing, 'storage has more than the pairing: ' + keys.join(','));

  // resume choice: prefer one whose stored file has a real extension (so it can attach)
  const resumes = (await apiGet('/resumes')).body || [];
  const attachable = resumes.find((r) => /\.(pdf|docx?|txt|rtf)$/i.test(r.file?.fileName || ''));
  const resumeName = attachable ? attachable.name : undefined;

  // ---------- job-a: profile fields + EEO/sensitive untouched + no submit
  {
    await resetLog(); net.length = 0;
    const p = await openPage(b, PRACTICE + 'job-a.html');
    const r = await fillPage(b, id, p, { resume: resumeName });
    assert('job_a_fill_ran', r.clicked, 'no Fill button on a supported form');
    const f = await fieldMap(p);
    assert('job_a_first_name', f.first_name === per.firstName, `first_name=${f.first_name}`);
    assert('job_a_last_name', f.last_name === per.lastName, `last_name=${f.last_name}`);
    assert('job_a_email', f.email === per.email, `email=${f.email}`);
    assert('job_a_phone', (f.phone || '') === (per.phone || ''), `phone=${f.phone}`);
    // EEO / sensitive must be untouched unless the person saved them
    const eeoUntouched = f.gender === 'Please select' && f.hispanic === 'Please select' && f.race === 'Please select' && f.disability === 'Please select';
    assert('job_a_eeo_untouched', eeoUntouched, `gender=${f.gender} race=${f.race} disability=${f.disability}`);
    assert('job_a_dob_empty', (f.q_dob || '') === '', `dob=${f.q_dob}`);
    assert('job_a_ssn_traps_empty', !f.trap_ssn && !f.outside_ssn && !f.trap_phone && !f.trap_address, 'a hidden/SSN trap was filled');
    assert('job_a_salary_empty', (f.q_salary || '') === '', `salary=${f.q_salary}`);
    // a field the profile lacks stays empty (no middle name, no github link)
    assert('job_a_missing_stay_empty', !f.middle_name && !f.github, `middle=${f.middle_name} github=${f.github}`);
    const log = await practiceLog();
    assert('job_a_no_submit', log.submit === 0 && log.next === 0, `log submit=${log.submit} next=${log.next}`);
    // network isolation: every host contacted during the fill is 127.0.0.1
    const hosts = [...new Set(net.map((n) => { try { return new URL(n.url).host; } catch { return ''; } }).filter(Boolean))];
    assert('isolation_127_only', hosts.every((h) => /^127\.0\.0\.1(:|$)/.test(h)), 'contacted ' + hosts.join(','));
    // popup + panel banned words
    const bad = BANNED.test(r.pre);
    assert('no_banned_words', !bad, 'banned word in popup/panel');
    await shot(p, 'scenario-job-a.png');
    await p.close();
  }

  // ---------- workday-like: profile fields, Next never pressed
  {
    await resetLog(); net.length = 0;
    const p = await openPage(b, PRACTICE + 'workday-like.html');
    const r = await fillPage(b, id, p, { resume: resumeName });
    assert('workday_fill_ran', r.clicked, 'no Fill button on workday-like');
    const f = await fieldMap(p);
    assert('workday_given_name', f.fn === per.firstName, `given=${f.fn}`);
    assert('workday_family_name', f.ln === per.lastName, `family=${f.ln}`);
    assert('workday_email', f.em === per.email, `email=${f.em}`);
    assert('workday_city', f.city === per.city, `city=${f.city}`);
    const log = await practiceLog();
    assert('workday_no_next', log.submit === 0 && log.next === 0, `log submit=${log.submit} next=${log.next}`);
    await shot(p, 'scenario-workday.png');
    await p.close();
  }

  // ---------- tricky: profile fields filled, required-with-no-answer stays empty, no submit
  {
    await resetLog(); net.length = 0;
    const p = await openPage(b, PRACTICE + 'tricky.html');
    const r = await fillPage(b, id, p, { resume: resumeName });
    assert('tricky_fill_ran', r.clicked, 'no Fill button on tricky');
    const f = await fieldMap(p);
    assert('tricky_email', f.em === per.email, `email=${f.em}`);
    assert('tricky_phone', (f.ph || '') === (per.phone || ''), `phone=${f.ph}`);
    // "Which shift" has no saved answer, and Country has no matching option -> stay empty
    assert('tricky_required_no_guess', (f.shift === 'Choose one' || !f.shift) && (f.country === 'Choose one' || !f.country), `shift=${f.shift} country=${f.country}`);
    const log = await practiceLog();
    assert('tricky_no_submit', log.submit === 0 && log.next === 0, `log submit=${log.submit} next=${log.next}`);
    await shot(p, 'scenario-tricky.png');
    await p.close();
  }

  // ---------- iframe same-origin: frame form filled, sibling search box untouched
  {
    await resetLog(); net.length = 0;
    const p = await openPage(b, PRACTICE + 'iframe-same.html');
    const r = await fillPage(b, id, p, { resume: resumeName });
    assert('iframe_same_fill_ran', r.clicked, 'no Fill button on iframe-same');
    // read the frame's fields via pierce
    const frameVals = await (async () => {
      const doc = await p.send('DOM.getDocument', { depth: -1, pierce: true });
      let out = null;
      const walk = async (n) => {
        if (n.contentDocument) {
          const rn = await p.send('DOM.resolveNode', { backendNodeId: n.contentDocument.backendNodeId }).catch(() => null);
          if (rn) { const v = await p.send('Runtime.callFunctionOn', { objectId: rn.object.objectId, functionDeclaration: 'function(){ const g=id=>{const e=this.getElementById(id);return e?e.value:null}; return {fn:g("first_name"),em:g("email")}; }', returnByValue: true }); if (v.result.value && (v.result.value.fn || v.result.value.em)) out = v.result.value; }
        }
        for (const c of n.children ?? []) await walk(c);
      };
      await walk(doc.root);
      return out;
    })();
    assert('iframe_same_frame_filled', frameVals && frameVals.fn === per.firstName && frameVals.em === per.email, 'frame form not filled: ' + JSON.stringify(frameVals));
    const top = await fieldMap(p); // the top page has a search box named q
    assert('iframe_same_search_untouched', !top.q, `search box got: ${top.q}`);
    const log = await practiceLog();
    assert('iframe_same_no_submit', log.submit === 0 && log.next === 0, `log submit=${log.submit} next=${log.next}`);
    await shot(p, 'scenario-iframe-same.png');
    await p.close();
  }

  // ---------- iframe cross-origin: refused, no fill call, nothing touched
  {
    await resetLog(); net.length = 0;
    const p = await openPage(b, PRACTICE + 'iframe-cross.html');
    const r = await fillPage(b, id, p, { resume: resumeName });
    const refused = !r.clicked || /did not run|another site|cannot reach/i.test(await (await openPopup(b, id, 'iframe-cross.html', p)).eval('document.body.innerText'));
    const madeFill = net.some((n) => n.url.endsWith('/extension/fill'));
    assert('iframe_cross_refused', refused && !madeFill, `clicked=${r.clicked} fillCall=${madeFill}`);
    const log = await practiceLog();
    assert('iframe_cross_no_submit', log.submit === 0 && log.next === 0, `log submit=${log.submit} next=${log.next}`);
    await p.close();
  }

  // ---------- blocked host (linkedin-like): refused, no fill call, no field change
  {
    // serve blocked.html under www.linkedin.com (mapped to 127.0.0.1 by --host-resolver-rules)
    await resetLog(); net.length = 0;
    const p = await openPage(b, 'http://www.linkedin.com:47900/practice/blocked.html');
    const loaded = await until(() => p.eval(`!!document.querySelector('form input')`), 6000);
    if (!loaded) { skip('linkedin_refused', 'blocked.html did not load under www.linkedin.com (proxy/DNS); cannot assert'); }
    else {
      const before = await fieldMap(p);
      const r = await fillPage(b, id, p, { resume: resumeName });
      const after = await fieldMap(p);
      const changed = Object.keys(after).some((k) => after[k] !== before[k]);
      const madeFill = net.some((n) => n.url.endsWith('/extension/fill'));
      assert('linkedin_refused', !r.clicked && !changed && !madeFill, `clicked=${r.clicked} changed=${changed} fillCall=${madeFill}`);
      await shot(p, 'scenario-linkedin.png');
    }
    await p.close();
  }

  // drafts need AI, which the scenario does not connect
  skip('drafts', 'no AI provider connected; open-question drafts are AI-backed and not asserted here');

} catch (e) {
  fail('scenario_crash', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
} finally {
  try { if (b) await b.close(); } catch {}
  try { if (practiceProc) practiceProc.kill('SIGKILL'); } catch {}
}

console.log(`\n${failed} failed, ${ran} ran`);
process.exit(failed ? 1 : 0);
