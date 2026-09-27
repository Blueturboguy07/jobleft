// Replay scenario for the Resume area (findings: findings/resume.md, IDs JL-resume-<n>).
// Plain Node 24 ES module, no packages. Reads its target from the environment (see scenarios/README.md).
// Prints one line per check: "CHECK ok <name>", "CHECK FAIL <name>: <why>" or "CHECK skip <name>: <why>".
// Exit code 1 when any check failed. Works on Windows: no Mac paths, no external tools (a tiny ZIP reader for .docx
// and a tiny text reader for the app's own Helvetica PDFs are built in).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const { launch, AUDIT } = await import(new URL('../bin/driver.mjs', import.meta.url));

const ENV = {
  url: process.env.JOBLEFT_QA_URL,
  api: (process.env.JOBLEFT_QA_API || '').replace(/\/+$/, ''),
  token: process.env.JOBLEFT_QA_TOKEN,
  fixtures: process.env.JOBLEFT_QA_FIXTURES,
  shots: process.env.JOBLEFT_QA_SHOTS,
  state: process.env.JOBLEFT_QA_STATE || 'golden',
};

let failures = 0;
const ok = (name) => console.log(`CHECK ok ${name}`);
const fail = (name, why) => { failures++; console.log(`CHECK FAIL ${name}: ${String(why).replace(/\s+/g, ' ').slice(0, 600)}`); };
const skip = (name, why) => console.log(`CHECK skip ${name}: ${why}`);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) ok(name);
    else if (r && r.skip) skip(name, r.skip);
    else fail(name, r === false ? 'condition false' : r);
  } catch (e) { if (e && e.skip) skip(name, e.skip); else fail(name, 'threw ' + (e && e.message ? e.message : e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [k, v] of Object.entries({ JOBLEFT_QA_URL: ENV.url, JOBLEFT_QA_API: ENV.api, JOBLEFT_QA_TOKEN: ENV.token, JOBLEFT_QA_FIXTURES: ENV.fixtures })) {
  if (!v) { fail('environment', `${k} is not set`); process.exit(1); }
}
if (ENV.shots) { try { mkdirSync(ENV.shots, { recursive: true }); } catch {} }
const FX = (f) => join(ENV.fixtures, f);
const MIME_PDF = 'application/pdf';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ---------- the facts printed in the fixtures (the Jordan resumes) ----------
const FILE = {
  summary: 'Software engineer with 3 years of backend experience building APIs and data pipelines.',
  skills: ['TypeScript', 'JavaScript', 'Python', 'React', 'Node.js', 'PostgreSQL', 'Docker', 'AWS', 'Git', 'REST APIs', 'SQL', 'Linux'],
  jobs: [
    { company: 'Northwind Sample Labs', title: 'Software Engineer', start: '2023-06', end: null, current: true },
    { company: 'Contoso Example Corp', title: 'Junior Developer', start: '2021-01', end: '2023-05', current: false },
  ],
  school: { name: 'Sample State University', degree: 'B.S.', major: 'Computer Science', start: '2016-08', end: '2020-05', gpa: '3.7' },
  wholeBullet: 'Maintained React dashboards used by 12 engineers across 3 teams.',
};

// ---------- API helpers ----------
async function api(path, { method = 'GET', body, headers = {}, raw = false, token = ENV.token } = {}) {
  const h = { ...headers };
  if (token) h['x-jobleft-token'] = token;
  let b = body;
  if (b !== undefined && !(b instanceof Uint8Array) && typeof b !== 'string') { b = JSON.stringify(b); h['content-type'] = 'application/json'; }
  const r = await fetch(ENV.api + path, { method, headers: h, body: b });
  if (raw) return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const upload = (buf, name, type) => api('/resumes/import', { method: 'POST', body: buf, headers: { 'content-type': type, 'x-jobleft-filename': name } });
const errMsg = (r) => (r && r.body && r.body.error && r.body.error.message) || (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
const plainWords = (msg) => typeof msg === 'string' && msg.length >= 10 && !/(TypeError|ReferenceError|SyntaxError|\bat \S+:\d+|\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|ENOENT|EACCES|stack)/.test(msg);
const listResumes = async () => (await api('/resumes')).body;
const getResume = async (id) => (await api('/resumes/' + id)).body;
const section = (doc, kind) => doc.sections.find((s) => s.kind === kind);
const strip = (s) => String(s ?? '').normalize('NFC').replace(/[‐-―]/g, '-').replace(/\s+/g, '');
const profileClean = (p) => { const c = structuredClone(p); delete c.updatedAt; delete c.version; return JSON.stringify(c); };
// keep only characters the PDF's standard font can draw, so export/grade checks test the text and not JL-resume-7
const LAT = (t) => (typeof t === 'string' ? t.replace(/[^\u0000-\u024F\u2010-\u2027\u20AC]/g, '').replace(/\s{2,}/g, ' ').trim() : t);
function latinOnly(doc) {
  const d = structuredClone(doc);
  for (const s of d.sections) { s.text = LAT(s.text); for (const i of s.items) { i.heading = LAT(i.heading); i.subheading = LAT(i.subheading); i.bullets = i.bullets.map(LAT).filter(Boolean); i.tags = i.tags.map(LAT).filter(Boolean); } }
  return d;
}

// ---------- .docx text (tiny ZIP reader) ----------
function zipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42); const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (name === wanted) {
      const ln = buf.readUInt16LE(local + 26), lx = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + ln + lx, local + 30 + ln + lx + csize);
      return method === 8 ? inflateRawSync(data) : Buffer.from(data);
    }
    off += 46 + nlen + xlen + clen;
  }
  throw new Error('no ' + wanted + ' in the zip');
}
function docxText(buf) {
  const xml = zipEntry(buf, 'word/document.xml').toString('utf8');
  return xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// ---------- PDF text for the app's own PDFs (standard fonts, WinAnsi literal strings) ----------
const WIN = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x89: '‰', 0x8b: '‹', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™', 0x9b: '›' };
function pdfText(buf) {
  const bin = buf.toString('latin1'); let out = ''; const re = /stream\r?\n/g; let m;
  while ((m = re.exec(bin))) {
    if (bin.slice(Math.max(0, m.index - 3), m.index) === 'end') continue;
    const start = m.index + m[0].length; const end = bin.indexOf('endstream', start); if (end < 0) break;
    const dict = bin.slice(Math.max(0, m.index - 300), m.index);
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict.slice(dict.lastIndexOf('<<')))) { try { data = inflateSync(data); } catch { continue; } }
    const s = data.toString('latin1'); if (!/\b(Tj|TJ)\b/.test(s)) continue;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '(') {
        let depth = 1, j = i + 1, str = '';
        while (j < s.length && depth > 0) {
          const d = s[j];
          if (d === '\\') {
            const e = s[j + 1];
            if (/[0-7]/.test(e)) { let oct = e; let k = j + 2; while (k < j + 4 && /[0-7]/.test(s[k])) oct += s[k++]; str += String.fromCharCode(parseInt(oct, 8)); j = k; continue; }
            str += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[e] ?? e; j += 2; continue;
          }
          if (d === '(') depth++; else if (d === ')') { depth--; if (depth === 0) break; }
          str += d; j++;
        }
        out += [...str].map((ch) => WIN[ch.charCodeAt(0)] ?? ch).join('');
        i = j + 1;
      } else if (c === '<' && s[i + 1] !== '<') {
        const j = s.indexOf('>', i); const hex = s.slice(i + 1, j).replace(/\s+/g, '');
        let str = ''; for (let k = 0; k + 1 < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
        out += [...str].map((ch) => WIN[ch.charCodeAt(0)] ?? ch).join('');
        i = j + 1;
      } else if (c === '<' && s[i + 1] === '<') { i += 2;
      } else if (c === 'T' && (s[i + 1] === 'j' || s[i + 1] === 'J' || s[i + 1] === '*' || s[i + 1] === 'd' || s[i + 1] === 'D')) { out += ' '; i += 2; }
      else if (c === "'" || c === '"') { out += ' '; i++; }
      else i++;
    }
    out += '\n';
  }
  return out;
}

