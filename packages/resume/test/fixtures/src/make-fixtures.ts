// Builds the test fixture files for the persona "Jordan Testwell" into test/fixtures/:
//   jordan-one-column.pdf, jordan-two-column.pdf (headless Chrome print, the way real resumes are made),
//   jordan-accents.pdf, jordan-long.pdf, jordan-publications.pdf, jordan-table-two-column.pdf,
//   jordan-word.docx (a Word-style file: header part, numbered bullets, split runs), jordan-layout-table.docx,
//   jordan.txt, scanned.pdf (image only), locked.pdf (password), empty.pdf, text-named.pdf.
// Run: node test/fixtures/src/make-fixtures.ts   (needs /Applications/Google Chrome.app; scratch profile in /private/tmp)
// Chrome runs headless with a throwaway profile and background networking off; the pages load no network resource.

import { spawn } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { writeZip } from '../../../src/zip.ts';
import { JORDAN, PUBLICATIONS } from './persona.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Persona = typeof JORDAN;

function withAccents(p: Persona): Persona {
  const q = structuredClone(p);
  q.name = 'José Álvarez-Testwell';
  q.email = 'jose.alvarez+jobs@example.com';
  q.skills = [...q.skills.slice(0, 9), 'C#', 'C++', 'R&D'];
  q.jobs[0]!.bullets = ['Cut batch-job time by 40% by rewriting the scheduler in TypeScript.', 'Reached 100% test coverage on the Node.js billing service.', 'Led R&D work on C# and C++ tools with 12 engineers.'];
  q.links = ['https://example.com/jos%C3%A9/a-very-long-portfolio-link-that-goes-on-and-on-for-testing-purposes/index.html'];
  return q;
}

function longPersona(p: Persona): Persona {
  const q = structuredClone(p);
  const extra = [
    ['Data Analyst', 'Fabrikam Sample Inc', 'Houston, TX', 'Jun 2019', 'Dec 2020', '2019-06', '2020-12'],
    ['IT Support Intern', 'Tailspin Example Toys', 'Austin, TX', 'Jan 2018', 'May 2019', '2018-01', '2019-05'],
    ['Lab Assistant', 'Sample State University', 'Austin, TX', 'Aug 2016', 'Dec 2017', '2016-08', '2017-12'],
    ['Cashier', 'Woodgrove Example Market', 'Austin, TX', 'Jun 2015', 'Jul 2016', '2015-06', '2016-07'],
  ] as const;
  for (const [title, company, location, start, end, sy, ey] of extra) {
    q.jobs.push({
      title, company, location, start, end, startYm: sy, endYm: ey, current: false,
      bullets: Array.from({ length: 6 }, (_, i) => `${['Prepared', 'Reviewed', 'Organized', 'Tracked', 'Documented', 'Supported'][i]} weekly ${['reports', 'tickets', 'records', 'orders', 'processes', 'requests'][i]} for the ${company} team, working closely with managers and staff on the day-to-day needs of the group.`),
    });
  }
  for (const j of q.jobs.slice(0, 2)) {
    while (j.bullets.length < 7) j.bullets.push(`Worked with the ${j.company} team on planning, reviews and documentation for internal tools and processes across several groups.`);
  }
  return q;
}

function header(p: Persona): string {
  return `<h1>${esc(p.name)}</h1><p class="contact">${[p.email, p.phone, p.city, ...p.links].map(esc).join(' &nbsp;|&nbsp; ')}</p>`;
}
function jobsHtml(p: Persona): string {
  return p.jobs.map((j) => `<div class="job"><div class="row"><span><b>${esc(j.title)}</b> — ${esc(j.company)} — ${esc(j.location)}</span><span>${esc(j.start)} – ${esc(j.end)}</span></div><ul>${j.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`).join('');
}
function eduHtml(p: Persona): string {
  return p.education.map((e) => `<div class="row"><span><b>${esc(e.degree)} in ${esc(e.major)}</b> — ${esc(e.school)}</span><span>${esc(e.start)} – ${esc(e.end)}</span></div><ul><li>GPA: ${esc(e.gpa)}</li></ul>`).join('');
}
function projHtml(p: Persona): string {
  return p.projects.map((pr) => `<div class="row"><span><b>${esc(pr.name)}</b> — ${esc(pr.description)}</span><span></span></div><ul>${pr.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`).join('');
}
const CSS = `body{font-family:Helvetica,Arial,sans-serif;font-size:10.5pt;margin:0;color:#111} h1{font-size:20pt;margin:0 0 2pt;text-align:center}
.contact{text-align:center;margin:0 0 6pt} h2{font-size:11.5pt;border-bottom:1px solid #444;margin:9pt 0 3pt;text-transform:none}
.row{display:flex;justify-content:space-between} ul{margin:2pt 0 4pt 16pt;padding:0} li{margin:0} p{margin:0 0 3pt} @page{size:letter;margin:0.6in}`;

