// Replay of the onboarding-area checks (first run, empty states, Profile, API hardening).
// Plain Node 24 ES module, no packages. Reads its target from the environment (see scenarios/README.md).
// Works for JOBLEFT_QA_STATE=fresh (full first-run flow) and golden (onboarding is skipped; Profile + API + invariants).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const { launch, AUDIT } = await import(new URL('../bin/driver.mjs', import.meta.url));

const URL_ = process.env.JOBLEFT_QA_URL;
const API = process.env.JOBLEFT_QA_API;
const TOKEN = process.env.JOBLEFT_QA_TOKEN;
const FIX = process.env.JOBLEFT_QA_FIXTURES;
const SHOTS = process.env.JOBLEFT_QA_SHOTS;
const STATE = (process.env.JOBLEFT_QA_STATE || 'fresh').toLowerCase();
if (!URL_ || !API || !TOKEN || !FIX || !SHOTS) {
  console.log('CHECK FAIL env: JOBLEFT_QA_URL, JOBLEFT_QA_API, JOBLEFT_QA_TOKEN, JOBLEFT_QA_FIXTURES and JOBLEFT_QA_SHOTS must be set');
  process.exit(1);
}
const T0 = Date.now();
const BUDGET_MS = 9 * 60 * 1000;
let failed = 0;
const ok = (name) => console.log(`CHECK ok ${name}`);
const fail = (name, why) => { failed++; console.log(`CHECK FAIL ${name}: ${String(why).replace(/\s+/g, ' ').slice(0, 400)}`); };
const skip = (name, why) => console.log(`CHECK skip ${name}: ${why}`);
const check = (name, cond, why) => (cond ? ok(name) : fail(name, why));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeLeft = () => BUDGET_MS - (Date.now() - T0);

async function api(method, path, { body, raw, headers = {}, token = true } = {}) {
  const h = { ...headers };
  if (token) h['x-jobleft-token'] = TOKEN;
  let data;
  if (raw !== undefined) data = raw;
  else if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = h['content-type'] || 'application/json'; }
  const r = await fetch(API + path, { method, headers: h, body: data });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