// ---------- UI helpers ----------
function fileExpr(path, name, type) {
  const b64 = readFileSync(path).toString('base64');
  return `(() => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const inp = [...document.querySelectorAll('input[type=file]')].pop(); if (!inp) return 'no file input';
    const dt = new DataTransfer(); dt.items.add(new File([u], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })); inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`;
}
const openModalText = `[...document.querySelectorAll('.ant-modal-wrap')].filter((w) => getComputedStyle(w).display !== 'none').map((w) => w.innerText).join(' #### ')`;
async function shot(p, name) { if (!ENV.shots) return; try { await p.shot(join(ENV.shots, `resume-${name}.png`)); } catch {} }
async function leaveEditorSafely(p) {
  try {
    const dirty = await p.eval(`!!document.querySelector('main') && document.querySelector('main').innerText.includes('unsaved changes')`);
    if (dirty) {
      await p.click('button[aria-label="Close the editor"]'); await sleep(500);
      await p.clickText('Discard changes'); await sleep(500);
    }
  } catch {}
}
async function openApp(p, hash) {
  await leaveEditorSafely(p);
  await p.goto('about:blank');
  await p.goto(ENV.url);
  await p.waitFor(`document.body && document.body.innerText.length > 50 && !!document.querySelector('nav, aside, [role=navigation], main')`, 20000);
  if (hash) { await p.eval(`location.hash = ${JSON.stringify(hash)}`); await sleep(1500); }
}
async function gotoResumeList(p) {
  await openApp(p);
  if (!(await p.clickText('Resume'))) throw (ENV.state === 'fresh' ? { skip: 'no Resume link yet (first-run onboarding)' } : new Error('no Resume link in the navigation'));
  await p.waitFor(`location.hash.startsWith('#/resume') && /You have \\d+ resume/.test(document.querySelector('main')?.innerText || '')`, 15000);
}

