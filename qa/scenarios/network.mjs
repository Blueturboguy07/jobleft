// Replay checks for the Network surface (LinkedIn connections import, Companies, People, Coffee chats, Follow-ups,
// drafts), the Interview question bank, Assistant history and proposals, and API refusals on those routes.
// Plain Node 24 ES module, no packages. Reads its target from the environment (see scenarios/README.md).
// Prints one line per check: "CHECK ok <name>", "CHECK FAIL <name>: <why>" or "CHECK skip <name>: <why>".
// Exit code 1 when any check failed.
//
// Note: the scenario starts from an empty network. If the instance already has imported people (a second run), it
// deletes all network data first (DELETE /network: jobs, tracker, resumes and profile are not touched).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { launch, AUDIT } = await import(new URL('../bin/driver.mjs', import.meta.url));

const URL0 = process.env.JOBLEFT_QA_URL;
const API = (process.env.JOBLEFT_QA_API || '').replace(/\/$/, '');
const TOKEN = process.env.JOBLEFT_QA_TOKEN;
const FIX = process.env.JOBLEFT_QA_FIXTURES;
const SHOTS = process.env.JOBLEFT_QA_SHOTS || join(tmpdir(), 'jobleft-network-shots');
const STATE = process.env.JOBLEFT_QA_STATE || 'golden';
if (!URL0 || !API || !TOKEN || !FIX) {
  console.log('CHECK FAIL setup: JOBLEFT_QA_URL, JOBLEFT_QA_API, JOBLEFT_QA_TOKEN and JOBLEFT_QA_FIXTURES are required');
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const ok = (name) => console.log(`CHECK ok ${name}`);
const fail = (name, why) => { failed++; console.log(`CHECK FAIL ${name}: ${String(why).replace(/\s+/g, ' ').slice(0, 400)}`); };
const skip = (name, why) => console.log(`CHECK skip ${name}: ${why}`);
const check = (name, cond, why) => (cond ? ok(name) : fail(name, why));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const h = { 'x-jobleft-token': TOKEN, ...headers };
  let payload = body;
  if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
    h['content-type'] = h['content-type'] || 'application/json';
  }
  const r = await fetch(API + path, { method, headers: h, body: payload });
  const text = await r.text();
  if (raw) return { status: r.status, text, headers: r.headers };
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}
const importCsv = (content) => api('/network/import', { method: 'POST', body: content, headers: { 'content-type': 'text/csv' } });
const contacts = async (q = '') => (await api('/network/contacts' + q)).body;
const fixture = (name) => readFileSync(join(FIX, name));

// Loopback-only check for the page's own requests.
const LOOPBACK = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/|data:|blob:|about:|chrome-extension:|devtools:)/i;
const nonLoopback = (reqs) => reqs.map((r) => r.url).filter((u) => !LOOPBACK.test(u));