// POST with node:http so an early reply (413 before the body is sent) can still be read.
function rawPost(path, buf, type) {
  return new Promise((resolve) => {
    const u = new URL(API + path);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'x-jobleft-token': TOKEN, 'content-type': type, 'content-length': buf.length } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json, text: t }); });
    });
    req.on('error', (e) => resolve({ status: 'error', json: null, text: String(e) }));
    req.end(buf);
  });
}
const stripMeta = (p) => { const c = structuredClone(p); delete c.id; delete c.version; delete c.updatedAt; return c; };
const healthOk = async () => { try { return (await api('GET', '/health', { token: false })).status === 200; } catch { return false; } };
const plainError = (r) => r.json && r.json.error && typeof r.json.error.message === 'string' && r.json.error.message.length > 5 && !/stack|at \w+ \(|TypeError|ReferenceError/.test(r.text);

// ---------- page helpers ----------
const OPEN_DD = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item';
async function heading(p) { return p.eval(`(document.querySelector('h1,h2,h3,h4')||{}).textContent||''`); }
async function waitHeading(p, re, ms = 8000) { return p.waitFor(`new RegExp(${JSON.stringify(re)}, 'i').test((document.querySelector('h1,h2,h3,h4')||{}).textContent||'')`, ms); }
async function uploadInPage(p, file, name, type, selector = 'input[type=file]') {
  const b64 = file ? readFileSync(file).toString('base64') : '';
  return p.eval(`(()=>{ const bin=atob(${JSON.stringify(b64)}); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    const f=new File([u], ${JSON.stringify(name)}, {type:${JSON.stringify(type)}}); const dt=new DataTransfer(); dt.items.add(f);
    const inp=document.querySelector(${JSON.stringify(selector)}); if(!inp) return false; inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
}
async function setLabeled(p, label, val, nth = 0, scope = '.ant-drawer-open') {
  return p.eval(`(()=>{const Ls=[...document.querySelectorAll('${scope} label')].filter(l=>l.firstChild && l.firstChild.textContent.trim()===${JSON.stringify(label)}); const L=Ls[${nth}]; if(!L) return false;
    const i=L.querySelector('input,textarea'); if(!i || i.disabled) return false; const proto=i.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(i, ${JSON.stringify(val)}); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true})()`);
}
async function setAria(p, aria, val) {
  const okk = await p.eval(`(()=>{const i=document.querySelector('input[aria-label=${JSON.stringify(aria)}]'); if(!i) return false; i.focus(); i.select(); return true})()`);
  if (!okk) return false;
  await p.eval(`document.execCommand('selectAll')`);
  if (val === '') await p.eval(`document.execCommand('delete')`); else await p.type(val);
  return true;
}
async function toast(p) { return p.eval(`[...document.querySelectorAll('.ant-message-notice, .ant-drawer-open [role=alert]')].map(e=>e.textContent).join(' | ')`); }
async function closeDrawer(p) {
  if (!(await p.eval(`document.querySelectorAll('.ant-drawer-open').length`))) return;
  await p.clickText('Cancel', '.ant-drawer-open'); await sleep(400);
  if (await p.eval(`document.querySelectorAll('.ant-modal-wrap').length`)) { await p.clickText('Discard changes', '.ant-modal-wrap'); await sleep(400); }
}
async function audit(p, name) {
  const a = await p.eval(AUDIT);
  // the "Where" step explains the rule in words ("A job that says it does not sponsor is flagged"); that sentence is honest
  const banned = a.banned.filter((x) => !/says it does not sponsor is flagged/.test(x));
  check(`no-banned-words:${name}`, banned.length === 0, JSON.stringify(banned));
  if (process.platform === 'win32') {
    const t = await p.eval('document.body.innerText');
    check(`no-mac-words-on-windows:${name}`, !/\bMac\b|macOS/.test(t), (t.match(/.{0,40}\b(Mac|macOS)\b.{0,40}/) || [''])[0]);
  }
}
const haversineMi = (a, b) => { const R = 3958.8, r = (x) => (x * Math.PI) / 180; const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

let b;
try {
  // ================= API hardening (both states) =================
  check('health', await healthOk(), 'GET /health did not answer 200');
  {
    const r = await api('GET', '/profile', { token: false });
    check('api-refuses-no-token', r.status === 401 && plainError(r), `status ${r.status} ${r.text.slice(0, 120)}`);
    const r2 = await api('GET', '/profile', { headers: { 'x-jobleft-token': 'wrong-token' }, token: false });
    check('api-refuses-wrong-token', r2.status === 401, `status ${r2.status}`);
    const r3 = await api('GET', '/profile', { headers: { Origin: 'https://evil.example.com' } });
    check('api-refuses-other-origin', r3.status === 403 && plainError(r3), `status ${r3.status} ${r3.text.slice(0, 120)}`);
    const r4 = await api('PUT', '/profile', { raw: 'not json', headers: { 'content-type': 'application/json' } });
    check('api-refuses-bad-json', r4.status === 400 && plainError(r4), `status ${r4.status} ${r4.text.slice(0, 120)}`);
    const r5 = await api('PUT', '/profile', { body: [] });
    check('api-refuses-wrong-shape', r5.status === 400 && plainError(r5), `status ${r5.status}`);
    const big = Buffer.alloc(11 * 1024 * 1024, 0x41); big.write('%PDF-1.4\n', 0);
    const r6 = await rawPost('/resumes/import', big, 'application/pdf');
    check('api-refuses-11mb-resume', r6.status === 413 && plainError(r6), `status ${r6.status}`);
    const r7 = await api('GET', '/jobs/' + encodeURIComponent('nope:nope:0'));
    check('api-unknown-job-404', r7.status === 404 && plainError(r7), `status ${r7.status}`);
    check('health-after-bad-input', await healthOk(), 'server stopped answering after bad input');
  }
  // Server-side validation gaps (JL-onboarding-21/22): absurd values must be refused.
  {
    const base = stripMeta((await api('GET', '/profile')).json);
    const huge = structuredClone(base); huge.personal.firstName = 'A'.repeat(200000);
    const r1 = await api('PUT', '/profile', { body: huge });
    check('api-refuses-200k-name', r1.status === 400, `status ${r1.status} (a 200,000-character first name was stored)`);
    const pay = structuredClone(base); pay.preferences.minAnnualPayUsd = 1e30;
    const r2 = await api('PUT', '/profile', { body: pay });
    check('api-refuses-absurd-pay', r2.status === 400, `status ${r2.status} (minAnnualPayUsd 1e30 accepted)`);
    const cc = structuredClone(base); cc.preferences.countries = ['XX'];
    const r3 = await api('PUT', '/profile', { body: cc });
    check('api-refuses-unknown-country', r3.status === 400, `status ${r3.status} (country "XX" accepted)`);
    await api('PUT', '/profile', { body: base }); // restore
    check('health-after-absurd-values', await healthOk(), 'server stopped answering');
  }

  // ================= UI =================
  b = await launch();
  const p = await b.page();
  await p.size(1400, 900);
  await p.goto(URL_);
  await p.waitFor(`document.body.innerText.length > 80`, 15000);
  await sleep(1200);

  if (STATE === 'fresh') {
    // ---------- step 1 ----------
    const onOnb = await waitHeading(p, 'looking for', 8000);
    check('onboarding-on-first-run', onOnb, `landed on ${await p.eval('location.hash')} / "${await heading(p)}"`);
    if (!onOnb) await p.eval(`location.hash = '#/onboarding'`), await waitHeading(p, 'looking for');
    await p.shot(join(SHOTS, 'onb-step1.png'));
    await audit(p, 'step1');
    const ttw = await p.eval(`(()=>{const i=document.querySelector('input[aria-label="Target job titles"]'); return i? Math.round(i.closest('.ant-select').getBoundingClientRect().width):-1})()`);
    check('target-titles-box-visible', ttw >= 120, `Target job titles box is ${ttw}px wide; its hint is invisible`);
    const choices = await p.eval(`[...document.querySelectorAll('.jl-choice')].map(b=>b.textContent.trim())`);
    const pick = choices[0];
    await p.clickText(pick); await sleep(200);
    await setAria(p, 'Other job function', 'Robotics QA'); await p.clickText('Add'); await sleep(300);
    const before = await p.eval(`[...document.querySelectorAll('.jl-choice[aria-pressed=true]')].map(b=>b.textContent.replace('×','').trim())`);
    await p.eval('location.reload()'); await sleep(1500); await waitHeading(p, 'looking for');
    const after = await p.eval(`[...document.querySelectorAll('.jl-choice[aria-pressed=true]')].map(b=>b.textContent.replace('×','').trim())`);
    check('step-choices-survive-reload', before.every((x) => after.includes(x)), `before reload ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    // duplicate by case must not add a second chip
    if (!after.includes(pick)) await p.clickText(pick), await sleep(200);
    await setAria(p, 'Other job function', pick.toUpperCase()); await p.clickText('Add'); await sleep(300);
    const dups = await p.eval(`[...document.querySelectorAll('.jl-choice[aria-pressed=true]')].map(b=>b.textContent.replace('×','').trim().toLowerCase())`);
    check('no-case-duplicate-function', dups.filter((x) => x === pick.toLowerCase()).length === 1, JSON.stringify(dups));
    await p.clickText('Next'); await waitHeading(p, 'which jobs|job type');
    const prof1 = (await api('GET', '/profile')).json;
    check('step1-next-saves', prof1.preferences.jobFunctions.map((x) => x.toLowerCase()).includes(pick.toLowerCase()), JSON.stringify(prof1.preferences.jobFunctions));
    // ---------- quit after step 1 and relaunch ----------
    await p.goto('about:blank'); await p.goto(URL_); await p.waitFor(`document.body.innerText.length > 80`, 15000); await sleep(1500);
    const hash = await p.eval('location.hash');
    check('relaunch-continues-onboarding', /onboarding/.test(hash), `after quitting on step 2 the app opened ${hash}; steps 2-6 are skipped`);
    if (!/onboarding/.test(hash)) { await p.eval(`location.hash = '#/onboarding'`); await waitHeading(p, 'looking for'); }
    if (/looking for/i.test(await heading(p))) { await p.clickText('Next'); await waitHeading(p, 'which jobs|job type'); }
    // ---------- step 2 ----------
    await audit(p, 'step2');
    await p.clickText('Full-time'); await p.clickText('Remote'); await sleep(200);
    await setAria(p, 'Minimum yearly pay in US dollars', '99999999999999999999999'); await p.press('Tab'); await sleep(200);
    const payShown = await p.eval(`document.querySelector('input[aria-label="Minimum yearly pay in US dollars"]').value`);
    check('pay-box-has-a-limit', payShown.replace(/\D/g, '').length <= 8, `pay box kept "${payShown}"`);
    await setAria(p, 'Minimum yearly pay in US dollars', ''); await p.press('Tab');
    await p.clickText('Next'); await waitHeading(p, 'where');
    // ---------- step 3 ----------
    await audit(p, 'step3');
    await p.click('input[aria-label="Add a city"]'); await p.type('Austin');
    await p.waitFor(`document.querySelectorAll(${JSON.stringify(OPEN_DD)}).length > 0`, 8000); await sleep(400);
    const opts = await p.eval(`[...document.querySelectorAll(${JSON.stringify(OPEN_DD)})].map(e=>e.textContent.trim())`);
    if (opts.length > 1) check('city-options-distinguishable', new Set(opts).size === opts.length, `options read ${JSON.stringify(opts)}`);
    else skip('city-options-distinguishable', `only ${opts.length} option(s) for "Austin"`);
    await p.press('Escape'); await sleep(200);
    await setAria(p, 'Add a city', ''); await p.click('input[aria-label="Add a city"]'); await p.type('Xyzzyqqq');
    await sleep(2000); await p.waitFor(`/No city found/.test(document.body.innerText)`, 6000);
    check('unknown-city-plain-message', /No city found/.test(await p.eval('document.body.innerText')), 'no "No city found" for a made-up city');
    await p.press('Escape'); await setAria(p, 'Add a city', '');
    await p.clickText('Next'); await waitHeading(p, 'resume');
    // ---------- step 4 ----------
    await audit(p, 'step4');
    const msg4 = `(document.body.innerText.split('up to 10 MB.')[1]||'')`;
    for (const [file, re, name] of [['empty.pdf', /empty/i, 'empty'], ['locked.pdf', /password/i, 'locked'], ['scanned.pdf', /no text|scan|picture/i, 'scanned']]) {
      const prev = await p.eval(msg4);
      await uploadInPage(p, join(FIX, file), file, 'application/pdf');
      await p.waitFor(`(document.body.innerText.split('up to 10 MB.')[1]||'') !== ${JSON.stringify(prev)}`, 15000); await sleep(300);
      const m = await p.eval(msg4);
      check(`upload-${name}-plain-message`, re.test(m) && !/error:|exception|stack/i.test(m), m.slice(0, 200));
    }
    const resumesBefore = (await api('GET', '/resumes')).json.length;
    check('bad-files-store-no-resume', resumesBefore === 0, `${resumesBefore} resume rows after refused files`);
    await uploadInPage(p, join(FIX, 'jordan-two-column.pdf'), 'first-try.pdf', 'application/pdf');
    await p.waitFor(`/Use the facts/.test(document.body.innerText)`, 20000);
    await p.clickText('Use another file'); await sleep(300);
    await uploadInPage(p, join(FIX, 'jordan-layout-table.docx'), 'kept-one.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await p.waitFor(`/Use the facts/.test(document.body.innerText)`, 20000); await sleep(1500);
    await p.shot(join(SHOTS, 'onb-step4.png'));
    const rs = (await api('GET', '/resumes')).json;
    const primary = rs.find((r) => r.isPrimary);
    check('use-another-file-keeps-the-kept-file-primary', rs.length === 1 || (primary && /kept-one/.test(primary.file?.fileName || primary.name)), `resumes ${JSON.stringify(rs.map((r) => [r.name, r.isPrimary]))}`);
    await p.clickText('Next'); await waitHeading(p, 'about you');
    // ---------- step 5 ----------
    await audit(p, 'step5');
    const labelsVisible = await p.eval(`[...document.querySelectorAll('input')].filter(i=>i.value).every(i=>{ const l=i.closest('label'); const id=i.id && document.querySelector('label[for="'+i.id+'"]'); return (l && l.textContent.trim().length>0) || id || i.getAttribute('aria-labelledby'); })`);
    check('about-you-labels-visible-when-filled', labelsVisible, 'prefilled boxes show only their values, no visible field names');
    await setAria(p, 'Email', 'not-an-email');
    await p.clickText('Next'); await sleep(1500);
    const stillOn5 = /about you/i.test(await heading(p));
    const email = (await api('GET', '/profile')).json.personal.email;
    check('about-you-refuses-bad-email', stillOn5 || email !== 'not-an-email', `email saved as "${email}" with no message`);
    if (stillOn5) { await setAria(p, 'Email', 'jordan.qa@example.com'); await p.clickText('Next'); }
    await waitHeading(p, 'ai');
    // ---------- step 6 ----------
    await audit(p, 'step6');
    await p.shot(join(SHOTS, 'onb-step6.png'));
    const t6 = await p.eval('document.body.innerText');
    check('ai-step-offers-own-key', /own key|your key/i.test(t6), 'only publik and local model are offered');
    check('ai-step-has-back', await p.eval(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Back')`), 'no Back button on step 6');
    await p.clickMatching('button', '^publik API'); await sleep(2500);
    const after6 = await p.eval('document.body.innerText');
    const h6 = await p.eval('location.hash');
    check('publik-card-shows-terms-and-connect', /I have read this/i.test(after6) || /^#\/settings/.test(h6), `card went to ${h6} with no terms or connect button`);
    // ---------- after onboarding: empty state ----------
    if (!/jobs/.test(await p.eval('location.hash'))) await p.eval(`location.hash = '#/jobs'`);
    await sleep(2000);
    await audit(p, 'jobs-empty');
    const jf = await p.eval(`(document.querySelector('[aria-label^="Job function filter"]')||{getAttribute:()=>null}).getAttribute('aria-label')`);
    check('onboarding-sets-starting-filters', jf && !/: off$/.test(jf), `after choosing "${pick}" the Job function filter reads "${jf}"`);
    const total0 = (await api('POST', '/jobs/search', { body: { sort: 'recommended', filter: {}, limit: 1 } })).json.total;
    if (total0 === 0) {
      const t = await p.eval('document.body.innerText');
      const main = t.slice(Math.max(0, t.indexOf('0 jobs')), t.indexOf('0 jobs') + 220);
      check('empty-feed-is-honest', /0 jobs/.test(t) && /No jobs yet/i.test(t) && /Refresh now/.test(t) && !(await p.eval(`document.querySelectorAll('.ant-spin-spinning').length`)), `no job is stored yet but the feed says: ${main}`);
    } else skip('empty-feed-is-honest', `${total0} jobs already stored`);
    // ---------- first refresh (the 12 starting boards, once) ----------
    if (total0 === 0 && timeLeft() > 300000) {
      await p.clickText('Refresh now');
      const t1 = Date.now(); let st = null;
      while (Date.now() - t1 < 180000) { st = (await api('GET', '/crawl/status')).json; if (st && !st.running && st.lastRun) break; await sleep(2000); }
      if (st && !st.running && st.lastRun) {
        ok('first-refresh-finishes');
        await sleep(2500);
        const st2 = JSON.parse((await p.eval(`localStorage.getItem('jobleft.feed.v1')`)) || '{}');
        const tot = (await api('POST', '/jobs/search', { body: { sort: 'recommended', filter: st2.filter || {}, q: st2.q || '', limit: 1 } })).json.total;
        const all = (await api('POST', '/jobs/search', { body: { sort: 'recommended', filter: {}, limit: 1 } })).json.total;
        const shown = await p.waitFor(`Number(((document.body.innerText.match(/([\\d,]+) jobs/)||[])[1]||'-1').replace(/,/g,'')) === ${tot}`, 20000);
        check('feed-count-matches-stored', shown, `API total for the page's filter ${tot}, page shows "${await p.eval(`(document.body.innerText.match(/[\\d,]+ jobs/)||[''])[0]`)}"`);
        check('feed-not-empty-after-first-refresh', tot > 0 || all === 0, `${all} jobs were read but the starting filters ${JSON.stringify(st2.filter)} show 0 ("No jobs match")`);
        await p.shot(join(SHOTS, 'jobs-after-first-refresh.png'));
        await audit(p, 'jobs-after-first-refresh');
      } else fail('first-refresh-finishes', 'refresh still running after 180 s: ' + JSON.stringify(st));
    } else skip('first-refresh-finishes', total0 ? 'jobs already stored' : 'time budget used');
  } else {
    const h = await p.eval('location.hash');
    check('golden-opens-jobs-not-onboarding', !/onboarding/.test(h), `opened ${h}`);
    await p.eval(`location.hash = '#/onboarding'`); await waitHeading(p, 'looking for');
    const ttw = await p.eval(`(()=>{const i=document.querySelector('input[aria-label="Target job titles"]'); return i? Math.round(i.closest('.ant-select').getBoundingClientRect().width):-1})()`);
    check('target-titles-box-visible', ttw >= 120, `Target job titles box is ${ttw}px wide`);
    await audit(p, 'onboarding-reentry');
  }

  // ================= Profile (both states) =================
  const orig = stripMeta((await api('GET', '/profile')).json);
  await p.eval(`location.hash = '#/profile'`); await sleep(2000);
  await audit(p, 'profile');
  // Personal: save + reload keeps it
  const mark = 'Q' + String(Date.now()).slice(-4);
  if (await p.click('button[aria-label^="Edit"]')) {
    await sleep(800);
    await setLabeled(p, 'Middle name', mark);
    await p.clickText('Save', '.ant-drawer-open'); await sleep(1500);
    await p.eval('location.reload()'); await sleep(2500);
    await p.click('button[aria-label^="Edit"]'); await sleep(800);
    const mv = await p.eval(`(()=>{const L=[...document.querySelectorAll('.ant-drawer-open label')].find(l=>l.firstChild && l.firstChild.textContent.trim()==='Middle name'); return L ? L.querySelector('input').value : null})()`);
    check('profile-save-survives-reload', mv === mark, `middle name after reload is "${mv}", saved "${mark}"`);
    await closeDrawer(p);
  } else fail('profile-save-survives-reload', 'no Edit button on the Personal card');
  // Empty "Add a link" row must not block the save (JL-onboarding-15)
  if (await p.click('button[aria-label^="Edit"]')) {
    await sleep(800);
    await p.clickText('Add a link', '.ant-drawer-open'); await sleep(300);
    await setLabeled(p, 'Middle name', mark + 'b');
    await p.clickText('Save', '.ant-drawer-open'); await sleep(1500);
    const tt = await toast(p);
    check('empty-link-row-does-not-block-save', /Profile saved/.test(tt), `message: "${tt}"`);
    await closeDrawer(p);
  }
  // Education end before start must be refused (JL-onboarding-16)
  if (await p.click('button[aria-label="Edit Education"]')) {
    await sleep(800);
    if (!(await p.eval(`[...document.querySelectorAll('.ant-drawer-open label')].some(l=>l.firstChild && l.firstChild.textContent.trim()==='Start')`))) { await p.clickText('Add a school', '.ant-drawer-open'); await sleep(300); await setLabeled(p, 'School', 'QA State University'); }
    await setLabeled(p, 'Start', '2030-09'); await setLabeled(p, 'End', '2025-01');
    await p.clickText('Save', '.ant-drawer-open'); await sleep(1500);
    const tt = await toast(p);
    const edu = (await api('GET', '/profile')).json.education;
    const stored = edu.some((e) => e.startDate === '2030-09' && e.endDate === '2025-01');
    check('education-refuses-end-before-start', !stored, `saved Start 2030-09 End 2025-01 ("${tt}")`);
    await closeDrawer(p);
  }
  // Conflict between two editors is detected (regression guard)
  if (await p.click('button[aria-label^="Edit"]')) {
    await sleep(800);
    const cur = stripMeta((await api('GET', '/profile')).json);
    cur.summary = 'Changed in another window ' + mark;
    await api('PUT', '/profile', { body: cur });
    await setLabeled(p, 'Middle name', mark + 'c');
    await p.clickText('Save', '.ant-drawer-open'); await sleep(1500);
    const tt = await p.eval('document.body.innerText');
    const after = (await api('GET', '/profile')).json;
    check('profile-conflict-detected', /another window/i.test(tt) && after.summary === cur.summary, `other window's summary now "${after.summary}"`);
    if (await p.clickMatching('button', 'Load the newer one')) await sleep(600);
    await closeDrawer(p);
  }
  // Score reacts to a profile change and the band follows the number
  {
    const s = await api('POST', '/jobs/search', { body: { sort: 'recommended', filter: {}, limit: 100 } });
    const items = s.json?.items || [];
    if (!items.length) skip('match-band-follows-number', 'no jobs stored');
    else {
      const bad = items.filter((it) => it.match && typeof it.match.percent === 'number').filter((it) => it.match.band !== (it.match.percent >= 85 ? 'strong' : it.match.percent >= 70 ? 'good' : 'fair'));
      check('match-band-follows-number', bad.length === 0, bad.slice(0, 3).map((it) => `${it.match.percent}% ${it.match.band}`).join(', '));
      const first = items.find((it) => it.match && typeof it.match.percent === 'number');
      if (first) {
        const d = await api('GET', '/jobs/' + encodeURIComponent(first.job.id));
        check('match-same-on-card-and-detail', d.json?.match?.percent === first.match.percent, `search ${first.match.percent} vs detail ${d.json?.match?.percent}`);
      }
    }
  }
  // A job function filter finds the jobs whose title names that function (JL-onboarding-28)
  {
    const total = (await api('POST', '/jobs/search', { body: { sort: 'recommended', filter: {}, limit: 1 } })).json?.total || 0;
    if (!total) skip('function-filter-finds-titled-jobs', 'no jobs stored');
    else {
      let titled = 0, cursor = null, pages = 0;
      while (pages < 20) {
        const body = { sort: 'recommended', filter: {}, q: 'software engineer', limit: 100 }; if (cursor) body.cursor = cursor;
        const r = await api('POST', '/jobs/search', { body }); pages++;
        titled += (r.json?.items || []).filter((it) => /software engineer/i.test(it.job.title)).length;
        if (!r.json?.nextCursor) break; cursor = r.json.nextCursor;
      }
      const fn = (await api('POST', '/jobs/search', { body: { sort: 'recommended', filter: { jobFunctions: ['Software Engineering'] }, limit: 1 } })).json?.total ?? -1;
      if (titled < 10) skip('function-filter-finds-titled-jobs', `only ${titled} titles say "software engineer"`);
      else check('function-filter-finds-titled-jobs', fn >= titled * 0.5, `Job function "Software Engineering" returns ${fn} jobs; ${titled} titles contain "software engineer"`);
    }
  }
  // "In <city>" reasons only within the chosen radius (JL-onboarding-17)
  {
    const total = (await api('POST', '/jobs/search', { body: { sort: 'recommended', filter: {}, limit: 1 } })).json?.total || 0;
    if (!total) skip('in-city-reason-within-radius', 'no jobs stored');
    else if (timeLeft() < 120000) skip('in-city-reason-within-radius', 'time budget used');
    else {
      const look = await api('GET', '/lookup/place?text=' + encodeURIComponent('Austin'));
      const target = look.json?.places?.[0];
      if (!target) skip('in-city-reason-within-radius', 'lookup gave no place for Austin');
      else {
        const cur = stripMeta((await api('GET', '/profile')).json);
        const test = structuredClone(cur); test.preferences.places = [{ text: target.city, placeId: target.placeId, radiusMiles: 25 }];
        await api('PUT', '/profile', { body: test });
        const label = `In ${target.city}`; const far = []; const cache = new Map(); let cursor = null; let seen = 0;
        while (seen < 6000 && timeLeft() > 60000) {
          const body = { sort: 'recommended', filter: {}, limit: 100 }; if (cursor) body.cursor = cursor;
          const r = await api('POST', '/jobs/search', { body });
          for (const it of r.json.items) {
            seen++;
            if (!it.match?.whyFit?.some((w) => w.label === label)) continue;
            let near = false;
            for (const pl of it.job.places || []) {
              const q = [pl.city, pl.region].filter(Boolean).join(', ') || pl.text; if (!q) continue;
              if (!cache.has(q)) { const g = await api('GET', '/lookup/place?text=' + encodeURIComponent(q)); cache.set(q, g.json?.places?.[0] || null); }
              const g = cache.get(q); if (g && haversineMi(target, g) <= 40) { near = true; break; }
              if (!g) { near = true; break; } // unknown place: do not accuse
            }
            if (!near) far.push((it.job.places || []).map((x) => x.text).join(' / '));
            if (far.length >= 5) break;
          }
          if (far.length >= 5 || !r.json.nextCursor) break;
          cursor = r.json.nextCursor;
        }
        check('in-city-reason-within-radius', far.length === 0, `"${label}" (25 mi) shown on jobs in: ${far.join('; ')}`);
        await api('PUT', '/profile', { body: cur });
      }
    }
  }
  // restore the profile of a golden instance
  if (STATE !== 'fresh') { const now = (await api('GET', '/profile')).json; const back = structuredClone(orig); await api('PUT', '/profile', { body: back }); void now; }
  check('health-at-end', await healthOk(), 'server stopped answering');
  const errs = p.errors().filter((e) => !/Failed to load resource/.test(e));
  check('no-uncaught-page-errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  fail('scenario-crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e);
} finally {
  if (b) await b.close();
}
process.exit(failed ? 1 : 0);