// ---------- the run ----------
const created = new Set();
let profileAtStart = null;
const b = await launch();
try {
  const p = await b.page();
  await p.size(1400, 900);

  await check('health route answers without a token', async () => {
    const r = await api('/health', { token: null });
    return (r.status === 200 && r.body && r.body.app === 'jobleft') || `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`;
  });
  profileAtStart = (await api('/profile')).body;
  const hasProfile = profileAtStart && typeof profileAtStart === 'object' && profileAtStart.personal;

  // ---- A. every fixture, through the route the Add resume dialog uses ----
  const baseCount0 = (await listResumes()).length;
  const good = {};
  for (const [key, file, type] of [['one-column', 'jordan-one-column.pdf', MIME_PDF], ['two-column', 'jordan-two-column.pdf', MIME_PDF], ['layout-table', 'jordan-layout-table.docx', MIME_DOCX]]) {
    await check(`upload ${file}: read 2 jobs, 12 skills, 1 school with right dates`, async () => {
      const r = await upload(readFileSync(FX(file)), file, type);
      if (r.status !== 200) return `status ${r.status}: ${errMsg(r)}`;
      const res = r.body.resume || r.body; created.add(res.id); good[key] = res;
      const c = res.importReport && res.importReport.counts;
      if (!c || c.jobs !== 2 || c.skills !== 12 || c.education !== 1) return `import counts ${JSON.stringify(c)}`;
      const exp = section(res.document, 'experience'); const edu = section(res.document, 'education');
      if (!exp) return 'no Experience section';
      for (const j of FILE.jobs) {
        const it = exp.items.find((i) => (i.heading || '').includes(j.company) || (i.subheading || '').includes(j.company));
        if (!it) return `job ${j.company} missing`;
        if (it.startDate !== j.start || (it.endDate ?? null) !== j.end || !!it.current !== j.current) return `${j.company} dates ${it.startDate}–${it.endDate} current=${it.current}`;
      }
      const s = edu && edu.items.find((i) => (i.heading || '').includes(FILE.school.name) || (i.subheading || '').includes(FILE.school.name));
      if (!s || s.startDate !== FILE.school.start || s.endDate !== FILE.school.end) return `school ${JSON.stringify(s && [s.heading, s.startDate, s.endDate])}`;
      if (key === 'layout-table' && !exp.items.some((i) => i.bullets.includes(FILE.wholeBullet))) return `Word runs not joined: bullet "${FILE.wholeBullet}" is not whole`;
      return true;
    });
  }
  const refusals = [
    ['scanned.pdf', readFileSync(FX('scanned.pdf')), 'scanned.pdf', MIME_PDF, /scan|no text|picture/i],
    ['locked.pdf', readFileSync(FX('locked.pdf')), 'locked.pdf', MIME_PDF, /password/i],
    ['empty.pdf', readFileSync(FX('empty.pdf')), 'empty.pdf', MIME_PDF, /empty|0 bytes/i],
    ['plain text as .txt', Buffer.from('Jordan Testwell\nresume as text\n'), 'resume.txt', 'text/plain', /PDF|Word/i],
    ['plain text named .pdf', Buffer.from('Jordan Testwell\nresume as text\n'), 'fake.pdf', MIME_PDF, /PDF|text/i],
    ['broken .docx', Buffer.from('PK\x03\x04 not really a zip archive'), 'fake.docx', MIME_DOCX, /Word|document/i],
    ['11 MB body', Buffer.concat([readFileSync(FX('jordan-one-column.pdf')), Buffer.alloc(11 * 1024 * 1024, 0x20)]), 'big.pdf', MIME_PDF, /10 MB|large/i],
  ];
  for (const [label, buf, name, type, want] of refusals) {
    await check(`upload refused in plain words: ${label}`, async () => {
      const r = await upload(buf, name, type);
      if (r.status < 400 || r.status >= 500) { if (r.status === 200) created.add((r.body.resume || r.body).id); return `status ${r.status} (expected a 4xx refusal)`; }
      const m = errMsg(r);
      return (plainWords(m) && want.test(m)) || `status ${r.status}, message "${m}"`;
    });
  }
  await check('upload with no file is refused in plain words', async () => {
    const r = await api('/resumes/import', { method: 'POST' });
    return (r.status >= 400 && r.status < 500 && plainWords(errMsg(r))) || `status ${r.status} "${errMsg(r)}"`;
  });
  await check('refused uploads store nothing and the service stays up', async () => {
    const n = (await listResumes()).length; const h = await api('/health', { token: null });
    return (n === baseCount0 + Object.keys(good).length && h.status === 200) || `resumes ${n} (expected ${baseCount0 + Object.keys(good).length}), health ${h.status}`;
  });

  // ---- B. an upload is the file (JL-resume-1) and the same file twice (JL-resume-3) ----
  await check('uploaded resume keeps the file\'s own summary and all 12 skills (JL-resume-1)', async () => {
    const d = good['one-column'] && (await getResume(good['one-column'].id)).document; if (!d) return { skip: 'one-column upload failed' };
    const sum = section(d, 'summary'); const sk = section(d, 'skills');
    const tags = sk ? sk.items.flatMap((i) => i.tags) : [];
    const missing = FILE.skills.filter((s) => !tags.includes(s));
    if (!sum || strip(sum.text) !== strip(FILE.summary)) return `summary is "${sum && sum.text}"`;
    return missing.length === 0 || `skills missing from the resume: ${missing.join(', ')}`;
  });
  await check('same file uploaded twice gets a distinct name (JL-resume-3)', async () => {
    const r = await upload(readFileSync(FX('jordan-one-column.pdf')), 'jordan-one-column.pdf', MIME_PDF);
    if (r.status !== 200) return `status ${r.status}`;
    const res = r.body.resume || r.body; created.add(res.id); good.dup = res;
    const same = (await listResumes()).filter((x) => x.name === res.name).length;
    return same === 1 || `${same} resumes are named "${res.name}"`;
  });

  // ---- C. list, rename, primary, delete ----
  const target = good.dup || good['two-column'];
  await check('rename keeps emoji and Arabic text', async () => {
    const name = 'QA renamed 🎯 سيرة';
    const r = await api('/resumes/' + target.id, { method: 'PATCH', body: { name, targetTitle: 'Backend engineer' } });
    const g = await getResume(target.id);
    return (r.status === 200 && g.name === name && g.targetTitle === 'Backend engineer') || `status ${r.status}, name now "${g.name}"`;
  });
  await check('rename refuses empty and over-long names in plain words', async () => {
    const a = await api('/resumes/' + target.id, { method: 'PATCH', body: { name: '' } });
    const c = await api('/resumes/' + target.id, { method: 'PATCH', body: { name: 'N'.repeat(201) } });
    return (a.status === 400 && c.status === 400 && plainWords(errMsg(a)) && plainWords(errMsg(c))) || `empty → ${a.status}, 201 chars → ${c.status}`;
  });
  await check('make primary leaves exactly one primary', async () => {
    const r = await api('/resumes/' + target.id, { method: 'PATCH', body: { isPrimary: true } });
    const prim = (await listResumes()).filter((x) => x.isPrimary);
    return (r.status === 200 && prim.length === 1 && prim[0].id === target.id) || `status ${r.status}, primaries ${prim.map((x) => x.name).join(', ')}`;
  });
  await check('list screen: renamed resume shows after reload and the count line matches the rows', async () => {
    await gotoResumeList(p);
    const t = await p.eval(`document.querySelector('main').innerText`);
    const rows = await p.eval(`document.querySelectorAll('tbody tr.ant-table-row').length`);
    const m = /You have (\d+) resumes? and (\d+) tailored/.exec(t);
    await shot(p, 'list');
    if (!t.includes('QA renamed 🎯 سيرة')) return 'renamed resume not in the list';
    if (!m) return 'no count line';
    return (Number(m[1]) + Number(m[2]) === rows) || `count line says ${m[1]}+${m[2]}, table has ${rows} rows`;
  });
  await check('deleting the primary resume removes it and another becomes primary', async () => {
    const r = await api('/resumes/' + target.id, { method: 'DELETE' });
    const g = await api('/resumes/' + target.id);
    const list = await listResumes(); const prim = list.filter((x) => x.isPrimary);
    if (r.status >= 300) return `delete status ${r.status}: ${errMsg(r)}`;
    created.delete(target.id);
    return (g.status === 404 && (list.length === 0 || prim.length === 1)) || `GET after delete ${g.status}, primaries ${prim.length}`;
  });
  await check('unknown resume ids get 404 in plain words (GET, PATCH, DELETE, export)', async () => {
    const rs = [await api('/resumes/res_qa_nope'), await api('/resumes/res_qa_nope', { method: 'PATCH', body: { name: 'x' } }), await api('/resumes/res_qa_nope', { method: 'DELETE' }), await api('/resumes/res_qa_nope/export?format=pdf')];
    const bad = rs.filter((r) => r.status !== 404 || !plainWords(errMsg(r)));
    return bad.length === 0 || bad.map((r) => `${r.status} "${errMsg(r)}"`).join('; ');
  });

  // ---- D. the Add resume dialog in the UI ----
  await check('UI upload: "Resume added" dialog, honest skill lists (JL-resume-2), "Keep my profile" changes nothing', async () => {
    const before = profileClean((await api('/profile')).body);
    await gotoResumeList(p);
    await p.clickText('Add resume');
    if (!(await p.waitFor(`!!document.querySelector('input[type=file]')`, 8000))) return 'no file input in the Add resume dialog';
    const set = await p.eval(fileExpr(FX('jordan-two-column.pdf'), 'jordan-two-column.pdf', MIME_PDF));
    if (set !== 'ok') return set;
    if (!(await p.waitFor(`/Resume added|cannot|Use a PDF/.test(${openModalText})`, 20000))) return 'no result dialog after upload';
    const t = await p.eval(openModalText); await shot(p, 'upload-dialog');
    const after = await listResumes(); const mine = after.filter((x) => x.file && x.file.fileName === 'jordan-two-column.pdf').sort((a, z) => a.createdAt < z.createdAt ? 1 : -1)[0];
    if (mine) created.add(mine.id);
    if (!/Resume added/.test(t)) return `dialog says "${t.slice(0, 200)}"`;
    const audit = await p.eval(AUDIT);
    if (t.includes('Keep my profile as it is')) { await p.clickText('Keep my profile as it is'); await sleep(1500); }
    else { await p.press('Escape'); await sleep(500); }
    const same = profileClean((await api('/profile')).body) === before;
    const added = /Skills added: ([^\n]+)/.exec(t); const removed = /Skills you removed[^:]*: ([^\n]+)/.exec(t);
    const both = added && removed ? added[1].split(', ').filter((s) => removed[1].split(', ').includes(s)) : [];
    if (audit.banned.length) return 'banned words: ' + audit.banned.join(' | ');
    if (!same) return '"Keep my profile as it is" changed the profile';
    return both.length === 0 || `the dialog lists the same skills as both "added" and "removed from your profile": ${both.slice(0, 5).join(', ')}`;
  });

  // ---- E. editor: build from profile, save, reload, unsaved guard ----
  let fromProfileId = null;
  await check('editor: "Start from my profile" resume saves a summary edit that survives a reload', async () => {
    await gotoResumeList(p);
    await p.clickText('Add resume'); await sleep(500);
    if (!(await p.clickText('Start from my profile'))) return 'no "Start from my profile"';
    await sleep(500);
    if (!(await p.clickText('Create resume'))) return 'no "Create resume"';
    if (!(await p.waitFor(`/^#\\/resume\\/res_/.test(location.hash)`, 10000))) return 'editor did not open';
    fromProfileId = (await p.eval('location.hash')).split('/').pop().split('?')[0]; created.add(fromProfileId);
    if (!(await p.waitFor(`!!document.querySelector('textarea[aria-label="Summary text"]')`, 5000))) return { skip: 'the profile has no summary, so the new resume has no summary box' };
    const text = 'Data analyst who writes clear reports.';
    await p.click('textarea[aria-label="Summary text"]');
    await p.eval(`(() => { const e = document.querySelector('textarea[aria-label="Summary text"]'); e.focus(); e.select(); })()`);
    await p.type(text);
    await p.clickText('Save');
    const saved = await p.waitFor(`!document.querySelector('main').innerText.includes('unsaved changes')`, 10000);
    if (!saved) { const m = await p.eval(`document.querySelector('main').innerText.slice(0, 400)`); await leaveEditorSafely(p); return 'save failed: ' + m; }
    await openApp(p, '#/resume/' + fromProfileId);
    await p.waitFor(`!!document.querySelector('textarea[aria-label="Summary text"]')`, 10000);
    const v = await p.eval(`document.querySelector('textarea[aria-label="Summary text"]')?.value`);
    await shot(p, 'editor-after-reload');
    return v === text || `after reload the summary is "${v}"`;
  });
  await check('editor: closing with unsaved changes asks first', async () => {
    if (!fromProfileId) return { skip: 'no resume from the profile' };
    await openApp(p, '#/resume/' + fromProfileId);
    if (!(await p.waitFor(`!!document.querySelector('textarea[aria-label="Summary text"]')`, 8000))) return { skip: 'no summary box' };
    await p.click('textarea[aria-label="Summary text"]'); await p.type(' unsaved');
    await p.click('button[aria-label="Close the editor"]'); await sleep(700);
    const t = await p.eval(openModalText);
    if (/Discard/i.test(t)) { await p.clickText('Discard changes'); await sleep(500); }
    return /unsaved changes/i.test(t) || 'no confirm before closing with unsaved changes';
  });
  await check('editor accepts ordinary words the person types, e.g. "Agile", "Berlin" (JL-resume-25)', async () => {
    if (!fromProfileId) return { skip: 'no resume from the profile' };
    const d0 = await getResume(fromProfileId); const doc = structuredClone(d0.document);
    const sum = section(doc, 'summary'); if (!sum) return { skip: 'no summary section' };
    sum.text = 'Data analyst for Agile teams in Berlin.';
    const r = await api('/resumes/' + fromProfileId, { method: 'PATCH', body: { document: doc } });
    await api('/resumes/' + fromProfileId, { method: 'PATCH', body: { document: d0.document } });
    return r.status === 200 || `status ${r.status}: ${errMsg(r)}`;
  });
  await check('PDF export and grade work for the profile\'s own characters (JL-resume-7)', async () => {
    const c = await api('/resumes', { method: 'POST', body: { name: 'qa-profile-characters' } });
    if (c.status !== 200) return `could not build a resume from the profile: ${c.status} ${errMsg(c)}`;
    const id = (c.body.resume || c.body).id; created.add(id);
    const r = await api(`/resumes/${id}/export?format=pdf`, { raw: true });
    const g = await api(`/resumes/${id}/ats-check`, { method: 'POST' });
    return (r.status === 200 && g.status === 200) || `export ${r.status}, grade ${g.status}: ${r.status !== 200 ? r.buf.toString().slice(0, 240) : errMsg(g)}`;
  });
  await check('an uploaded resume can be saved unchanged (JL-resume-5)', async () => {
    const r0 = good['one-column'] && (await getResume(good['one-column'].id)); if (!r0) return { skip: 'no upload' };
    const r = await api('/resumes/' + r0.id, { method: 'PATCH', body: { document: r0.document } });
    return r.status === 200 || `status ${r.status}: ${errMsg(r)}`;
  });

  // ---- F. readability grade follows the text; report has no program codes ----
  await check('readability grade changes when a section is removed', async () => {
    if (!fromProfileId) return { skip: 'no resume from the profile' };
    const orig = await getResume(fromProfileId);
    await api('/resumes/' + fromProfileId, { method: 'PATCH', body: { document: latinOnly(orig.document) } });
    const d0 = await getResume(fromProfileId);
    const a = await api(`/resumes/${fromProfileId}/ats-check`, { method: 'POST' });
    if (a.status !== 200) return `first check ${a.status}: ${errMsg(a)}`;
    const doc = structuredClone(d0.document); const kinds = doc.sections.map((s) => s.kind);
    const drop = kinds.includes('skills') ? 'skills' : kinds.find((k) => k !== 'summary');
    if (!drop) return { skip: 'resume has only one section' };
    doc.sections = doc.sections.filter((s) => s.kind !== drop);
    const pr = await api('/resumes/' + fromProfileId, { method: 'PATCH', body: { document: doc } });
    if (pr.status !== 200) return `saving without ${drop}: ${pr.status} ${errMsg(pr)}`;
    const c = await api(`/resumes/${fromProfileId}/ats-check`, { method: 'POST' });
    await api('/resumes/' + fromProfileId, { method: 'PATCH', body: { document: d0.document } });
    return (c.status === 200 && c.body.score !== a.body.score) || `score ${a.body.score} → ${c.body.score} after removing ${drop}`;
  });
  await check('readability report shows no program codes (JL-resume-8)', async () => {
    if (!fromProfileId) return { skip: 'no resume from the profile' };
    await openApp(p, '#/resume/' + fromProfileId);
    await p.clickText('Check readability');
    await p.waitFor(`/View the full report|cannot/.test(document.querySelector('main')?.innerText || '')`, 30000);
    await p.clickMatching('main a, main button, main [role=button]', 'View the full report'); await sleep(1200);
    const t = await p.eval(`[...document.querySelectorAll('.ant-drawer-open')].map((e) => e.innerText).join(' ')`);
    await shot(p, 'readability-report');
    try { await p.click('.ant-drawer-open .ant-drawer-close'); } catch {}
    if (!t) return { skip: 'no report drawer (the grade could not be made)' };
    const codes = t.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [];
    return codes.length === 0 || 'codes shown: ' + [...new Set(codes)].join(', ');
  });

  // ---- G. exports hold the editor's text ----
  await check('export PDF and Word of a resume hold its text in order, nothing "undefined"', async () => {
    if (!fromProfileId) return { skip: 'no resume from the profile' };
    const d = await getResume(fromProfileId);
    const doc = structuredClone(d.document);
    const sum = section(doc, 'summary'); if (sum) sum.text = 'Data analyst who writes clear reports.';
    await api('/resumes/' + fromProfileId, { method: 'PATCH', body: { document: latinOnly(doc) } }); // plain Latin so the PDF font can draw it
    const cur = (await getResume(fromProfileId)).document;
    const expected = [cur.header && cur.header.name, ...cur.sections.flatMap((s) => [s.title, s.text, ...s.items.flatMap((i) => [i.heading, ...i.bullets, ...i.tags])])].filter(Boolean);
    const problems = [];
    for (const fmt of ['pdf', 'docx']) {
      const r = await api(`/resumes/${fromProfileId}/export?format=${fmt}`, { raw: true });
      if (r.status !== 200) { problems.push(`${fmt} → ${r.status} ${r.buf.toString().slice(0, 200)}`); continue; }
      let text;
      try { text = fmt === 'pdf' ? pdfText(r.buf) : docxText(r.buf); } catch (e) { problems.push(`${fmt} unreadable: ${e.message}`); continue; }
      if (fmt === 'pdf' && !r.buf.subarray(0, 5).toString().startsWith('%PDF')) problems.push('pdf does not start with %PDF');
      const T = strip(text);
      const missing = expected.filter((e) => !T.includes(strip(e)));
      if (missing.length) problems.push(`${fmt} misses ${missing.slice(0, 4).map((x) => '"' + String(x).slice(0, 40) + '"').join(', ')}`);
      let last = -1; for (const e of cur.sections.map((s) => s.title)) { const k = T.indexOf(strip(e)); if (k >= 0 && k < last) problems.push(`${fmt}: section "${e}" out of order`); last = Math.max(last, k); }
      if (/\b(undefined|NaN)\b|\[object Object\]/.test(text)) problems.push(`${fmt} contains undefined/NaN/[object Object]`);
    }
    return problems.length === 0 || problems.join('; ');
  });
  await check('PDF export of an uploaded resume is built from the editor, not the untouched upload (JL-resume-6)', async () => {
    if (!good['one-column']) return { skip: 'no upload' };
    const r = await api(`/resumes/${good['one-column'].id}/export?format=pdf`, { raw: true });
    if (r.status !== 200) return `status ${r.status}: ${r.buf.toString().slice(0, 200)}`;
    return !r.buf.equals(readFileSync(FX('jordan-one-column.pdf'))) || 'the PDF is byte-for-byte the uploaded file, so no editor text or edit reaches it';
  });

  // ---- H. "Answer a few questions" ----
  await check('"Answer a few questions" asks one field at a time when the profile has gaps (JL-resume-11)', async () => {
    const prof = (await api('/profile')).body;
    await gotoResumeList(p);
    await p.clickText('Answer a few questions'); await sleep(1500);
    const t = await p.eval(openModalText); await shot(p, 'questions');
    const fields = await p.eval(`[...document.querySelectorAll('.ant-modal-wrap')].filter((w) => getComputedStyle(w).display !== 'none').reduce((n, w) => n + w.querySelectorAll('textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio])').length, 0)`);
    let res = true;
    if (/no gaps/i.test(t)) {
      if (prof && Array.isArray(prof.work) && prof.work.length === 0) res = 'says "no gaps" while the profile has no work experience';
    } else if (/Save and next/.test(t)) {
      if (fields !== 1) res = `${fields} answer fields shown at once`;
      else {
        const before = profileClean((await api('/profile')).body);
        await p.clickMatching('.ant-modal-wrap button', '^Skip$'); await sleep(800);
        if (profileClean((await api('/profile')).body) !== before) res = 'Skip changed the profile';
      }
    } else res = `unexpected dialog: ${t.slice(0, 200)}`;
    await p.clickMatching('.ant-modal-wrap button', '^(Stop here|Done)$'); await sleep(500);
    try { await p.press('Escape'); } catch {}
    return res;
  });

  // ---- I. profile ↔ resume ----
  let skillsBeforeFill = null;
  if (fromProfileId) { const d = await getResume(fromProfileId); const s = section(d.document, 'skills'); skillsBeforeFill = s ? s.items.flatMap((i) => i.tags).join(',') : ''; }
  await check('"Fill it from a resume": profile gets the file\'s jobs, dates, school, skills and summary; keeps links and skill years (JL-resume-12)', async () => {
    const before = (await api('/profile')).body;
    await openApp(p);
    await p.clickText('Profile'); await sleep(1200);
    if (!(await p.clickText('Fill it from a resume'))) return { skip: 'no "Fill it from a resume" on the Profile screen' };
    if (!(await p.waitFor(`!!document.querySelector('input[type=file]')`, 8000))) return 'no file input';
    await p.eval(fileExpr(FX('jordan-one-column.pdf'), 'jordan-one-column.pdf', MIME_PDF));
    if (!(await p.waitFor(`/Resume added|cannot/.test(${openModalText})`, 20000))) return 'no result dialog';
    const t = await p.eval(openModalText); await shot(p, 'fill-dialog');
    const mine = (await listResumes()).filter((x) => x.file && x.file.fileName === 'jordan-one-column.pdf').sort((a, z) => a.createdAt < z.createdAt ? 1 : -1)[0];
    if (mine) created.add(mine.id);
    if (t.includes('Update my profile')) { await p.clickText('Update my profile'); await sleep(2500); }
    else if (t.includes('Open the resume')) { await p.clickText('Open the resume'); await sleep(800); }
    const after = (await api('/profile')).body; const probs = [];
    for (const j of FILE.jobs) {
      const w = (after.work || []).find((x) => x.company === j.company);
      if (!w) { probs.push(`job ${j.company} missing`); continue; }
      if (w.title !== j.title || w.startDate !== j.start || (w.endDate ?? null) !== j.end || !!w.current !== j.current) probs.push(`${j.company}: ${w.title} ${w.startDate}–${w.endDate} current=${w.current}`);
    }
    const e = (after.education || []).find((x) => x.school === FILE.school.name);
    if (!e) probs.push('school missing'); else if (!String(e.degree).includes(FILE.school.degree) || e.major !== FILE.school.major || e.startDate !== FILE.school.start || e.endDate !== FILE.school.end || String(e.gpa) !== FILE.school.gpa) probs.push(`school ${JSON.stringify([e.degree, e.major, e.startDate, e.endDate, e.gpa])}`);
    const names = (after.skills || []).map((s) => s.name); const miss = FILE.skills.filter((s) => !names.includes(s));
    if (miss.length) probs.push('skills missing: ' + miss.join(', '));
    if (strip(after.summary) !== strip(FILE.summary) && !/already has these facts/.test(t)) probs.push(`summary "${after.summary}"`);
    const lostLinks = ((before.personal && before.personal.links) || []).filter((l) => !((after.personal && after.personal.links) || []).some((x) => x.url === l.url));
    if (lostLinks.length) probs.push('links deleted: ' + lostLinks.map((l) => `${l.label} ${l.url}`).join(', '));
    const lostYears = (before.skills || []).filter((s) => s.years != null).filter((s) => { const a = (after.skills || []).find((x) => x.name === s.name); return a && a.years !== s.years; });
    if (lostYears.length) probs.push('skill years erased: ' + lostYears.map((s) => `${s.name} ${s.years} yr`).join(', '));
    return probs.length === 0 || probs.join('; ');
  });
  await check('a profile change does not rewrite an existing resume\'s Skills (JL-resume-23)', async () => {
    if (!fromProfileId || skillsBeforeFill === null) return { skip: 'no resume from the profile' };
    await listResumes();
    const d = await getResume(fromProfileId); const s = section(d.document, 'skills');
    const now = s ? s.items.flatMap((i) => i.tags).join(',') : '';
    return now === skillsBeforeFill || `Skills were "${skillsBeforeFill}", after the profile update "${now}"`;
  });

  // ---- J. banned words and money wording ----
  await check('Resume screens and Settings → Balance show no banned words ("credits", "undefined", "NaN" …)', async () => {
    const hits = [];
    await gotoResumeList(p); hits.push(...(await p.eval(AUDIT)).banned.map((x) => 'list: ' + x));
    if (fromProfileId) { await openApp(p, '#/resume/' + fromProfileId); hits.push(...(await p.eval(AUDIT)).banned.map((x) => 'editor: ' + x)); }
    await openApp(p); await p.clickText('Settings'); await sleep(1000); await p.clickText('Balance'); await sleep(1200);
    hits.push(...(await p.eval(AUDIT)).banned.map((x) => 'balance: ' + x)); await shot(p, 'balance');
    return hits.length === 0 || hits.join(' | ');
  });

  // ---- K. AI-backed checks (invariants only, never the wording of the model) ----
  const ai = (await api('/ai/settings')).body || {};
  let aiReady = !!ai.provider;
  if (aiReady && ai.provider === 'publik') aiReady = ((await api('/publik')).body || {}).state === 'connected';
  const jobs = ((await api('/jobs/search', { method: 'POST', body: { sort: 'recommended', q: 'engineer', limit: 5, filter: {} } })).body || {}).items || [];
  const job = jobs[0] && (jobs[0].job || jobs[0]);
  const aiSkip = !aiReady ? 'the app has no AI connection' : !job ? `no jobs in this state (${ENV.state})` : null;
  let tailorBase = null;
  if (!aiSkip) {
    const r = await upload(readFileSync(FX('jordan-one-column.pdf')), 'qa-tailor-base.pdf', MIME_PDF);
    if (r.status === 200) { tailorBase = (r.body.resume || r.body).id; created.add(tailorBase); }
  }
  let proposal = null;
  await check('tailor: the draft shows every change (before/after) and saves nothing until accepted', async () => {
    if (aiSkip) return { skip: aiSkip };
    if (!tailorBase) return 'could not upload a base resume';
    const n0 = (await listResumes()).length;
    const r = await api(`/resumes/${tailorBase}/tailor`, { method: 'POST', body: { jobId: job.id } });
    if (r.status !== 200) return `status ${r.status}: ${errMsg(r)}`;
    proposal = r.body;
    const n1 = (await listResumes()).length;
    const bad = (proposal.changes || []).filter((c) => typeof c.before !== 'string' || typeof c.after !== 'string');
    return (n1 === n0 && bad.length === 0) || `resumes ${n0} → ${n1} before accepting; ${bad.length} changes without before/after`;
  });
  await check('tailor: no proposed change adds a number that is not in the profile or the original line', async () => {
    if (aiSkip) return { skip: aiSkip };
    if (!proposal) return { skip: 'no draft' };
    const prof = JSON.stringify((await api('/profile')).body);
    const invented = [];
    for (const c of proposal.changes || []) for (const n of (c.after.match(/\d[\d,.]*/g) || [])) { const k = n.replace(/[.,]$/, ''); if (!prof.includes(k) && !c.before.includes(k)) invented.push(`${k} in "${c.after.slice(0, 80)}"`); }
    return invented.length === 0 || 'invented: ' + invented.join('; ');
  });
  await check('tailor: accepting one change saves exactly that change', async () => {
    if (aiSkip) return { skip: aiSkip };
    const text = (proposal && proposal.changes || []).filter((c) => !/order/.test(c.field));
    if (!proposal || !(proposal.changes || []).length) return { skip: 'the draft had no changes' };
    const first = text[0] || proposal.changes[0]; const other = text.find((c) => c !== first && c.after !== c.before && !c.before.includes(c.after));
    const r = await api(`/resumes/${tailorBase}/versions`, { method: 'POST', body: { proposalId: proposal.id, acceptChangeIds: [first.id] } });
    if (r.status !== 200) return `status ${r.status}: ${errMsg(r)}`;
    const v = r.body.resume || r.body; created.add(v.id);
    const json = JSON.stringify(v.document);
    if (!/order/.test(first.field) && !json.includes(JSON.stringify(first.after).slice(1, -1))) return `accepted change "${first.after.slice(0, 60)}" is not in the saved version`;
    if (other && json.includes(JSON.stringify(other.after).slice(1, -1))) return `rejected change "${other.after.slice(0, 60)}" was saved`;
    const base = await getResume(tailorBase);
    return (v.kind === 'tailored' && base.version === 1) || `kind ${v.kind}, base version ${base.version}`;
  });
  await check('cover letter: only numbers from the profile, no "undefined"', async () => {
    if (aiSkip) return { skip: aiSkip };
    if (!tailorBase) return 'no base resume';
    const r = await api('/cover-letters', { method: 'POST', body: { jobId: job.id, resumeId: tailorBase } });
    if (r.status !== 200) return `status ${r.status}: ${errMsg(r)}`;
    const text = (r.body.letter || r.body).text || '';
    const prof = JSON.stringify((await api('/profile')).body);
    const invented = (text.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[.,]$/, '')).filter((n) => !prof.includes(n));
    if (/\b(undefined|NaN)\b|\[object Object\]/.test(text)) return 'letter contains undefined/NaN';
    return (text.length > 200 && invented.length === 0) || (text.length <= 200 ? 'letter too short' : 'numbers not in the profile: ' + invented.join(', '));
  });
} catch (e) {
  fail('scenario', 'stopped early: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
} finally {
  // leave the store as it was: delete what this run made, put the profile back
  for (const id of created) { try { await api(`/resumes/${id}?withVersions=true`, { method: 'DELETE' }); } catch {} }
  if (profileAtStart && profileAtStart.personal) { try { await api('/profile', { method: 'PUT', body: profileAtStart }); } catch {} }
  await b.close();
}
process.exit(failures ? 1 : 0);
