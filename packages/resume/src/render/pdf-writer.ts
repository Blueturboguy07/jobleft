// A small PDF writer for jobleft's resumes and letters: one or more pages of left-to-right text in the standard
// Helvetica fonts (WinAnsiEncoding) plus thin rules. Text stays real text (selectable, extractable), there are no
// ligatures, no images, no hidden or white text, and the same input always gives the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS } from './helvetica-metrics.ts';

export type FontName = 'regular' | 'bold' | 'italic';

export interface TextRun {
  text: string;
  font: FontName;
  size: number;
  x: number;
  /** Baseline, in points from the bottom of the page. */
  y: number;
}

export interface Rule { x1: number; y1: number; x2: number; y2: number; width: number }

export interface PdfPage { runs: TextRun[]; rules: Rule[] }

export const PAGE_WIDTH = 612; // US Letter, points
export const PAGE_HEIGHT = 792;

/** Unicode -> WinAnsi byte for the 0x80-0x9F block (the rest is ASCII or Latin-1). */
const WIN_ANSI_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** The WinAnsi byte of a character, or null when the standard fonts cannot show it. */
export function winAnsiByte(ch: string): number | null {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp === 0xad ? null : cp;
  return WIN_ANSI_HIGH.get(cp) ?? null;
}

/** Characters in `text` the standard fonts cannot show (so the caller can say so instead of dropping them). */
export function unsupportedChars(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text.normalize('NFC')) if (ch !== '\n' && ch !== '\t' && winAnsiByte(ch) === null) bad.add(ch);
  return [...bad];
}

export function textWidth(text: string, font: FontName, size: number): number {
  const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let w = 0;
  for (const ch of text) {
    const b = winAnsiByte(ch);
    w += b === null ? 556 : (table[b] ?? 556);
  }
  return (w * size) / 1000;
}

function hexString(text: string): string {
  let out = '<';
  for (const ch of text.normalize('NFC')) {
    const b = winAnsiByte(ch);
    if (b === null) throw new Error(`character U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} cannot be written with the standard fonts`);
    out += b.toString(16).padStart(2, '0');
  }
  return out + '>';
}

function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function pdfString(s: string): string {
  // Literal string for the Info dictionary, ASCII only (non-ASCII is dropped from metadata, never from content).
  return '(' + s.replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, (c) => '\\' + c) + ')';
}

const FONT_RES: Record<FontName, string> = { regular: 'F1', bold: 'F2', italic: 'F3' };

export function writePdf(pages: PdfPage[], meta: { title: string; subject?: string }): Uint8Array {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objects.length;
  };
  // Fixed object numbers: 1 catalog, 2 pages, 3-5 fonts, 6 info, then page + content pairs.
  const catalog = 1;
  const pagesObj = 2;
  objects.length = 6;
  const pageRefs: number[] = [];
  for (const page of pages) {
    let content = '';
    for (const r of page.rules) content += `${num(r.width)} w 0 G ${num(r.x1)} ${num(r.y1)} m ${num(r.x2)} ${num(r.y2)} l S\n`;
    content += '0 g\n';
    for (const run of page.runs) {
      if (!run.text) continue;
      content += `BT /${FONT_RES[run.font]} ${num(run.size)} Tf ${num(run.x)} ${num(run.y)} Td ${hexString(run.text)} Tj ET\n`;
    }
    const stream = deflateSync(Buffer.from(content, 'latin1'), { level: 9 });
    const contentObj = add(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1'),
    ]));
    const pageObj = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObj} 0 R >>`);
    pageRefs.push(pageObj);
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>`, 'latin1');
  objects[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`, 'latin1');
  objects[2] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1');
  objects[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1');
  objects[4] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>', 'latin1');
  objects[5] = Buffer.from(`<< /Title ${pdfString(meta.title)} /Producer (jobleft)${meta.subject ? ` /Subject ${pdfString(meta.subject)}` : ''} >>`, 'latin1');

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objects.forEach((body, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(pos);
    parts.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  const id = createHash('md5').update(Buffer.concat(parts)).digest('hex');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info 6 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
