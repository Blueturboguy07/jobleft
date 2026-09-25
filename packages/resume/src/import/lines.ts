// Turns a PDF, a Word file or plain text into source lines in reading order, with the layout hints the section
// parser needs (indent, size, bold, bullet mark, style). Two-column PDFs are read column by column.

import type { PdfItem, PdfPageInfo } from '../pdf-read.ts';
import { readZip } from '../zip.ts';
import { isBulletLine, normalizeText, stripBullet } from '../text.ts';

export interface SrcLine {
  text: string;
  /** Left edge (points for PDF; indent level * 20 for Word; leading spaces for text). */
  x: number;
  xEnd: number;
  size: number;
  bold: boolean;
  /** A bullet mark was seen (glyph, list numbering, "- "). */
  bullet: boolean;
  /** Word paragraph style ("Heading1", "Title") when known. */
  style: string | null;
  /** Space above the line, in body lines (0 = normal spacing). */
  gapAbove: number;
  page: number;
  /** 0 = full width, 1 = left column, 2 = right column. */
  column: 0 | 1 | 2;
  /** Pieces of the line that sit far apart (e.g. a title and a right-aligned date). */
  cells: string[];
  /** true for text from a page header or footer part (Word). */
  fromHeaderPart?: boolean;
}

// ------------------------------------------------------------------------------------------------ PDF

interface Cell { text: string; x: number; xEnd: number; size: number; bold: boolean }
interface Row { y: number; cells: Cell[]; size: number }

function rowsOf(items: PdfItem[]): Row[] {
  const vis = items.filter((i) => i.text.trim().length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Array<{ y: number; size: number; items: PdfItem[] }> = [];
  for (const it of vis) {
    const r = rows.find((row) => Math.abs(row.y - it.y) <= Math.max(1.5, 0.3 * Math.min(row.size, it.size || row.size)));
    if (r) { r.items.push(it); r.size = Math.max(r.size, it.size); } else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    const its = r.items.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const it of its) {
      const last = cells[cells.length - 1];
      const gap = last ? it.x - last.xEnd : Infinity;
      const text = normalizeText(it.text);
      if (last && gap < Math.max(8, 1.1 * it.size)) {
        const needSpace = gap > 0.12 * it.size && !/\s$/.test(last.text) && !/^\s/.test(text);
        last.text += (needSpace ? ' ' : '') + text;
        last.xEnd = Math.max(last.xEnd, it.x + it.width);
        last.bold = last.bold && it.bold;
        last.size = Math.max(last.size, it.size);
      } else {
        cells.push({ text, x: it.x, xEnd: it.x + it.width, size: it.size, bold: it.bold });
      }
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').trim();
    return { y: r.y, size: r.size, cells: cells.filter((c) => c.text) };
  }).filter((r) => r.cells.length);
}

const DATEISH = /\b(?:19|20)\d{2}\b|\bpresent\b|\bcurrent\b|\bnow\b/i;

/** The x of a vertical gutter that splits the page into two columns, or null. */
export function findGutter(rows: Row[], pageWidth: number): number | null {
  if (rows.length < 8) return null;
  let best: { x: number; score: number } | null = null;
  for (let x = pageWidth * 0.2; x <= pageWidth * 0.75; x += 2) {
    let crossing = 0;
    let left = 0;
    let right = 0;
    let rightCells = 0;
    let rightDateish = 0;
    let bandHit = false;
    for (const r of rows) {
      let l = false;
      let rr = false;
      for (const c of r.cells) {
        if (c.x < x - 2 && c.xEnd > x + 2) { crossing++; l = rr = false; break; }
        if (c.xEnd <= x) l = true;
        if (c.x >= x) { rr = true; rightCells++; if (c.text.length <= 32 && DATEISH.test(c.text)) rightDateish++; }
        if (c.x < x + 4 && c.xEnd > x - 4 && !(c.x < x - 2 && c.xEnd > x + 2)) bandHit = true;
      }
      if (l) left++;
      if (rr) right++;
    }
    if (bandHit) continue;
    if (crossing > rows.length * 0.12) continue;
    if (left < 4 || right < 4) continue;
    if (rightCells && rightDateish / rightCells >= 0.6) continue; // right-aligned dates, not a column
    const score = left + right - 3 * crossing;
    if (!best || score > best.score) best = { x, score };
  }
  return best ? best.x : null;
}

