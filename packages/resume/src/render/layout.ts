// Page layout for resumes and cover letters, and the one-page fit: shrink passes first (spacing, margins, font
// size down to a readable minimum), then, only if that is not enough, whole bullets and entries are left out in a
// fixed order and every one of them is listed for the person (resume O9). Text is never cut mid-line or hidden.

import type { ResumeDocument, ResumeItem } from '@jobleft/contracts';
import { dateRange, formatYm } from '../document.ts';
import { PAGE_HEIGHT, PAGE_WIDTH, textWidth, type FontName, type PdfPage, type Rule, type TextRun } from './pdf-writer.ts';

export interface LayoutParams {
  body: number;
  lineHeight: number;
  margin: number;
  nameSize: number;
  headingSize: number;
  sectionGap: number;
  itemGap: number;
}

/** Shrink passes, loosest first. The last one is the smallest the product will print (8.5 pt body). */
export const PASSES: readonly LayoutParams[] = [
  { body: 10.5, lineHeight: 1.28, margin: 50, nameSize: 20, headingSize: 11.5, sectionGap: 10, itemGap: 6 },
  { body: 10.5, lineHeight: 1.2, margin: 44, nameSize: 19, headingSize: 11.5, sectionGap: 8, itemGap: 5 },
  { body: 10, lineHeight: 1.18, margin: 40, nameSize: 18, headingSize: 11, sectionGap: 7, itemGap: 4 },
  { body: 9.5, lineHeight: 1.15, margin: 36, nameSize: 17, headingSize: 10.5, sectionGap: 6, itemGap: 3 },
  { body: 9, lineHeight: 1.12, margin: 32, nameSize: 16, headingSize: 10, sectionGap: 5, itemGap: 2.5 },
  { body: 8.5, lineHeight: 1.1, margin: 28, nameSize: 15, headingSize: 9.5, sectionGap: 4, itemGap: 2 },
];

interface Seg { text: string; font: FontName }