function oneColumn(p: Persona, extra = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)}</title><style>${CSS}</style></head><body>
${header(p)}<h2>Summary</h2><p>${esc(p.summary)}</p><h2>Experience</h2>${jobsHtml(p)}<h2>Education</h2>${eduHtml(p)}
<h2>Skills</h2><p>${p.skills.map(esc).join(', ')}</p><h2>Projects</h2>${projHtml(p)}${extra}</body></html>`;
}

function twoColumn(p: Persona): string {
  const side = `<h2>Contact</h2><p>${esc(p.email)}</p><p>${esc(p.phone)}</p><p>${esc(p.city)}</p>${p.links.map((l) => `<p>${esc(l)}</p>`).join('')}
<h2>Skills</h2>${p.skills.map((s) => `<p>${esc(s)}</p>`).join('')}<h2>Education</h2>${p.education.map((e) => `<p><b>${esc(e.degree)} in ${esc(e.major)}</b></p><p>${esc(e.school)}</p><p>${esc(e.start)} – ${esc(e.end)}</p><p>GPA: ${esc(e.gpa)}</p>`).join('')}`;
  const main = `<h2>Summary</h2><p>${esc(p.summary)}</p><h2>Experience</h2>${p.jobs.map((j) => `<p><b>${esc(j.title)}</b></p><p>${esc(j.company)} — ${esc(j.location)}</p><p>${esc(j.start)} – ${esc(j.end)}</p><ul>${j.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`).join('')}<h2>Projects</h2>${projHtml(p)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)}</title><style>${CSS} .grid{display:grid;grid-template-columns:2.1in 1fr;gap:0.3in}</style></head><body>
<h1>${esc(p.name)}</h1><div class="grid"><div>${side}</div><div>${main}</div></div></body></html>`;
}

/** A two-column layout made with a table (the bad kind for other systems): skills beside experience, row by row. */
function tableTwoColumn(p: Persona): string {
  const left = [...p.skills.map(esc), '', ...p.education.map((e) => `${esc(e.degree)} ${esc(e.major)}`)];
  const right = p.jobs.flatMap((j) => [`<b>${esc(j.title)}</b> ${esc(j.company)} ${esc(j.start)} – ${esc(j.end)}`, ...j.bullets.map(esc)]);
  const n = Math.max(left.length, right.length);
  const rows = Array.from({ length: n }, (_, i) => `<tr><td>${left[i] ?? ''}</td><td>${right[i] ?? ''}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS} td{vertical-align:top;padding:1pt 8pt} table{width:100%}</style></head><body>${header(p)}