/** The column gap of a page, with how many lines sit on each side (for the readability check). */
export function findGutterForPage(p: PdfPageInfo): { x: number; left: number; right: number } | null {
  const rows = rowsOf(p.items);
  const x = findGutter(rows, p.width);
  if (x === null) return null;
  let left = 0;
  let right = 0;
  for (const r of rows) {
    if (r.cells.some((c) => c.xEnd <= x)) left++;
    if (r.cells.some((c) => c.x >= x)) right++;
  }
  return { x, left, right };
}

function cellLine(cells: Cell[], page: number, column: 0 | 1 | 2, gapAbove: number): SrcLine {
  let text = cells.map((c) => c.text).join('  ');
  const bullet = isBulletLine(text) || /^[-]/.test(text);
  if (bullet) text = stripBullet(text);
  const size = Math.max(...cells.map((c) => c.size));
  return {
    text, x: cells[0]!.x, xEnd: cells[cells.length - 1]!.xEnd, size, bold: cells.every((c) => c.bold), bullet, style: null,
    gapAbove, page, column, cells: cells.map((c) => c.text),
  };
}

/** Reading-order lines of one PDF page (two columns are read left column first, then right). */
export function pdfPageLines(p: PdfPageInfo): SrcLine[] {
  const rows = rowsOf(p.items);
  if (!rows.length) return [];
  const bodySize = median(rows.map((r) => r.size));
  const pitch = bodySize * 1.2;
  const out: SrcLine[] = [];
  const gutter = findGutter(rows, p.width);
  if (gutter === null) {
    let prevY: number | null = null;
    for (const r of rows) {
      const gap = prevY === null ? 0 : Math.max(0, (prevY - r.y) / pitch - 1);
      out.push(cellLine(r.cells, p.index, 0, gap));
      prevY = r.y;
    }
    return out;
  }
  // Split each row at the gutter; rows above the point where both columns have started are full-width header rows.
  const leftTop = Math.max(...rows.filter((r) => r.cells.some((c) => c.xEnd <= gutter)).map((r) => r.y));
  const rightTop = Math.max(...rows.filter((r) => r.cells.some((c) => c.x >= gutter)).map((r) => r.y));
  const startY = Math.min(leftTop, rightTop) + 0.5;
  const header = rows.filter((r) => r.y > startY);
  const body = rows.filter((r) => r.y <= startY);
  let prevY: number | null = null;
  for (const r of header) {
    out.push(cellLine(r.cells, p.index, 0, prevY === null ? 0 : Math.max(0, (prevY - r.y) / pitch - 1)));
    prevY = r.y;
  }
  // Within the body, a row that crosses the gutter is full width and splits the columns into bands.
  let band: Row[] = [];
  const flush = () => {
    for (const side of [1, 2] as const) {
      let py: number | null = null;
      for (const r of band) {
        const cells = r.cells.filter((c) => (side === 1 ? c.xEnd <= gutter : c.x >= gutter));
        if (!cells.length) continue;
        out.push(cellLine(cells, p.index, side, py === null ? 1 : Math.max(0, (py - r.y) / pitch - 1)));
        py = r.y;
      }
    }
    band = [];
  };
  for (const r of body) {
    const crosses = r.cells.some((c) => c.x < gutter - 2 && c.xEnd > gutter + 2);
    if (crosses) {
      flush();
      out.push(cellLine(r.cells, p.index, 0, 1));
    } else band.push(r);
  }
  flush();
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 10;
}

