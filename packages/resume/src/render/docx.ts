// Word (.docx) export. One column of real paragraphs in reading order: no text boxes, no layout tables, and the
// contact details in the body (never in a page header or footer, resume O10). Arial matches Helvetica's widths,
// so the Word file breaks lines like the PDF. Same input, same bytes.

import type { ResumeDocument, ResumeItem } from '@jobleft/contracts';
import { dateRange, formatYm } from '../document.ts';
import { writeZip } from '../zip.ts';
import { PASSES, type LayoutParams } from './layout.ts';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function xmlEscape(s: string): string {
  return s
    // Characters XML 1.0 does not allow are removed (they cannot be in a Word file at all).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Run { text: string; bold?: boolean; tab?: boolean; link?: string }

class Doc {
  body: string[] = [];
  rels: Array<{ id: string; target: string }> = [];
  readonly p: LayoutParams;
  constructor(p: LayoutParams) { this.p = p; }
  get textWidthTwips(): number { return 12240 - 2 * Math.round(this.p.margin * 20); }
  runXml(r: Run): string {
    const rpr = r.bold ? '<w:rPr><w:b/></w:rPr>' : '';
    const inner = `${r.tab ? '<w:tab/>' : ''}${r.text ? `<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t>` : ''}`;
    if (r.link) {
      const id = `rIdL${this.rels.length + 1}`;
      this.rels.push({ id, target: r.link });
      return `<w:hyperlink r:id="${id}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>${inner}</w:r></w:hyperlink>`;
    }
    return `<w:r>${rpr}${inner}</w:r>`;
  }
  para(runs: Run[], ppr = ''): void {
    this.body.push(`<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs.map((r) => this.runXml(r)).join('')}</w:p>`);
  }
  styled(style: string, runs: Run[], extra = ''): void {
    this.para(runs, `<w:pStyle w:val="${style}"/>${extra}`);
  }
  entry(left: Run[], right: string): void {
    const runs = [...left];
    if (right) runs.push({ text: right, tab: true });
    this.para(runs, `<w:tabs><w:tab w:val="right" w:pos="${this.textWidthTwips}"/></w:tabs><w:spacing w:before="${Math.round(this.p.itemGap * 20)}"/>`);
  }
  bullet(text: string): void {
    this.para([{ text: '•' }, { text, tab: true }], '<w:tabs><w:tab w:val="left" w:pos="260"/></w:tabs><w:ind w:left="260" w:hanging="200"/>');
  }
}

function headRuns(bold: string | null, rest: Array<string | null>): Run[] {
  const tail = rest.filter((x): x is string => !!x && !!x.trim());
  const runs: Run[] = [];
  if (bold) runs.push({ text: bold, bold: true });
  if (tail.length) runs.push({ text: (bold ? ' — ' : '') + tail.join(' — ') });
  return runs;
}

function item(d: Doc, kind: string, it: ResumeItem): void {
  switch (kind) {
    case 'experience':
      d.entry(headRuns(it.subheading, [it.heading, it.location]), dateRange(it));
      break;
    case 'education':
      d.entry(headRuns(it.subheading ?? it.heading, it.subheading ? [it.heading, it.location] : [it.location]), dateRange(it));
      break;
    case 'projects':
      d.entry(headRuns(it.heading, [it.subheading]), dateRange(it));
      for (const t of it.tags) d.para([{ text: t }]);
      break;
    case 'certifications':
      d.entry(headRuns(it.heading, [it.subheading]), formatYm(it.startDate ?? it.endDate));
      break;
    case 'skills': {
      const list = it.tags.join(', ');
      if (list) d.para(it.heading ? [{ text: `${it.heading}:`, bold: true }, { text: ' ' + list }] : [{ text: list }]);
      break;
    }
    default:
      if (it.heading || it.subheading || it.startDate) d.entry(headRuns(it.heading ?? it.subheading, it.heading ? [it.subheading, it.location] : [it.location]), dateRange(it));
  }
  for (const b of it.bullets) d.bullet(b);
}

function stylesXml(p: LayoutParams): string {
  const half = (pt: number) => Math.round(pt * 2);
  const line = Math.round(240 * p.lineHeight);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="${half(p.body)}"/><w:szCs w:val="${half(p.body)}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="${half(p.nameSize)}"/><w:szCs w:val="${half(p.nameSize)}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${Math.round(p.sectionGap * 20 + 60)}" w:after="40"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="000000"/></w:pBdr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="${half(p.headingSize)}"/><w:szCs w:val="${half(p.headingSize)}"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F3A93"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
}

function packDocx(d: Doc, title: string): Uint8Array {
  const margin = Math.round(d.p.margin * 20);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${d.body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="0" w:footer="0" w:gutter="0"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${d.rels.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(r.target)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title><dc:language>en-US</dc:language></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>jobleft</Application></Properties>`;
  const enc = (s: string) => new TextEncoder().encode(s);
  return writeZip([
    { name: '[Content_Types].xml', data: enc(contentTypes) },
    { name: '_rels/.rels', data: enc(rootRels) },
    { name: 'word/document.xml', data: enc(documentXml) },
    { name: 'word/styles.xml', data: enc(stylesXml(d.p)) },
    { name: 'word/_rels/document.xml.rels', data: enc(rels) },
    { name: 'docProps/core.xml', data: enc(core) },
    { name: 'docProps/app.xml', data: enc(app) },
  ]);
}

function contactRuns(doc: ResumeDocument): Run[] {
  const runs: Run[] = [];
  const items: Array<{ text: string; link?: string }> = [];
  for (const t of [doc.header.email, doc.header.phone, doc.header.city]) if (t && t.trim()) items.push({ text: t });
  for (const l of doc.header.links) items.push({ text: l.url, link: l.url });
  items.forEach((it, i) => {
    if (i > 0) runs.push({ text: '  |  ' });
    runs.push({ text: it.text, ...(it.link ? { link: it.link } : {}) });
  });
  return runs;
}

/** The Word file of a (fitted) resume document. Pass the same params the PDF used so both break alike. */
export function resumeDocx(doc: ResumeDocument, params: LayoutParams = PASSES[0]!): Uint8Array {
  const d = new Doc(params);
  d.styled('Title', [{ text: doc.header.name }]);
  const contact = contactRuns(doc);
  if (contact.length) d.para(contact, '<w:jc w:val="center"/>');
  for (const s of doc.sections) {
    const hasContent = !!(s.text && s.text.trim()) || s.items.some((i) => i.bullets.length || i.tags.length || i.heading || i.subheading);
    if (!hasContent) continue;
    d.styled('Heading1', [{ text: s.title }]);
    if (s.text && s.text.trim()) d.para([{ text: s.text.replace(/\s*\n\s*/g, ' ') }]);
    for (const it of s.items) item(d, s.kind, it);
  }
  return packDocx(d, `${doc.header.name} resume`);
}

/** The Word file of a cover letter (first line = the name, then the contact line, then paragraphs). */
export function letterDocx(text: string, params: LayoutParams): Uint8Array {
  const d = new Doc(params);
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  paras.forEach((para, i) => {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    lines.forEach((l, j) => {
      if (i === 0 && j === 0) d.para([{ text: l, bold: true }], `<w:spacing w:after="40"/>`);
      else d.para([{ text: l }], j === lines.length - 1 ? `<w:spacing w:after="${Math.round(params.itemGap * 20 + 80)}"/>` : '');
    });
  });
  return packDocx(d, 'Cover letter');
}
