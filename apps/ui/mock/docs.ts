// Tiny PDF and Word (DOCX) writers and readers for the mock's resume flows. The real ones are in @jobleft/resume.
// Written new for the mock: plain PDF 1.4 with the standard Helvetica fonts, and a DOCX zip with stored entries.

import { inflateRawSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PDF

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  gapBefore?: number;
}

function pdfEscape(s: string): string {
  // Standard fonts use WinAnsi; replace characters outside Latin-1 so the file stays valid.
  return s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** Lays lines onto US Letter pages. Returns the PDF bytes and how many lines landed on each page. */
export function makePdf(lines: PdfLine[], opts: { maxPages?: number } = {}): { bytes: Uint8Array; pages: number; leftOut: number } {
  const pageH = 792, top = 740, bottom = 54, left = 54;
  const pages: string[][] = [[]];
  let y = top;
  let leftOut = 0;
  for (const l of lines) {
    const size = l.size ?? 10.5;
    const chunks = wrap(l.text, Math.floor(95 * (10.5 / size)));
    for (let i = 0; i < chunks.length; i++) {
      const lead = size * 1.35 + (i === 0 ? l.gapBefore ?? 0 : 0);
      if (y - lead < bottom) {
        if (opts.maxPages && pages.length >= opts.maxPages) { leftOut++; continue; }
        pages.push([]);
        y = top;
      }
      y -= lead;
      pages.at(-1)!.push(`BT /${l.bold ? 'F2' : 'F1'} ${size} Tf ${left} ${y.toFixed(1)} Td (${pdfEscape(chunks[i]!)}) Tj ET`);
    }
  }
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const content = p.join('\n');
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { bytes: new Uint8Array(Buffer.from(out, 'latin1')), pages: pages.length, leftOut };
}

function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_, c: string) => {
    if (/^\d/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[c] ?? c;
  });
}

/** Text lines of a PDF (text operators only). Returns [] for image-only or encrypted files. */
export function pdfText(bytes: Uint8Array): { lines: string[]; encrypted: boolean } {
  const bin = Buffer.from(bytes).toString('latin1');
  if (/\/Encrypt\s/.test(bin)) return { lines: [], encrypted: true };
  const lines: string[] = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf('endstream', start);
    if (end < 0) break;
    let body = bin.slice(start, end);
    if (/FlateDecode/.test(m[1]!)) {
      try { body = inflateSync(Buffer.from(body, 'latin1')).toString('latin1'); } catch { continue; }
    }
    for (const bt of body.split(/\bET\b/)) {
      const parts: string[] = [];
      for (const t of bt.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:\([^)]*\)|[^\]])*)\]\s*TJ/g)) {
        if (t[1] !== undefined) parts.push(unescapePdf(t[1]));
        else if (t[2] !== undefined) parts.push([...t[2].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((x) => unescapePdf(x[1]!)).join(''));
      }
      const line = parts.join('').trim();
      if (line) lines.push(line);
    }
    re.lastIndex = end;
  }
  return { lines, encrypted: false };
}

// ---------------------------------------------------------------- ZIP (stored entries) and DOCX

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, Buffer.from(f.data));
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

/** Reads the entries of a zip (stored or deflated). Returns null when the bytes are not a zip. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> | null {
  const b = Buffer.from(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null;
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const loc = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = b.readUInt16LE(loc + 26), lelen = b.readUInt16LE(loc + 28);
    const data = b.subarray(loc + 30 + lnlen + lelen, loc + 30 + lnlen + lelen + csize);
    try {
      out.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : new Uint8Array(data));
    } catch { /* skip a broken entry */ }
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function makeDocx(paras: Array<{ text: string; bold?: boolean; size?: number }>): Uint8Array {
  const body = paras.map((p) => `<w:p><w:r><w:rPr>${p.bold ? '<w:b/>' : ''}${p.size ? `<w:sz w:val="${Math.round(p.size * 2)}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xmlEscape(p.text)}</w:t></w:r></w:p>`).join('');
  const enc = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
  return makeZip([
    { name: '[Content_Types].xml', data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`) },
  ]);
}

export function docxText(bytes: Uint8Array): string[] | null {
  const zip = readZip(bytes);
  const doc = zip?.get('word/document.xml');
  if (!doc) return null;
  const xml = Buffer.from(doc).toString('utf8');
  const lines: string[] = [];
  for (const p of xml.split(/<\/w:p>/)) {
    const t = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]!).join('');
    const line = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    if (line) lines.push(line);
  }
  return lines;
}