/** Drops running headers and footers ("Page 1 of 2", a name repeated on every page). */
export function dropPageFurniture(lines: SrcLine[], pages: number): SrcLine[] {
  const pageNo = /^(?:page\s*)?\d+\s*(?:of|\/)\s*\d+$|^page\s+\d+$|^-\s*\d+\s*-$/i;
  let out = lines.filter((l) => !pageNo.test(l.text.trim()));
  if (pages > 1) {
    const counts = new Map<string, Set<number>>();
    for (const l of out) {
      const k = l.text.trim().toLowerCase();
      if (k.length > 60) continue;
      if (!counts.has(k)) counts.set(k, new Set());
      counts.get(k)!.add(l.page);
    }
    const seen = new Set<string>();
    out = out.filter((l) => {
      const k = l.text.trim().toLowerCase();
      if ((counts.get(k)?.size ?? 0) >= Math.min(pages, 2) && pages > 1 && k.length > 0) {
        // Keep the first copy (it may be the name at the top of page 1).
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Word

interface WPara { text: string; style: string | null; list: boolean; bold: boolean; size: number | null; indent: number; center: boolean }

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? m[1]! : null;
}

/**
 * Paragraphs of one WordprocessingML part, in document order. Tables come out row by row; a row whose cells hold
 * several paragraphs (a layout table) comes out cell by cell. Text boxes are read once (the fallback copy is skipped).
 * Deleted text is left out; field codes are left out, their shown text is kept.
 */
export function wordParagraphs(xml: string): WPara[] {
  const out: WPara[] = [];
  const re = /<(\/?)([A-Za-z0-9_:]+)((?:\s+[^\s=>/]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let para: WPara | null = null;
  let runBold = false;
  let runBoldSeen = false;
  let allBold = true;
  let hasText = false;
  let inText = false;
  let skipDepth = 0; // inside w:del, mc:Fallback, w:instrText
  let inFieldCode = false;
  // Table state: each cell collects its paragraphs; rows are emitted when they close.
  const tableStack: Array<{ rows: WPara[][][]; row: WPara[][] | null; cell: WPara[] | null }> = [];
  const emit = (p: WPara) => {
    const t = tableStack[tableStack.length - 1];
    if (t && t.cell) t.cell.push(p); else out.push(p);
  };
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(xml))) {
    if (++guard > 5_000_000) break;
    const [, close, tag, attrs = '', selfClose, textNode] = m;
    if (textNode !== undefined) {
      if (inText && skipDepth === 0 && !inFieldCode && para) { para.text += decodeXml(textNode); hasText = true; if (!(runBoldSeen && runBold)) allBold = false; }
      continue;
    }
    const isClose = close === '/';
    const selfC = selfClose === '/';
    switch (tag) {
      case 'w:del': case 'mc:Fallback': case 'w:instrText': case 'w:delText':
        if (!selfC) skipDepth += isClose ? -1 : 1;
        break;
      case 'w:fldChar': {
        const t = attr(attrs, 'w:fldCharType');
        if (t === 'begin') inFieldCode = true; else if (t === 'separate' || t === 'end') inFieldCode = false;
        break;
      }
      case 'w:tbl':
        if (isClose) {
          const t = tableStack.pop();
          if (t) {
            for (const row of t.rows) {
              const multi = row.some((cell) => cell.length > 1);
              if (multi) for (const cell of row) for (const p of cell) emit(p);
              else {
                const texts = row.map((cell) => cell.map((p) => p.text).join(' ').trim()).filter(Boolean);
                if (texts.length) emit({ ...(row.find((c) => c.length)?.[0] ?? { style: null, list: false, bold: false, size: null, indent: 0, center: false }), text: texts.join('  ') });
              }
            }
          }
        } else if (!selfC) tableStack.push({ rows: [], row: null, cell: null });
        break;
      case 'w:tr': {
        const t = tableStack[tableStack.length - 1];
        if (!t) break;
        if (isClose) { if (t.row) t.rows.push(t.row); t.row = null; } else if (!selfC) t.row = [];
        break;
      }
      case 'w:tc': {
        const t = tableStack[tableStack.length - 1];
        if (!t) break;
        if (isClose) { if (t.row && t.cell) t.row.push(t.cell); t.cell = null; } else if (!selfC) t.cell = [];
        break;
      }
      case 'w:p':
        if (isClose || selfC) {
          if (para && skipDepth === 0) {
            para.bold = hasText && allBold;
            if (para.text.trim() || !selfC) emit(para);
          }
          para = null;
        }
        if (!isClose && !selfC) { para = { text: '', style: null, list: false, bold: false, size: null, indent: 0, center: false }; allBold = true; hasText = false; }
        break;
      case 'w:pStyle': if (para) para.style = attr(attrs, 'w:val'); break;
      case 'w:numPr': if (para && !isClose) para.list = true; break;
      case 'w:ind': if (para) { const l = Number(attr(attrs, 'w:left') ?? attr(attrs, 'w:start') ?? 0); if (Number.isFinite(l)) para.indent = l; } break;
      case 'w:jc': if (para) para.center = attr(attrs, 'w:val') === 'center'; break;
      case 'w:r': if (!isClose) { runBold = false; runBoldSeen = false; } break;
      case 'w:b': if (para) { const v = attr(attrs, 'w:val'); runBold = v === null || v === '1' || v === 'true' || v === 'on'; runBoldSeen = true; } break;
      case 'w:sz': if (para) { const v = Number(attr(attrs, 'w:val')); if (Number.isFinite(v)) para.size = Math.max(para.size ?? 0, v / 2); } break;
      case 'w:t': inText = !isClose && !selfC; break;
      case 'w:tab': if (para && skipDepth === 0 && !isClose && tag === 'w:tab' && !/w:val=/.test(attrs)) para.text += '\t'; break;
      case 'w:br': case 'w:cr': if (para && skipDepth === 0 && !isClose) para.text += '\n'; break;
      case 'w:noBreakHyphen': if (para && skipDepth === 0) para.text += '-'; break;
      default: break;
    }
  }
  return out;
}

export interface DocxLines { lines: SrcLine[]; headerTextFound: boolean }

export function docxLines(bytes: Uint8Array): DocxLines {
  const zip = readZip(bytes);
  if (!zip.has('word/document.xml')) throw Object.assign(new Error('The file is not a Word document (it has no document part).'), { reason: 'corrupt' });
  const parts: Array<{ name: string; header: boolean }> = [];
  for (const n of zip.names.filter((x) => /^word\/header\d*\.xml$/.test(x)).sort()) parts.push({ name: n, header: true });
  parts.push({ name: 'word/document.xml', header: false });
  for (const n of zip.names.filter((x) => /^word\/footer\d*\.xml$/.test(x)).sort()) parts.push({ name: n, header: true });
  const lines: SrcLine[] = [];
  const seenHeader = new Set<string>();
  let headerTextFound = false;
  for (const part of parts) {
    const paras = wordParagraphs(zip.text(part.name));
    for (const p of paras) {
      const texts = normalizeText(p.text).split('\n');
      for (const raw of texts) {
        const t = raw.replace(/\t+/g, '  ').replace(/[ ]{3,}/g, '  ').trim();
        if (!t) {
          lines.push({ text: '', x: 0, xEnd: 0, size: 0, bold: false, bullet: false, style: null, gapAbove: 1, page: 0, column: 0, cells: [] });
          continue;
        }
        if (part.header) {
          // Headers repeat on every page and several header parts often hold the same text: keep one copy.
          const k = t.toLowerCase();
          if (seenHeader.has(k)) continue;
          seenHeader.add(k);
          headerTextFound = true;
        }
        const bullet = p.list || isBulletLine(t);
        const text = bullet ? stripBullet(t) : t;
        lines.push({
          text, x: p.indent / 20, xEnd: 0, size: p.size ?? 0, bold: p.bold, bullet, style: p.style, gapAbove: 0, page: 0, column: 0,
          cells: text.split(/ {2,}/), fromHeaderPart: part.header,
        });
      }
    }
  }
  // Blank paragraphs become a gap on the next line.
  const out: SrcLine[] = [];
  let gap = 0;
  for (const l of lines) {
    if (!l.text) { gap++; continue; }
    out.push({ ...l, gapAbove: gap });
    gap = 0;
  }
  return { lines: out, headerTextFound };
}

// ------------------------------------------------------------------------------------------------ plain text

export function textLines(text: string): SrcLine[] {
  const out: SrcLine[] = [];
  let gap = 0;
  for (const raw of normalizeText(text).split('\n')) {
    const t = raw.replace(/\t/g, '    ');
    if (!t.trim()) { gap++; continue; }
    const indent = t.length - t.trimStart().length;
    const bullet = isBulletLine(t);
    const body = (bullet ? stripBullet(t) : t.trim()).replace(/\s{3,}/g, '  ');
    out.push({ text: body, x: indent, xEnd: t.length, size: 0, bold: false, bullet, style: null, gapAbove: gap, page: 0, column: 0, cells: body.split(/ {2,}/) });
    gap = 0;
  }
  return out;
}