<table><tr><td><h2>Skills</h2></td><td><h2>Experience</h2></td></tr>${rows}</table></body></html>`;
}

/** Headless Chrome writes the PDF and then lingers; we wait for "bytes written", then stop it. */
async function chromePdf(html: string, file: string): Promise<void> {
  const tmp = mkdtempSync('/private/tmp/jl-resume-chrome-');
  try {
    const src = join(tmp, 'page.html');
    writeFileSync(src, html);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(tmp, 'profile')}`,
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability',
        '--no-pings', '--metrics-recording-only', '--disable-features=Translate,OptimizationHints,MediaRouter',
        '--no-pdf-header-footer', `--print-to-pdf=${join(out, file)}`, `file://${src}`,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`chrome timed out for ${file}`)); }, 60_000);
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        if (/bytes written to file/.test(err)) { clearTimeout(timer); child.kill('SIGKILL'); }
      });
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------- Word files

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wp = (inner: string, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const wr = (t: string, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
/** Splits a run in two mid-word with a proofing mark between, as Word often does. */
const wrSplit = (t: string) => { const k = Math.max(1, Math.floor(t.length / 3)); return `${wr(t.slice(0, k))}<w:proofErr w:type="spellStart"/>${wr(t.slice(k))}<w:proofErr w:type="spellEnd"/>`; };
const bulletP = (t: string) => wp(wrSplit(t), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');

function wordDocx(p: Persona, layoutTable: boolean): Uint8Array {
  const body: string[] = [];
  body.push(wp(wr('Summary'), '<w:pStyle w:val="Heading1"/>'), wp(wr(p.summary)));
  const exp: string[] = [wp(wr('Professional Experience'), '<w:pStyle w:val="Heading1"/>')];
  for (const j of p.jobs) {
    exp.push(wp(`${wr(j.title, true)}${wr(', ')}${wr(j.company)}<w:r><w:tab/></w:r>${wr(`${j.start} – ${j.end}`)}`, '<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>'));
    exp.push(wp(wr(j.location)));
    for (const b of j.bullets) exp.push(bulletP(b));
  }
  const edu = [wp(wr('Education'), '<w:pStyle w:val="Heading1"/>'), ...p.education.flatMap((e) => [wp(`${wr(e.school, true)}<w:r><w:tab/></w:r>${wr(`${e.start} – ${e.end}`)}`, '<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>'), wp(wr(`${e.degree} in ${e.major}`)), bulletP(`GPA: ${e.gpa}`)])];
  const skills = [wp(wr('Technical Skills'), '<w:pStyle w:val="Heading1"/>'), wp(`<w:bookmarkStart w:id="0" w:name="skills"/>${wr(p.skills.join(' • '))}<w:bookmarkEnd w:id="0"/>`)];
  const projects = [wp(wr('Projects'), '<w:pStyle w:val="Heading1"/>'), ...p.projects.flatMap((pr) => [wp(`${wr(pr.name, true)}${wr(` | ${pr.description}`)}`), ...pr.bullets.map(bulletP)])];
  if (layoutTable) {
    const cell = (parts: string[], w: number) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${parts.join('')}</w:tc>`;
    body.push(`<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6360"/></w:tblGrid><w:tr>${cell([...skills, ...edu], 3000)}${cell([...exp, ...projects], 6360)}</w:tr></w:tbl>`);
    body.push(wp(''));
  } else {
    body.push(...exp, ...edu, ...skills, ...projects);
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body.join('')}<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const hdr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}">${wp(wr(p.name, true), '<w:jc w:val="center"/>')}${wp(wr([p.email, p.phone, p.city, ...p.links].join(' | ')), '<w:jc w:val="center"/>')}</w:hdr>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`;
  const root = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const enc = (s: string) => new TextEncoder().encode(s);
  return writeZip([
    { name: '[Content_Types].xml', data: enc(ct) }, { name: '_rels/.rels', data: enc(root) }, { name: 'word/document.xml', data: enc(doc) },
    { name: 'word/header1.xml', data: enc(hdr) }, { name: 'word/numbering.xml', data: enc(numbering) }, { name: 'word/styles.xml', data: enc(styles) },
    { name: 'word/_rels/document.xml.rels', data: enc(rels) },
  ]);
}

// ---------------------------------------------------------------------------------------------- bad PDFs

function pdfFromObjects(objs: Array<string | Buffer>, trailerExtra = ''): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offs: number[] = [];
  let pos = parts[0]!.length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    offs.push(pos);
    parts.push(b);
    pos += b.length;
  });
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(x, 'latin1'));
  return Buffer.concat(parts);
}

/** A "scanned" page: one grey image, no text layer. */
function scannedPdf(): Buffer {
  const w = 300, h = 400;
  const px = Buffer.alloc(w * h, 0xf0);
  for (let y = 40; y < 360; y += 12) for (let x = 30; x < 270; x++) if ((x * 7 + y) % 11 > 3) px[y * w + x] = 0x20;
  const img = deflateSync(px);
  const content = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`, 'latin1'), img, Buffer.from('\nendstream', 'latin1')]),
  ]);
}

function rc4(key: Buffer, data: Buffer): Buffer {
  // Test-only RC4 (the PDF standard security handler, revision 2). Written here; not used by the product.
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + s[i]! + key[i % key.length]!) & 255; [s[i], s[j]] = [s[j]!, s[i]!]; }
  const outB = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]!) & 255; [s[i], s[j]] = [s[j]!, s[i]!]; outB[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!; }
  return outB;
}

/** A PDF that needs a password to open (40-bit RC4, user password "user"). */
function lockedPdf(): Buffer {
  const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
  const pad = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
  const id = createHash('md5').update('jordan-locked').digest();
  const ownerKey = createHash('md5').update(pad('owner')).digest().subarray(0, 5);
  const O = rc4(ownerKey, pad('user'));
  const P = -44;
  const pbuf = Buffer.alloc(4); pbuf.writeInt32LE(P);
  const key = createHash('md5').update(Buffer.concat([pad('user'), O, pbuf, id])).digest().subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (n: number) => createHash('md5').update(Buffer.concat([key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])])).digest().subarray(0, 10);
  const content = Buffer.from('BT /F1 14 Tf 72 700 Td (Jordan Testwell - locked resume) Tj ET', 'latin1');
  const enc = rc4(objKey(4), content);
  void createCipheriv;
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    Buffer.concat([Buffer.from(`<< /Length ${enc.length} >>\nstream\n`, 'latin1'), enc, Buffer.from('\nendstream', 'latin1')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`,
  ], `/Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] `);
}

