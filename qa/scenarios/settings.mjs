// Replay of the Settings + local-API security checks (area: settings). Plain Node 24 ES module, no packages.
// Reads JOBLEFT_QA_URL, JOBLEFT_QA_API, JOBLEFT_QA_TOKEN, JOBLEFT_QA_SHOTS, JOBLEFT_QA_STATE, JOBLEFT_QA_LOG (optional).
// Deterministic: no real AI and no outbound network. Every mutation is undone from a backup taken first, so the
// instance is left as it started (AI keys in the keychain are the one thing a restore cannot bring back).
// Prints one line per check: "CHECK ok <name>", "CHECK FAIL <name>: <why>" or "CHECK skip <name>: <why>".
import { mkdirSync } from 'node:fs';
import http from 'node:http';

const { launch } = await import(new URL('../bin/driver.mjs', import.meta.url).href);

const URL0 = process.env.JOBLEFT_QA_URL;
const API = (process.env.JOBLEFT_QA_API || '').replace(/\/$/, '');
const TOKEN = process.env.JOBLEFT_QA_TOKEN;
const SHOTS = process.env.JOBLEFT_QA_SHOTS || '.';
const STATE = process.env.JOBLEFT_QA_STATE || 'golden';
const LOG = process.env.JOBLEFT_QA_LOG || '';
const EVIL_PORT = 47950;
if (!URL0 || !API || !TOKEN) { console.log('CHECK FAIL setup: JOBLEFT_QA_URL, JOBLEFT_QA_API and JOBLEFT_QA_TOKEN are required'); process.exit(1); }
try { mkdirSync(SHOTS, { recursive: true }); } catch {}