const b = await launch();
try {
  const p = await b.page();
  await p.size(1400, 900);
  const text = async () => p.eval(`(document.querySelector('main') || document.body).innerText`);
  const nav = async (hash) => { await p.eval(`location.hash = ${JSON.stringify(hash)}`); await sleep(900); };
  const upload = async (buf, name) => {
    const b64 = Buffer.from(buf).toString('base64');
    return p.eval(`(() => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const f = new File([u], ${JSON.stringify(name)}, { type: 'text/csv' }); const dt = new DataTransfer(); dt.items.add(f);
      const i = document.querySelector('input[type=file]'); if (!i) return false; i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  };
  const reload = async () => { await p.goto(URL0.split('#')[0] + '#token=' + URL0.split('#token=')[1]); await p.waitFor(`document.body.innerText.length > 50`, 15000); };

  // 0. Health and a clean network
  const h0 = await api('/health', { headers: {} });
  check('health route answers', h0.status === 200 && h0.body && h0.body.app === 'jobleft', `status ${h0.status} ${h0.text.slice(0, 120)}`);
  const pre = await contacts();
  if (Array.isArray(pre) && pre.length > 0) {
    const d = await api('/network', { method: 'DELETE' });
    check('reset: delete all network data', d.status === 200 && (await contacts()).length === 0, `status ${d.status}`);
  }

  await reload();
  await nav('#/network');
  await p.waitFor(`/Connections\\.csv/.test(document.body.innerText)`, 10000);
  p.clearRequests();

  // 1. The empty screen explains how to get the file and never offers to log in to or fetch from LinkedIn
  {
    const t = await text();
    const how = /Get a copy of your data/i.test(t) && /Connections\.csv/.test(t) && /never contacts LinkedIn/i.test(t);
    check('network: explains how to get Connections.csv from LinkedIn', how, t.slice(0, 300));
    const offers = await p.eval(`[...document.querySelectorAll('main button, main a, main [role=button]')].map((e) => (e.innerText + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('href') || '')).trim())
      .filter((s) => /linkedin/i.test(s) && /(sign in|log ?in|connect|authorize|fetch|sync)/i.test(s) || /^https?:\\/\\/([a-z]+\\.)?linkedin\\.com/i.test(s.split(' ').pop()))`);
    check('network: no LinkedIn login, connect or fetch offer on the import screen', offers.length === 0, JSON.stringify(offers));
  }

  // 2. The wrong export (messages.csv) through the screen's own file input
  {
    const up = await upload(fixture('messages.csv'), 'messages.csv');
    await p.waitFor(`/Not imported/i.test(document.body.innerText)`, 10000);
    const t = await text();
    const n = (await contacts()).length;
    check('import messages.csv: refused in plain words, nothing imported', up && /Not imported/i.test(t) && /not a connections file/i.test(t) && n === 0,
      `upload=${up} count=${n} text=${t.slice(0, 200)}`);
    await p.shot(join(SHOTS, 'network-01-messages.png'));
  }

  // 3. Empty file
  {
    const r = await importCsv(fixture('empty.csv'));
    check('import empty.csv: not imported, 0 people', r.status === 200 && r.body && r.body.imported === 0 && r.body.notAConnectionsFile === true && (await contacts()).length === 0,
      `status ${r.status} ${r.text.slice(0, 200)}`);
  }

  // 4. Broken quote file: good rows kept, broken ones reported by line
  {
    const r = await importCsv(fixture('conn-unclosed.csv'));
    const sk = (r.body && r.body.skipped) || [];
    const lines = sk.map((s) => s.line ?? s.lineNumber ?? s.row).filter((x) => x !== undefined);
    const txt = JSON.stringify(sk);
    const good = r.status === 200 && r.body.imported === 32 && sk.length === 3 && /quote/i.test(txt) && JSON.stringify(lines) === '[8,38,39]';
    check('import conn-unclosed.csv: 32 people, 3 rows skipped (broken quote, short row, duplicate)', good, `status ${r.status} imported=${r.body && r.body.imported} skipped=${txt.slice(0, 300)}`);
    check('contacts count after broken file = 32', (await contacts()).length === 32, `count ${(await contacts()).length}`);
  }

  // 5. Same file twice: no duplicates
  {
    const r = await importCsv(fixture('conn-unclosed.csv'));
    const n = (await contacts()).length;
    check('re-import the same file: 0 new, 32 unchanged, no duplicates', r.body && r.body.imported === 0 && r.body.unchanged === 32 && n === 32, `imported=${r.body && r.body.imported} unchanged=${r.body && r.body.unchanged} count=${n}`);
  }

  // 6. Plain file adds the row the broken file lost; newer file updates and marks the missing person
  {
    const r = await importCsv(fixture('conn-plain.csv'));
    check('import conn-plain.csv: 1 new (the row the broken quote lost), 33 people', r.body && r.body.imported === 1 && (await contacts()).length === 33, `imported=${r.body && r.body.imported} count=${(await contacts()).length}`);
    const r2 = await importCsv(fixture('conn-newer.csv'));
    const all = await contacts();
    const ulf = all.find((c) => c.firstName === 'Ulf' && c.lastName === 'Berg');
    const priya = all.find((c) => c.firstName === 'Priya' && c.lastName === 'Raman');
    check('import conn-newer.csv: 1 new, 2 updated, 1 no longer in file, nobody deleted',
      r2.body && r2.body.imported === 1 && r2.body.updated === 2 && r2.body.missingFromFile === 1 && all.length === 34 && ulf && ulf.inLatestFile === false && priya && priya.email === 'priya.raman@example.com',
      `imported=${r2.body && r2.body.imported} updated=${r2.body && r2.body.updated} missing=${r2.body && r2.body.missingFromFile} count=${all.length} ulf=${ulf && ulf.inLatestFile}`);
  }

  // 7. International names: kept exactly; only the mojibake row is flagged
  {
    const r = await importCsv(fixture('conn-intl.csv'));
    const all = await contacts();
    const intl = all.filter((c) => /-y\d$/.test(c.profileUrl || ''));
    const garbled = intl.filter((c) => c.maybeGarbled).map((c) => c.firstName);
    const cjk = intl.some((c) => c.firstName === '伟' && c.lastName === '张');
    const heb = intl.some((c) => c.firstName === 'דוד');
    check('import conn-intl.csv: 5 people, CJK/Hebrew kept exactly, 1 garbled name flagged', r.body && r.body.imported === 5 && intl.length === 5 && cjk && heb && garbled.length === 1,
      `imported=${r.body && r.body.imported} intl=${intl.length} cjk=${cjk} heb=${heb} garbled=${JSON.stringify(garbled)}`);
  }

  // 8. Names with commas, quotes and unicode, and a script tag (shown as text)
  {
    const csv = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n' +
      '"Mary ""Molly""","Smith, Jr.",https://www.linkedin.com/in/qa-molly,,"Acme ""Widgets"", LLC","VP, Sales",01 Jan 2024\n' +
      '"<img src=x onerror=""window.__qaXss=1"">",Xss,javascript:window.__qaXss2=1,,<b>Bold</b>,<script>window.__qaXss3=1</script>,01 Jan 2024\n' +
      'Zoë,Østergaard,https://www.linkedin.com/in/qa-zoe,,Café Rio,Gérante 🚀,02 Feb 2022\n';
    const r = await importCsv(csv);
    const all = await contacts('?limit=50&q=' + encodeURIComponent('Molly'));
    const molly = (all || []).find((c) => c.firstName === 'Mary "Molly"' && c.lastName === 'Smith, Jr.' && c.company === 'Acme "Widgets", LLC');
    const xss = (await contacts()).find((c) => c.lastName === 'Xss');
    check('import quotes/commas/unicode: fields parsed exactly', r.body && r.body.imported === 3 && !!molly, `imported=${r.body && r.body.imported} molly=${JSON.stringify(all).slice(0, 200)}`);
    check('import: a javascript: URL is dropped', xss && !xss.profileUrl, `profileUrl=${xss && xss.profileUrl}`);
    await reload();
    await nav('#/network/people');
    const rows = await p.waitFor(`document.querySelectorAll('main table tbody tr').length > 3`, 10000);
    check('people view: the imported people are listed', rows, 'no table rows after a reload');
    const fired = await p.eval(`!!(window.__qaXss || window.__qaXss2 || window.__qaXss3)`);
    check('people view: HTML in names is shown as text, never run', !fired, 'an onerror/script handler ran');
    await p.shot(join(SHOTS, 'network-03-people.png'));
    // Every column of the People table is visible at 1400 px (JL-network-4)
    const fit = await p.eval(`(() => { const t = document.querySelector('main table'); if (!t) return null; const box = (t.closest('.ant-table-content') || t.parentElement).getBoundingClientRect();
      return [...t.querySelectorAll('thead th')].filter((th) => th.getBoundingClientRect().right > box.right + 1).map((th) => th.innerText.trim()); })()`);
    check('people table: every column visible in a 1400 px window', Array.isArray(fit) && fit.length === 0, `cut or hidden: ${JSON.stringify(fit)}`);
  }

  // 9. A generated 5,000-row file
  {
    const rows = ['First Name,Last Name,URL,Email Address,Company,Position,Connected On'];
    const firsts = ['Ana', 'Bjørn', 'Chloé', 'O\'Neil', '"Jo, Jr."', 'Nguyễn', '李'];
    for (let i = 0; i < 5000; i++) {
      const f = firsts[i % firsts.length];
      const fq = f.startsWith('"') ? '"""Jo, Jr."""' : f;
      rows.push(`${fq},Big${i},https://www.linkedin.com/in/qa-big-${i},${i % 9 === 0 ? `big${i}@example.com` : ''},"Gen Co ${i % 40}, Inc.","Analyst, Level ${i % 5}",0${1 + (i % 9)} Mar 20${10 + (i % 16)}`);
    }
    const file = join(tmpdir(), `jobleft-qa-5000-${process.pid}.csv`);
    writeFileSync(file, rows.join('\n') + '\n');
    const t0 = Date.now();
    const r = await importCsv(readFileSync(file));
    const ms = Date.now() - t0;
    const h = await api('/health', { headers: {} });
    const n = (await contacts()).length;
    check('import 5,000 rows: all read, service still healthy', r.status === 200 && r.body && r.body.imported === 5000 && h.status === 200 && n >= 5000, `status ${r.status} imported=${r.body && r.body.imported} count=${n} health=${h.status}`);
    check('import 5,000 rows: finishes in under 30 s', ms < 30000, `${ms} ms`);
    const q = await contacts('?limit=50&q=' + encodeURIComponent('Big4999'));
    check('search after 5,000 rows finds the exact person', Array.isArray(q) && q.length === 1 && q[0].lastName === 'Big4999', JSON.stringify(q).slice(0, 200));
  }

  // 10. Company matching against target jobs (jobs added by pasted text, so no crawled company is assumed)
  {
    // Re-import the plain file so its people are "in the latest file"; the targets below come from its company names.
    await importCsv(fixture('conn-plain.csv'));
    const add = async (title, company) => {
      const r = await api('/jobs/external', { method: 'POST', body: { text: `${title}\nCompany: ${company}\n${company} is hiring a ${title.toLowerCase()}. SQL and reporting.` } });
      return r.body && r.body.job ? r.body.job : null;
    };
    const jobs = { kroger: await add('QA Store Data Analyst', 'Kroger'), block: await add('QA Payments Analyst', 'Block'), meta: await add('QA Data Analyst', 'Meta'), kaiser: await add('QA Clinical Analyst', 'Kaiser Permanente') };
    check('targets: 4 jobs added by pasted text', Object.values(jobs).every(Boolean), JSON.stringify(Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, !!v]))));
    // Like one crawled job when the store has any (golden); never assume which.
    if (STATE === 'golden') {
      const s = await api('/jobs/search', { method: 'POST', body: { sort: 'recommended', filter: {}, limit: 1 } });
      const j = s.body && s.body.items && s.body.items[0] && s.body.items[0].job;
      if (j) {
        const l = await api('/tracker/' + encodeURIComponent(j.id), { method: 'PATCH', body: { liked: true } });
        const cov = (await api('/network/coverage')).body || [];
        check('targets: a liked crawled job makes its company a target', l.status === 200 && cov.some((c) => c.companyKey === j.companyKey), `like=${l.status} key=${j.companyKey}`);
      } else skip('targets: a liked crawled job makes its company a target', 'no crawled jobs');
    } else skip('targets: a liked crawled job makes its company a target', 'state is fresh (no crawled jobs)');

    const match = async (key, name) => (await api(`/network/match?companyKey=${encodeURIComponent(key)}&companyName=${encodeURIComponent(name)}`)).body || {};
    const names = (m) => (m.matched || []).map((x) => x.name);
    const kroger = await match('kroger', 'Kroger');
    check('match Kroger: counts "Kroger", "KROGER" and "The Kroger Co."', ['Kroger', 'KROGER', 'The Kroger Co.'].every((n) => names(kroger).includes(n)), JSON.stringify(names(kroger)));
    const block = await match('block', 'Block');
    check('match Block: "Block" counted, "H&R Block" and "H & R Block, Inc." not counted', names(block).includes('Block') && !names(block).some((n) => /H\s*&\s*R/i.test(n)), JSON.stringify(names(block)));
    const meta = await match('meta', 'Meta');
    check('match Meta: "Metaview" is not counted as Meta', names(meta).includes('Meta') && !names(meta).includes('Metaview'), JSON.stringify(names(meta)));
    const kaiser = await match('kaiserpermanente', 'Kaiser Permanente');
    check('match Kaiser Permanente: "Kaiser Aluminum" not counted', names(kaiser).includes('Kaiser Permanente') && !names(kaiser).includes('Kaiser Aluminum'), JSON.stringify(names(kaiser)));

    // The count on the Companies card equals the API count and the matched rows
    const cov = (await api('/network/coverage')).body || [];
    const kc = cov.find((c) => c.companyKey === 'kroger');
    const sum = (kroger.matched || []).reduce((s, x) => s + x.count, 0);
    await nav('#/network/companies');
    await p.waitFor(`/You know \\d+ (people|person) at Kroger/.test(document.body.innerText)`, 10000);
    const t = await text();
    const m = /You know (\d+) (?:people|person) at Kroger/.exec(t);
    check('companies view: Kroger count equals API coverage and match rows', kc && m && Number(m[1]) === kc.count && kc.count === sum, `ui=${m && m[1]} coverage=${kc && kc.count} matched=${sum}`);
    check('companies view: "Who to contact first" gives reasons', /Who to contact first/.test(t) && /Company in your file: "/.test(t), t.slice(0, 200));
    await p.shot(join(SHOTS, 'network-02-companies.png'));
    // A company where the file has exactly one person must not offer "Add top 2" (JL-network-1)
    const one = await p.eval(`(() => { const c = [...document.querySelectorAll('main .jl-card-box, main .ant-card')].find((x) => /You know 1 person at /.test(x.innerText)); if (!c) return null;
      return [...c.querySelectorAll('button')].map((x) => x.innerText.trim()).find((s) => /^Add /.test(s)) || ''; })()`);
    if (one === null) skip('companies view: the add button fits a company with 1 person', 'no company with exactly 1 person');
    else check('companies view: the add button fits a company with 1 person', !/top 2/i.test(one), `button says "${one}"`);
  }

  // 11. People edits persist; delete then re-import brings the person back fresh
  {
    const maria = (await contacts('?limit=50&q=' + encodeURIComponent('Maria Delgado'))).find((c) => c.profileUrl && c.profileUrl.endsWith('mdelgado-x1'));
    const r1 = await api('/network/contacts/' + maria.id, { method: 'PATCH', body: { stage: 'messaged', note: 'QA note ✓ «x»', followUpOn: '2020-01-02', inPlan: true } });
    await reload();
    await nav('#/network/followups');
    await p.waitFor(`/Maria Delgado/.test(document.body.innerText)`, 10000);
    const t = await text();
    const due = (await contacts('?due=true')).map((c) => c.id);
    check('people: stage, note, follow-up and plan saved and still there after reload', r1.status === 200 && /Maria Delgado/.test(t) && due.includes(maria.id), `patch=${r1.status} due=${due.length}`);
    // The People filter "Follow-up due" must list the people whose follow-up is due (JL-network-7)
    const f = await contacts('?limit=50&stage=follow_up_due');
    check('people filter "Follow-up due" lists every person whose follow-up is due', Array.isArray(f) && due.every((id) => f.some((c) => c.id === id)), `due=${due.length} filter=${Array.isArray(f) ? f.length : JSON.stringify(f).slice(0, 120)}`);
    const d = await api('/network/contacts/' + maria.id, { method: 'DELETE' });
    const gone = !(await contacts()).some((c) => c.id === maria.id);
    const r = await importCsv(fixture('conn-plain.csv'));
    const back = (await contacts()).find((c) => c.profileUrl && c.profileUrl.endsWith('mdelgado-x1'));
    check('people: delete then re-import brings the person back once, stage and note reset', d.status === 200 && gone && r.body.imported === 1 && back && back.stage === 'to_contact' && !back.note,
      `delete=${d.status} gone=${gone} imported=${r.body && r.body.imported} back=${back && back.stage}`);
  }

  // 12. Drafts are copy-only; no request leaves the computer from the page during import and drafts
  {
    await nav('#/network/people');
    await p.waitFor(`document.querySelectorAll('main table tbody tr').length > 3`, 10000);
    p.clearRequests();
    await nav('#/network/import');
    await upload(fixture('conn-plain.csv'), 'Connections.csv');
    await p.waitFor(`/Read 33 people/.test(document.body.innerText)`, 10000);
    const c = (await contacts('?limit=5&q=' + encodeURIComponent('Maria Delgado')))[0];
    const t = await api(`/network/contacts/${c.id}/draft`, { method: 'POST', body: { variant: 'short', template: true } });
    check('draft (plain template): text uses the contact first name, no AI needed', t.status === 200 && t.body && /Maria/.test(t.body.text || ''), `status ${t.status} ${t.text.slice(0, 200)}`);
    await nav('#/network/people');
    await p.waitFor(`document.querySelectorAll('main table tbody button').length > 3`, 10000);
    const opened = await p.eval(`(() => { const b = [...document.querySelectorAll('main table tbody button')].find((x) => x.innerText.trim() === 'Draft' && x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true; })()`);
    await p.waitFor(`document.querySelector('.ant-modal')`, 5000);
    await sleep(800);
    const modal = await p.eval(`(document.querySelector('.ant-modal') || {}).innerText || ''`);
    const sendBtn = await p.eval(`[...document.querySelectorAll('.ant-modal button')].map((x) => x.innerText.trim()).filter((s) => /^send( (it|message|now|email))?$/i.test(s))`);
    check('draft dialog: copy only, no Send button, says it never sends', opened && sendBtn.length === 0 && /never/i.test(modal), `opened=${opened} send=${JSON.stringify(sendBtn)} text=${modal.slice(0, 160)}`);
    await p.press('Escape');
    const out = nonLoopback(p.requests());
    check('no page request to linkedin.com or any non-loopback host during import and drafts', out.length === 0, JSON.stringify(out.slice(0, 5)));
  }

  // 13. Question bank CRUD persists (uses a job added by pasted text, so any state works)
  {
    const job = await api('/jobs/external', { method: 'POST', body: { text: 'QA Bank Analyst\nCompany: QA Bank Co\nQA Bank Co is hiring an analyst. SQL.' } });
    const jobId = job.body && job.body.job && job.body.job.id;
    const q = await api('/practice/items', { method: 'POST', body: { jobId, kind: 'question', question: 'QA: tell me about a hard bug?', answer: 'First answer' } });
    const dbf = await api('/practice/items', { method: 'POST', body: { jobId, kind: 'debrief', notes: 'QA debrief: asked about SQL joins.' } });
    const e = await api('/practice/items/' + (q.body && q.body.id), { method: 'PATCH', body: { answer: 'Edited answer ✓', notes: 'QA note' } });
    await reload();
    await nav('#/interview');
    await p.clickText('My question bank', 'main');
    await p.waitFor(`/Edited answer/.test(document.body.innerText)`, 10000);
    const t1 = await text();
    check('question bank: add, edit, debrief saved and shown after reload', q.status === 200 && dbf.status === 200 && e.status === 200 && /Edited answer/.test(t1) && /QA debrief/.test(t1),
      `add=${q.status} debrief=${dbf.status} edit=${e.status}`);
    const del = await api('/practice/items/' + q.body.id, { method: 'DELETE' });
    await api('/practice/items/' + dbf.body.id, { method: 'DELETE' });
    const left = ((await api('/practice/items')).body || []).filter((i) => i.jobId === jobId).length;
    await reload();
    await nav('#/interview');
    await p.clickText('My question bank', 'main');
    await sleep(1200);
    const t2 = await text();
    check('question bank: delete removes the item, also after reload', del.status === 200 && left === 0 && !/Edited answer ✓/.test(t2), `delete=${del.status} left=${left}`);
  }

  // 14. Chat history persists (compares the stored list with the screen after a reload)
  {
    const chats = (await api('/ai/chats')).body || [];
    if (!chats.length) skip('assistant: chat history after reload', 'no saved conversation on this instance');
    else {
      await reload();
      await nav('#/assistant');
      await sleep(1200);
      const t = await text();
      const missing = chats.slice(0, 10).filter((c) => !t.includes((c.title || '').slice(0, 30)));
      check('assistant: every saved conversation is listed after reload', missing.length === 0, `missing ${JSON.stringify(missing.map((c) => c.title))}`);
    }
  }

  // 15. Assistant proposals need a confirmation (only when an AI provider is connected)
  {
    const s = (await api('/ai/settings')).body || {};
    let connected = !!s.provider;
    if (s.provider === 'publik') connected = ((await api('/publik')).body || {}).state === 'connected';
    if (!connected) skip('assistant: a status change is only proposed until confirmed', 'no AI provider connected');
    else {
      const ext = (await api('/tracker?view=external')).body;
      const entry = ext && ext.items && ext.items.find((i) => /QA Store Data Analyst/.test(i.job.title));
      const before = entry ? entry.entry.status : undefined;
      const r = await api('/ai/chat', { method: 'POST', body: { requestId: 'qa-net-' + Date.now(), messages: [{ role: 'user', content: 'Set the tracker status of my "QA Store Data Analyst" job at Kroger to Applied.' }] }, raw: true });
      const events = r.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
      const err = events.find((e) => e.type === 'error');
      if (!entry) skip('assistant: a status change is only proposed until confirmed', 'test job not found in tracker');
      else if (err) skip('assistant: a status change is only proposed until confirmed', `AI refused: ${err.error && err.error.message}`);
      else {
        const after = ((await api('/tracker?view=external')).body.items.find((i) => i.job.id === entry.job.id) || {}).entry;
        check('assistant: nothing changes before the person confirms', after && after.status === before, `before=${before} after=${after && after.status}`);
        const raw = r.text;
        const prop = /"(prop_[A-Za-z0-9]+)"/.exec(raw);
        const acts = [...raw.matchAll(/"(act_[A-Za-z0-9]+)"/g)].map((m) => m[1]);
        if (!prop || !acts.length) skip('assistant: confirming a proposal applies it', 'the answer carried no proposal');
        else {
          const a = await api('/ai/proposals/' + prop[1], { method: 'POST', body: { approveActionIds: [...new Set(acts)] } });
          const now = ((await api('/tracker?view=external')).body.items.find((i) => i.job.id === entry.job.id) || {}).entry;
          check('assistant: confirming a proposal applies it', a.status === 200 && now && now.status === 'applied', `approve=${a.status} status=${now && now.status}`);
          await api('/tracker/' + encodeURIComponent(entry.job.id), { method: 'PATCH', body: { status: before ?? null } });
        }
      }
    }
  }

  // 16. API refusals in plain words, never a crash
  {
    const someone = (await contacts('?limit=1'))[0];
    const probes = [
      ['no token', () => fetch(API + '/network/contacts').then(async (r) => ({ status: r.status, text: await r.text() })), 401],
      ['another origin', () => fetch(API + '/network/contacts', { headers: { 'x-jobleft-token': TOKEN, origin: 'https://evil.example' } }).then(async (r) => ({ status: r.status, text: await r.text() })), 403],
      ['unknown contact id', () => api('/network/contacts/c_qa_nope', { method: 'PATCH', body: { stage: 'met' } }), 404],
      ['wrong type', () => api('/network/contacts/' + someone.id, { method: 'PATCH', body: { inPlan: 'yes' } }), 400],
      ['bad JSON', () => api('/network/contacts/' + someone.id, { method: 'PATCH', body: '{nope', headers: { 'content-type': 'application/json' } }), 400],
      ['wrong media type for import', () => api('/network/import', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), 415],
      ['giant import body', () => api('/network/import', { method: 'POST', body: 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n' + 'A,B,,,C,D,01 Jan 2020\n'.repeat(700000), headers: { 'content-type': 'text/csv' } }), 413],
      ['giant chat body', () => api('/ai/chat', { method: 'POST', body: { requestId: 'qa', messages: [{ role: 'user', content: 'x'.repeat(3_000_000) }] } }), 413],
      ['unknown proposal', () => api('/ai/proposals/prop_qa_nope', { method: 'POST', body: { approveActionIds: ['act_x'] } }), 404],
      ['unknown practice item', () => api('/practice/items/pi_qa_nope', { method: 'DELETE' }), 404],
    ];
    for (const [name, fn, want] of probes) {
      const r = await fn();
      let msg = '';
      try { msg = JSON.parse(r.text).error.message; } catch { /* keep empty */ }
      const plain = msg && !/\bat \S+:\d+|TypeError|ReferenceError|SQLITE|stack/i.test(r.text);
      check(`api refuses (${name}) with ${want} and a plain message`, r.status === want && plain, `status ${r.status} ${r.text.slice(0, 160)}`);
    }
    const h = await api('/health', { headers: {} });
    check('health still 200 after the refusals', h.status === 200, `status ${h.status}`);
  }

  // 17. No banned words on these screens
  {
    const bad = {};
    for (const h of ['#/network/companies', '#/network/people', '#/network/plan', '#/network/followups', '#/network/import', '#/interview', '#/assistant']) {
      await nav(h);
      const a = await p.eval(AUDIT);
      if (a.banned.length) bad[h] = a.banned;
    }
    check('no "credits", "undefined", "null", "NaN" or "[object Object]" on Network, Interview and Assistant', Object.keys(bad).length === 0, JSON.stringify(bad).slice(0, 400));
    const errs = p.errors().filter((e) => !/favicon/i.test(e));
    check('no uncaught page errors on these screens', errs.length === 0, errs.slice(0, 3).join(' | '));
  }
} catch (e) {
  fail('scenario crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e);
} finally {
  await b.close();
  console.log(`# network scenario finished in ${Math.round((Date.now() - T0) / 1000)} s`);
}
process.exit(failed ? 1 : 0);