function textResume(p: Persona): string {
  const L: string[] = [p.name, [p.email, p.phone, p.city, ...p.links].join(' | '), '', 'SUMMARY', p.summary, '', 'EXPERIENCE'];
  for (const j of p.jobs) { L.push(`${j.title}, ${j.company}, ${j.location}    ${j.start} - ${j.end}`); for (const b of j.bullets) L.push(`- ${b}`); L.push(''); }
  L.push('EDUCATION');
  for (const e of p.education) L.push(`${e.degree} in ${e.major}, ${e.school}    ${e.start} - ${e.end}`, `- GPA: ${e.gpa}`);
  L.push('', 'SKILLS', p.skills.join(', '), '', 'PROJECTS');
  for (const pr of p.projects) { L.push(`${pr.name} | ${pr.description}`); for (const b of pr.bullets) L.push(`- ${b}`); }
  return L.join('\n') + '\n';
}

/** A profile far too long for one page: 12 jobs with 8 long bullets each (for the one-page fit, O9). */
function oversizedText(p: Persona): string {
  const L: string[] = [p.name, [p.email, p.phone, p.city].join(' | '), '', 'SUMMARY', p.summary, '', 'EXPERIENCE'];
  const verbs = ['Planned', 'Reviewed', 'Organized', 'Tracked', 'Documented', 'Supported', 'Prepared', 'Checked'];
  for (let i = 0; i < 12; i++) {
    const year = 2025 - i * 2;
    L.push(`Analyst, Example Company ${String.fromCharCode(65 + i)} Sample LLC, Austin, TX    Jan ${year - 1} - Dec ${year}`);
    for (let k = 0; k < 8; k++) L.push(`- ${verbs[k]} the weekly work plan number ${k + 1} for the Example Company ${String.fromCharCode(65 + i)} team and wrote it up for the managers and the staff.`);
    L.push('');
  }
  L.push('EDUCATION', 'B.S. in Computer Science, Sample State University    Aug 2004 - May 2008', '', 'SKILLS', p.skills.join(', '));
  return L.join('\n') + '\n';
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'jordan-oversized.txt'), oversizedText(JORDAN));
await chromePdf(oneColumn(JORDAN), 'jordan-one-column.pdf');
await chromePdf(twoColumn(JORDAN), 'jordan-two-column.pdf');
await chromePdf(oneColumn(withAccents(JORDAN)), 'jordan-accents.pdf');
await chromePdf(oneColumn(longPersona(JORDAN)), 'jordan-long.pdf');
await chromePdf(oneColumn(JORDAN, `<h2>Publications</h2>${PUBLICATIONS.map((x) => `<p>${esc(x)}</p>`).join('')}`), 'jordan-publications.pdf');
await chromePdf(tableTwoColumn(JORDAN), 'jordan-table-two-column.pdf');
writeFileSync(join(out, 'jordan-word.docx'), wordDocx(JORDAN, false));
writeFileSync(join(out, 'jordan-layout-table.docx'), wordDocx(JORDAN, true));
writeFileSync(join(out, 'jordan.txt'), textResume(JORDAN));
writeFileSync(join(out, 'scanned.pdf'), scannedPdf());
writeFileSync(join(out, 'locked.pdf'), lockedPdf());
writeFileSync(join(out, 'empty.pdf'), '');
writeFileSync(join(out, 'text-named.pdf'), textResume(JORDAN));
console.log('fixtures written to', out);