function breakWord(word: string, font: FontName, size: number, width: number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (cur && textWidth(cur + ch, font, size) > width) { parts.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Wraps styled segments into lines no wider than `width`. Words longer than a line are broken by characters. */
export function wrapRich(segs: Seg[], size: number, width: number): Seg[][] {
  const tokens: Array<{ word: string; font: FontName; space: boolean }> = [];
  for (const seg of segs) {
    for (const m of seg.text.matchAll(/(\s*)(\S+)/g)) tokens.push({ word: m[2]!, font: seg.font, space: m[1]!.length > 0 });
  }
  const lines: Seg[][] = [];
  let line: Seg[] = [];
  let lineW = 0;
  const append = (text: string, font: FontName) => {
    const last = line[line.length - 1];
    if (last && last.font === font) last.text += text; else line.push({ text, font });
    lineW += textWidth(text, font, size);
  };
  for (const t of tokens) {
    const sp = t.space && line.length ? ' ' : '';
    const w = textWidth(sp + t.word, t.font, size);
    if (line.length && lineW + w > width + 0.01) {
      lines.push(line);
      line = [];
      lineW = 0;
    }
    if (!line.length && textWidth(t.word, t.font, size) > width) {
      const pieces = breakWord(t.word, t.font, size, width);
      for (let i = 0; i < pieces.length - 1; i++) lines.push([{ text: pieces[i]!, font: t.font }]);
      append(pieces[pieces.length - 1]!, t.font);
      continue;
    }
    append((line.length ? sp : '') + t.word, t.font);
  }
  if (line.length) lines.push(line);
  return lines;
}

export function wrapPlain(text: string, font: FontName, size: number, width: number): string[] {
  return wrapRich([{ text, font }], size, width).map((l) => l.map((s) => s.text).join(''));
}

class Canvas {
  runs: TextRun[] = [];
  rules: Rule[] = [];
  y: number;
  overflow = false;
  readonly bottom: number;
  readonly p: LayoutParams;
  constructor(p: LayoutParams) {
    this.p = p;
    this.y = PAGE_HEIGHT - p.margin;
    this.bottom = p.margin;
  }
  get x0(): number { return this.p.margin; }
  get width(): number { return PAGE_WIDTH - 2 * this.p.margin; }
  advance(h: number): void {
    this.y -= h;
    if (this.y < this.bottom - 0.01) this.overflow = true;
  }
  line(segs: Seg[], size: number, x: number): void {
    this.advance(size * this.p.lineHeight);
    let cx = x;
    for (const s of segs) {
      this.runs.push({ text: s.text, font: s.font, size, x: cx, y: this.y });
      cx += textWidth(s.text, s.font, size);
    }
  }
  right(text: string, size: number, font: FontName = 'regular'): void {
    this.runs.push({ text, font, size, x: this.x0 + this.width - textWidth(text, font, size), y: this.y });
  }
}

function headerBlock(c: Canvas, doc: ResumeDocument): void {
  const p = c.p;
  const name = doc.header.name;
  const nameW = textWidth(name, 'bold', p.nameSize);
  let nameSize = p.nameSize;
  if (nameW > c.width) nameSize = Math.max(8, (p.nameSize * c.width) / nameW);
  c.advance(nameSize);
  c.runs.push({ text: name, font: 'bold', size: nameSize, x: (PAGE_WIDTH - textWidth(name, 'bold', nameSize)) / 2, y: c.y });
  c.advance(nameSize * 0.3);
  const items = [doc.header.email, doc.header.phone, doc.header.city, ...doc.header.links.map((l) => l.url)].filter((x): x is string => !!x && !!x.trim());
  const size = p.body * 0.95;
  const sep = '  |  ';
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.join(sep);
    let s = size;
    // A single contact item longer than the line (a long link) is set smaller, never cut or changed.
    while (textWidth(text, 'regular', s) > c.width && s > 6) s -= 0.25;
    if (textWidth(text, 'regular', s) > c.width) {
      for (const piece of wrapPlain(text, 'regular', s, c.width)) {
        c.advance(s * p.lineHeight);
        c.runs.push({ text: piece, font: 'regular', size: s, x: (PAGE_WIDTH - textWidth(piece, 'regular', s)) / 2, y: c.y });
      }
    } else {
      c.advance(s * p.lineHeight);
      c.runs.push({ text, font: 'regular', size: s, x: (PAGE_WIDTH - textWidth(text, 'regular', s)) / 2, y: c.y });
    }
    cur = [];
  };
  for (const it of items) {
    const trial = [...cur, it].join(sep);
    if (cur.length && textWidth(trial, 'regular', size) > c.width) flush();
    cur.push(it);
  }
  flush();
}

function sectionHeading(c: Canvas, title: string): void {
  const p = c.p;
  c.advance(p.sectionGap);
  c.advance(p.headingSize * 1.05);
  c.runs.push({ text: title, font: 'bold', size: p.headingSize, x: c.x0, y: c.y });
  const ry = c.y - p.headingSize * 0.28;
  c.rules.push({ x1: c.x0, y1: ry, x2: c.x0 + c.width, y2: ry, width: 0.6 });
  c.advance(p.headingSize * 0.35);
}

function paragraph(c: Canvas, segs: Seg[], indent = 0): void {
  const size = c.p.body;
  for (const l of wrapRich(segs, size, c.width - indent)) c.line(l, size, c.x0 + indent);
}

function bullets(c: Canvas, list: string[]): void {
  const size = c.p.body;
  const bx = c.x0 + 3;
  const tx = c.x0 + 13;
  const w = c.x0 + c.width - tx;
  for (const b of list) {
    const lines = wrapPlain(b, 'regular', size, w);
    lines.forEach((l, i) => {
      c.advance(size * c.p.lineHeight);
      if (i === 0) c.runs.push({ text: '•', font: 'regular', size, x: bx, y: c.y });
      c.runs.push({ text: l, font: 'regular', size, x: tx, y: c.y });
    });
  }
}

/**
 * Entry heading: the bold title and the rest on the first line, then the dates (and place) on their own line.
 * Dates are never right-aligned in a separate column, so every text extractor keeps them next to their entry.
 */
function entryHead(c: Canvas, left: Seg[], second: string): void {
  const size = c.p.body;
  for (const l of wrapRich(left, size, c.width)) c.line(l, size, c.x0);
  if (second) for (const l of wrapRich([{ text: second, font: 'regular' }], size, c.width)) c.line(l, size, c.x0);
}

function headSegs(bold: string | null, rest: Array<string | null>): Seg[] {
  const segs: Seg[] = [];
  const tail = rest.filter((x): x is string => !!x && !!x.trim());
  if (bold) segs.push({ text: bold, font: 'bold' });
  if (tail.length) segs.push({ text: (bold ? ' — ' : '') + tail.join(' — '), font: 'regular' });
  return segs;
}

export function joinBar(...parts: Array<string | null | undefined>): string {
  return parts.filter((x): x is string => !!x && !!x.trim()).join(' | ');
}

function item(c: Canvas, kind: string, it: ResumeItem): void {
  switch (kind) {
    case 'experience':
      entryHead(c, headSegs(it.subheading, [it.heading]), joinBar(dateRange(it), it.location));
      bullets(c, it.bullets);
      break;
    case 'education':
      entryHead(c, headSegs(it.subheading ?? it.heading, it.subheading ? [it.heading] : []), joinBar(dateRange(it), it.location));
      bullets(c, it.bullets);
      break;
    case 'projects':
      entryHead(c, headSegs(it.heading, [it.subheading]), joinBar(dateRange(it), ...it.tags));
      bullets(c, it.bullets);
      break;
    case 'certifications':
      entryHead(c, headSegs(it.heading, [it.subheading]), formatYm(it.startDate ?? it.endDate));
      bullets(c, it.bullets);
      break;
    case 'skills': {
      const list = it.tags.join(', ');
      if (list) paragraph(c, it.heading ? [{ text: `${it.heading}:`, font: 'bold' }, { text: ' ' + list, font: 'regular' }] : [{ text: list, font: 'regular' }]);
      bullets(c, it.bullets);
      break;
    }
    default:
      if (it.heading || it.subheading || it.startDate) entryHead(c, headSegs(it.heading ?? it.subheading, it.heading ? [it.subheading] : []), joinBar(dateRange(it), it.location));
      bullets(c, it.bullets);
  }
}

export interface LayoutResult { page: PdfPage; overflow: boolean; params: LayoutParams; bottomY: number }

export function layoutResume(doc: ResumeDocument, p: LayoutParams): LayoutResult {
  const c = new Canvas(p);
  headerBlock(c, doc);
  for (const s of doc.sections) {
    const hasContent = !!(s.text && s.text.trim()) || s.items.some((i) => i.bullets.length || i.tags.length || i.heading || i.subheading);
    if (!hasContent) continue;
    sectionHeading(c, s.title);
    if (s.text && s.text.trim()) paragraph(c, [{ text: s.text.replace(/\s*\n\s*/g, ' '), font: 'regular' }]);
    s.items.forEach((it, i) => {
      if (i > 0 && s.kind !== 'skills') c.advance(p.itemGap);
      item(c, s.kind, it);
    });
  }
  return { page: { runs: c.runs, rules: c.rules }, overflow: c.overflow, params: p, bottomY: c.y };
}

// ------------------------------------------------------------------------------------------------ one-page fit

interface Drop { describe: string; apply: (d: ResumeDocument) => void }

function label(kind: string, sTitle: string, it: ResumeItem): string {
  const name = [it.heading, it.subheading].filter(Boolean).join(', ');
  return `${sTitle} › ${name || kind}`;
}

/** The order in which content is left out when shrinking is not enough. Header, degrees and skills are never dropped. */
function dropPlan(doc: ResumeDocument): Drop[] {
  const drops: Drop[] = [];
  const secIdx = (kind: string) => doc.sections.map((s, i) => [s, i] as const).filter(([s]) => s.kind === kind);
  const bulletDrops = (kind: string, minKeep: number, oldestFirst: boolean) => {
    for (const [s, si] of secIdx(kind)) {
      const order = s.items.map((_, i) => i);
      if (oldestFirst) order.reverse();
      for (const ii of order) {
        const it = s.items[ii]!;
        for (let bi = it.bullets.length - 1; bi >= minKeep; bi--) {
          const text = it.bullets[bi]!;
          drops.push({
            describe: `${label(kind, s.title, it)}: bullet "${text}"`,
            apply: (d) => { const x = d.sections[si]!.items[ii]!; const k = x.bullets.indexOf(text); if (k >= 0) x.bullets.splice(k, 1); },
          });
        }
      }
    }
  };
  const itemDrops = (kind: string, keep: number) => {
    for (const [s, si] of secIdx(kind)) {
      for (let ii = s.items.length - 1; ii >= keep; ii--) {
        const it = s.items[ii]!;
        const id = it.id;
        drops.push({
          describe: `${label(kind, s.title, it)}${it.startDate || it.endDate ? ` (${dateRange(it)})` : ''}: whole entry`,
          apply: (d) => { const sec = d.sections[si]!; const k = sec.items.findIndex((x) => x.id === id); if (k >= 0) sec.items.splice(k, 1); },
        });
      }
    }
  };
  bulletDrops('experience', 4, true);
  bulletDrops('projects', 2, true);
  bulletDrops('custom', 0, true);
  bulletDrops('education', 1, true);
  bulletDrops('experience', 2, true);
  itemDrops('projects', 0);
  bulletDrops('experience', 1, true);
  bulletDrops('education', 0, true);
  itemDrops('certifications', 0);
  itemDrops('experience', 1);
  for (const [s, si] of secIdx('summary')) {
    drops.push({ describe: `${s.title}: the whole summary`, apply: (d) => { d.sections[si]!.text = null; } });
  }
  // Last resorts for very long lists: skills past the first ten, then older degrees.
  for (const [s, si] of secIdx('skills')) {
    s.items.forEach((it, ii) => {
      for (let k = it.tags.length - 1; k >= 10; k--) {
        const tag = it.tags[k]!;
        drops.push({ describe: `${s.title}: "${tag}"`, apply: (d) => { const x = d.sections[si]!.items[ii]!; const j = x.tags.indexOf(tag); if (j >= 0) x.tags.splice(j, 1); } });
      }
    });
  }
  itemDrops('education', 1);
  bulletDrops('custom', 0, true);
  return drops;
}

export interface FitResult {
  /** The document as it will print (after any left-out items). */
  doc: ResumeDocument;
  page: PdfPage;
  params: LayoutParams;
  leftOut: string[];
  fits: boolean;
}

/** Lays a resume out on one page: shrink first, then leave out whole items in a fixed order, naming each one. */
export function fitResume(doc: ResumeDocument): FitResult {
  const plan = dropPlan(doc);
  let cur = structuredClone(doc);
  const leftOut: string[] = [];
  for (let step = 0; step <= plan.length; step++) {
    for (const p of PASSES) {
      const r = layoutResume(cur, p);
      if (!r.overflow) return { doc: cur, page: r.page, params: p, leftOut, fits: leftOut.length === 0 };
    }
    const d = plan[step];
    if (!d) break;
    d.apply(cur);
    leftOut.push(d.describe);
  }
  // Even the header and required sections do not fit: print at the smallest size; the caller refuses to export.
  const last = layoutResume(cur, PASSES[PASSES.length - 1]!);
  return { doc: cur, page: last.page, params: last.params, leftOut, fits: false };
}

// ------------------------------------------------------------------------------------------------ letters

export const LETTER_PASSES: readonly LayoutParams[] = [
  { body: 11, lineHeight: 1.35, margin: 64, nameSize: 16, headingSize: 11, sectionGap: 10, itemGap: 8 },
  { body: 10.5, lineHeight: 1.3, margin: 56, nameSize: 15, headingSize: 11, sectionGap: 9, itemGap: 7 },
  { body: 10, lineHeight: 1.25, margin: 48, nameSize: 14, headingSize: 10, sectionGap: 8, itemGap: 6 },
  { body: 9.5, lineHeight: 1.2, margin: 42, nameSize: 13, headingSize: 10, sectionGap: 7, itemGap: 5 },
  { body: 9, lineHeight: 1.15, margin: 36, nameSize: 12, headingSize: 9, sectionGap: 6, itemGap: 4 },
];

/** A letter: the first line is the name (bold), the rest are paragraphs separated by blank lines. */
export function layoutLetter(text: string, p: LayoutParams): LayoutResult {
  const c = new Canvas(p);
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  paras.forEach((para, i) => {
    const lines = para.split('\n');
    if (i > 0) c.advance(p.itemGap);
    lines.forEach((ln, j) => {
      const t = ln.trim();
      if (!t) return;
      const bold = i === 0 && j === 0;
      let size = bold ? p.nameSize : p.body;
      const font = bold ? 'bold' : 'regular';
      // A word longer than the line (a long link in the contact line) is set smaller, never broken or changed.
      const longest = t.split(/\s+/).reduce((m, w) => Math.max(m, textWidth(w, font, size)), 0);
      if (longest > c.width) size = Math.max(6, (size * c.width) / longest - 0.05);
      for (const l of wrapPlain(t, font, size, c.width)) c.line([{ text: l, font }], size, c.x0);
    });
  });
  return { page: { runs: c.runs, rules: c.rules }, overflow: c.overflow, params: p, bottomY: c.y };
}

export function fitLetter(text: string): { page: PdfPage; params: LayoutParams; fits: boolean } {
  for (const p of LETTER_PASSES) {
    const r = layoutLetter(text, p);
    if (!r.overflow) return { page: r.page, params: p, fits: true };
  }
  const last = layoutLetter(text, LETTER_PASSES[LETTER_PASSES.length - 1]!);
  return { page: last.page, params: last.params, fits: false };
}