let failed = 0;
const ok = (n) => console.log(`CHECK ok ${n}`);
const fail = (n, why) => { failed++; console.log(`CHECK FAIL ${n}: ${String(why).replace(/\s+/g, ' ').slice(0, 400)}`); };
const skip = (n, why) => console.log(`CHECK skip ${n}: ${why}`);
const check = (n, cond, why) => (cond ? ok(n) : fail(n, why));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body, headers = {}, token = TOKEN, raw = false } = {}) {
  const h = { ...headers };
  if (!raw) h['content-type'] = h['content-type'] || 'application/json';
  if (token) h['x-jobleft-token'] = token;
  // JSON bodies must be serialized; raw bodies (Buffer/string) go through untouched.
  let payload = body;
  if (!raw && body !== undefined && typeof body !== 'string') payload = JSON.stringify(body);
  const r = await fetch(API + path, { method, headers: h, body: payload });
  if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const j = (o) => JSON.stringify(o);

// A stable snapshot of the state a backup/restore must round-trip exactly (drops volatile timestamps/ids).
async function snapshot() {
  const s = {};
  const prof = (await api('/profile')).body; if (prof && prof.personal) { delete prof.updatedAt; delete prof.version; }
  s.profile = prof;
  s.tracker = {};
  for (const v of ['liked', 'applied', 'external', 'hidden']) s.tracker[v] = (await api('/tracker?view=' + v)).body?.counts;
  s.filters = (await api('/filters')).body?.map((f) => ({ name: f.name, filter: f.filter, sort: f.sort }));
  s.resumes = (await api('/resumes')).body?.map((r) => ({ name: r.name, bytes: r.file?.bytes ?? null }));
  s.settings = (await api('/settings')).body;
  s.chats = (await api('/ai/chats')).body?.length;
  s.jobs = (await api('/storage')).body?.jobs;
  s.boards = (await api('/boards?view=all&limit=1')).body?.total;
  return s;
}

let backup = null; // the full backup taken first; every mutation is undone from it.

try {
  // ---- take a full backup up front (all later mutations are reverted from it) ----
  {
    const r = await api('/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', raw: true });
    if (r.status === 200 && r.buf.length > 100) { backup = r.buf; ok('backup route returns a zip'); }
    else fail('backup route returns a zip', `status ${r.status} bytes ${r.buf?.length}`);
  }

  // ---- 1. no-token and wrong-token refusals on 10 routes ----
  {
    const routes = ['/profile', '/ai/settings', '/publik', '/settings', '/crawl/status', '/boards?view=all&limit=5', '/storage', '/extension/pairings', '/resumes', '/tracker?view=applied'];
    let none = 0, wrong = 0;
    for (const r of routes) {
      const a = await api(r, { token: null });
      const b = await api(r, { token: 'not-the-real-token' });
      if (a.status === 401) none++; else fail('no-token refused ' + r, `status ${a.status}`);
      if (b.status === 401) wrong++; else fail('wrong-token refused ' + r, `status ${b.status}`);
    }
    check('no-token refusals on 10 routes', none === routes.length, `${none}/${routes.length} returned 401`);
    check('wrong-token refusals on 10 routes', wrong === routes.length, `${wrong}/${routes.length} returned 401`);
    // health needs no token
    check('health needs no token', (await api('/health', { token: null })).status === 200, 'health should be public');
    // a token in the URL query must be refused, never accepted
    const q = await api('/profile?token=' + encodeURIComponent(TOKEN), { token: null });
    check('token in URL query is refused', q.status === 400 || q.status === 401, `status ${q.status}`);
  }

  // ---- 2. boards list health shape ----
  {
    const r = await api('/boards?view=all&limit=100');
    if (r.status !== 200) fail('boards list shape', `status ${r.status}`);
    else if (!Array.isArray(r.body.items)) fail('boards list shape', 'items is not an array');
    else if (r.body.total === 0 || r.body.items.length === 0) skip('boards list health shape', 'no boards in this state');
    else {
      const bad = r.body.items.filter((b) => !b.id || !b.ats || !b.board || typeof b.company !== 'string' || typeof b.state !== 'string' || !('openJobs' in b) || !('followed' in b));
      check('boards list health shape', bad.length === 0, `${bad.length} boards missing id/ats/board/company/state/openJobs/followed, e.g. ${j(bad[0])}`);
      check('boards total is a number >= items', typeof r.body.total === 'number' && r.body.total >= r.body.items.length, `total ${r.body.total} items ${r.body.items.length}`);
      const banned = r.body.items.filter((b) => /undefined|null|NaN|\[object/.test(b.company) || /undefined|NaN/.test(b.state));
      check('boards list has no undefined/null/NaN text', banned.length === 0, `e.g. ${j(banned[0])}`);
    }
  }

  // ---- 3. alerts switches persist after reload (via the UI) ----
  const before = await launch();
  const p = await before.page();
  try {
    await p.size(1400, 900);
    await p.goto(URL0);
    await p.waitFor(`document.body.innerText.length > 100`, 20000);
    const openTab = async (tab) => {
      if (!(await p.eval(`location.hash.indexOf('#/settings') === 0`))) { await p.clickText('Settings'); await p.waitFor(`document.querySelectorAll('.ant-menu-item').length >= 7`, 10000); }
      await p.clickText(tab, '.ant-menu'); await sleep(1000);
    };
    const switches = () => p.eval(`JSON.stringify([...document.querySelectorAll('.ant-switch')].map(s => s.getAttribute('aria-checked')))`);

    await openTab('Alerts');
    await p.waitFor(`document.querySelectorAll('.ant-switch').length >= 2`, 8000).catch(() => {});
    const orig = (await api('/settings')).body?.notifications || {};
    const s0 = JSON.parse(await switches());
    if (s0.length < 2) { skip('alerts switches persist after reload', 'Alerts screen has no switches in this build'); }
    else {
      // flip both, confirm the server stored it, reload, confirm the switches still match the server
      await p.eval(`document.querySelectorAll('.ant-switch')[0].click()`); await sleep(500);
      await p.eval(`document.querySelectorAll('.ant-switch')[1].click()`); await sleep(700);
      const s1 = JSON.parse(await switches());
      const flipped = s1[0] !== s0[0] && s1[1] !== s0[1];
      const srv = (await api('/settings')).body?.notifications || {};
      const stored = srv.reminders !== orig.reminders && srv.alerts !== orig.alerts;
      // reload the page and read again
      await p.goto(URL0); await p.waitFor(`document.body.innerText.length > 100`, 20000);
      await openTab('Alerts'); await p.waitFor(`document.querySelectorAll('.ant-switch').length >= 2`, 8000).catch(() => {});
      const s2 = JSON.parse(await switches());
      const persisted = s2[0] === s1[0] && s2[1] === s1[1];
      const matchesServer = (s2[0] === 'true') === !!srv.reminders && (s2[1] === 'true') === !!srv.alerts;
      check('alerts switches change the stored settings', flipped && stored, `ui ${j(s0)}->${j(s1)} server ${j(orig)}->${j(srv)}`);
      check('alerts switches persist after reload', persisted && matchesServer, `after reload ${j(s2)} vs before-reload ${j(s1)} / server ${j(srv)}`);
      // restore the original notification settings
      await api('/settings', { method: 'PUT', body: { crawl: (await api('/settings')).body.crawl, notifications: orig } });
    }

    // ---- 4. stored markup in a text field does not execute on any screen ----
    {
      const XSS = 'ZZQA <img src=x onerror="window.__xss=(window.__xss||0)+1"> <svg onload="window.__xss=7"></svg> <script>window.__xss=99</script>';
      const prof = (await api('/profile')).body;
      const orig = JSON.parse(JSON.stringify(prof));
      const mut = JSON.parse(JSON.stringify(prof)); delete mut.id;
      mut.personal.lastName = (mut.personal.lastName || '') + XSS;
      mut.summary = (mut.summary || '') + ' ' + XSS;
      const put = await api('/profile', { method: 'PUT', body: mut });
      if (put.status !== 200) { skip('stored markup does not execute', `profile not writable (status ${put.status})`); }
      else {
        await p.goto(URL0); await p.waitFor(`document.body.innerText.length > 100`, 20000);
        await p.clickText('Profile'); await sleep(2500);
        const res = await p.eval(`({ xss: window.__xss || 0, imgs: document.querySelectorAll('img[src="x"]').length, svg: document.querySelectorAll('svg[onload]').length, text: (document.body.innerText.indexOf('ZZQA') >= 0) })`);
        check('stored markup does not execute (Profile)', res.xss === 0 && res.imgs === 0 && res.svg === 0, `xss=${res.xss} imgs=${res.imgs} svg=${res.svg} (text shown as literal: ${res.text})`);
        // put the original profile back
        delete orig.id; await api('/profile', { method: 'PUT', body: orig });
      }
    }

    // ---- 5. a cross-origin page gets nothing from the local API ----
    {
      const html = `<!doctype html><meta charset=utf-8><body><script>
        const T=${j(API)}; const R={};
        async function t(n,u,o){ try{const r=await fetch(u,o);R[n]={status:r.status,body:(await r.text()).slice(0,80)};}catch(e){R[n]={err:String(e.message||e)};} }
        (async()=>{ await t('get',T+'/profile',{}); await t('cred',T+'/profile',{credentials:'include'});
          await t('nocors',T+'/settings',{mode:'no-cors',credentials:'include'});
          await new Promise(res=>{const f=document.createElement('iframe');f.src=T.replace('/api/v1','/')+'#x';f.onload=()=>{try{R.iframe=f.contentWindow.document.body.innerText.slice(0,30);}catch(e){R.iframe='blocked:'+e.name;}res();};f.onerror=()=>{R.iframe='error';res();};document.body.appendChild(f);setTimeout(res,3000);});
          window.__results=R; window.__done=true; })();
      </script></body>`;
      const server = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(html); });
      let port = EVIL_PORT;
      const listen = (pt) => new Promise((res, rej) => { server.once('error', rej); server.listen(pt, '127.0.0.1', () => { server.removeAllListeners('error'); res(); }); });
      let bound = false;
      for (const pt of [EVIL_PORT, EVIL_PORT + 1, 47960, 47970]) { try { await listen(pt); port = pt; bound = true; break; } catch { /* port busy, try next */ } }
      if (!bound) { skip('cross-origin page gets nothing', 'no free loopback port for the attack server'); }
      else try {
        const before = j(await snapshot());
        await p.goto(`http://127.0.0.1:${port}/`);
        await p.waitFor(`window.__done === true`, 20000);
        const R = await p.eval(`window.__results`);
        const gotData = (R.get && R.get.status === 200) || (R.cred && R.cred.status === 200) || (typeof R.iframe === 'string' && !/^blocked|^error/.test(R.iframe));
        check('cross-origin page gets nothing', !gotData, `results ${j(R)}`);
        const after = j(await snapshot());
        check('cross-origin page changed no data', before === after, 'snapshot changed after loading the attack page');
      } finally { server.close(); }
    }
  } finally { await before.close(); }

  // ---- 6. health survives 200 concurrent requests ----
  {
    const ps = []; const codes = {};
    for (let i = 0; i < 200; i++) ps.push(fetch(API + '/health', { signal: AbortSignal.timeout(20000) }).then((r) => { codes[r.status] = (codes[r.status] || 0) + 1; }).catch(() => { codes.err = (codes.err || 0) + 1; }));
    await Promise.all(ps);
    const h = await api('/health', { token: null });
    check('health survives 200 concurrent requests', codes[200] === 200 && h.status === 200, `codes ${j(codes)} then health ${h.status}`);
  }

  // ---- 7. backup / restore round-trip equality (self-contained: its own fresh backup) ----
  {
    const fresh = await api('/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', raw: true });
    if (fresh.status !== 200 || fresh.buf.length < 100) { fail('backup/restore round-trip equality', `backup status ${fresh.status}`); }
    else {
      const before = await snapshot();
      // mutate a stored setting, then restore the fresh backup and confirm everything matches again
      const cur = (await api('/settings')).body;
      await api('/settings', { method: 'PUT', body: { crawl: { ...cur.crawl, intervalHours: cur.crawl.intervalHours === 12 ? 6 : 12 }, notifications: { reminders: !cur.notifications.reminders, alerts: !cur.notifications.alerts } } });
      const changed = j(await snapshot()) !== j(before);
      const rr = await api('/restore', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: fresh.buf, raw: true });
      const after = await snapshot();
      check('restore route accepts the backup', rr.status === 200, `status ${rr.status}`);
      check('a change before restore is visible', changed, 'mutating settings did not change the snapshot (PUT ignored?)');
      check('backup/restore round-trip equality', j(before) === j(after), `diff before/after restore: ${diffStr(before, after)}`);
    }
  }

  // ---- 8. restore refuses a non-backup file, keeping the server alive ----
  {
    const bad = await api('/restore', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: Buffer.from('this is not a zip at all, just text'), raw: true });
    check('restore refuses a non-backup file', bad.status >= 400 && bad.status < 500, `status ${bad.status}`);
    check('server alive after a bad restore', (await api('/health', { token: null })).status === 200, 'health failed after bad restore');
  }

  // ---- 9. log contains no token ----
  if (LOG) {
    try {
      const { readFileSync } = await import('node:fs');
      const text = readFileSync(LOG, 'utf8');
      check('log contains no token', !text.includes(TOKEN) && !/Bearer\s+\S/.test(text) && !/x-jobleft-token/i.test(text), 'the log holds the token or an auth header');
    } catch (e) { skip('log contains no token', 'could not read JOBLEFT_QA_LOG: ' + e.message); }
  } else skip('log contains no token', 'JOBLEFT_QA_LOG not set (log path is not in the scenario env)');

  // ---- 10. delete-all wipes the data, then restore brings it back ----
  if (backup) {
    const bad = await api('/data/delete', { method: 'POST', body: { confirm: 'nope' } });
    check('delete-all needs the exact confirm text', bad.status === 400, `wrong confirm gave ${bad.status}`);
    const del = await api('/data/delete', { method: 'POST', body: { confirm: 'delete everything' } });
    if (del.status !== 200) fail('delete-all wipes the data folder contents', `delete status ${del.status}`);
    else {
      const st = (await api('/storage')).body; const prof = (await api('/profile')).body;
      const pub = (await api('/publik')).body; const ai = (await api('/ai/settings')).body;
      const res = (await api('/resumes')).body;
      const wiped = st.jobs === 0 && st.openJobs === 0 && (!prof.personal.firstName) && Array.isArray(res) && res.length === 0 && pub.state === 'disconnected' && ai.keySet === false;
      check('delete-all wipes the data folder contents', wiped, `storage ${j(st)} profile.firstName ${prof.personal.firstName} resumes ${res.length} publik ${pub.state} keySet ${ai.keySet}`);
      // restore so the instance is left usable
      const rr = await api('/restore', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: backup, raw: true });
      const back = (await api('/storage')).body;
      check('restore recovers the data after delete-all', rr.status === 200 && (STATE === 'fresh' || back.jobs > 0), `restore ${rr.status} jobs ${back.jobs}`);
    }
  } else skip('delete-all wipes the data folder contents', 'no backup to restore afterwards; refusing to wipe without one');

} catch (e) {
  fail('scenario', e && e.stack ? e.stack : e);
} finally {
  // nothing else to close (Chrome was closed above)
}

function diffStr(a, b) {
  const out = [];
  const walk = (x, y, path) => {
    if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path + '.' + k); }
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${path}: ${JSON.stringify(x)}->${JSON.stringify(y)}`);
  };
  walk(a, b, ''); return out.slice(0, 6).join(' ; ');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
