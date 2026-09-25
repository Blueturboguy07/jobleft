// Date ranges as resumes write them: "Jun 2023 – Present", "01/2020 - 05/2021", "2019 to 2021", "May 2020".
// Months are kept whenever the text has them ("Jan 2020" never becomes "2020", resume O1).

import { monthOf } from '../facts.ts';

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const TOKEN = `(?:(?:${MONTH})\\.?,?\\s*(?:'\\d{2}|\\d{4})|(?:0?[1-9]|1[0-2])\\s*[/.]\\s*\\d{4}|\\d{4}\\s*[-/.]\\s*(?:0[1-9]|1[0-2])(?![0-9])|(?:Spring|Summer|Fall|Autumn|Winter)\\s+\\d{4}|(?:19|20)\\d{2})`;
const OPEN = '(?:Present|Current|Now|Today|Ongoing|Date|Currently)';
const RANGE_RE = new RegExp(`(${TOKEN})\\s*(?:–|—|-|‒|―|~|to|until|through|thru)\\s*(${TOKEN}|${OPEN})`, 'i');
const SINGLE_RE = new RegExp(`(?:(Expected|Anticipated|Graduated|Graduation|Since|From)\\s*:?\\s*)?(${TOKEN})`, 'i');

export interface DateRange {
  start: string | null;
  end: string | null;
  current: boolean;
  /** The matched text, so the caller can remove it. */
  raw: string;
  index: number;
}

/** "Jun 2023" -> "2023-06", "2020" -> "2020", "05/2021" -> "2021-05". */
export function toYm(token: string): string | null {
  const t = token.trim();
  let m = new RegExp(`^(${MONTH})\\.?,?\\s*(?:'(\\d{2})|(\\d{4}))$`, 'i').exec(t);
  if (m) {
    const mo = monthOf(m[1]!);
    const y = m[2] ? 2000 + Number(m[2]) : Number(m[3]);
    return mo ? `${y}-${String(mo).padStart(2, '0')}` : String(y);
  }
  m = /^(0?[1-9]|1[0-2])\s*[/.]\s*(\d{4})$/.exec(t);
  if (m) return `${m[2]}-${String(Number(m[1])).padStart(2, '0')}`;
  m = /^(\d{4})\s*[-/.]\s*(0[1-9]|1[0-2])$/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(?:Spring|Summer|Fall|Autumn|Winter)\s+(\d{4})$/i.exec(t);
  if (m) return m[1]!;
  m = /^((?:19|20)\d{2})$/.exec(t);
  if (m) return m[1]!;
  return null;
}

export function findDateRange(text: string): DateRange | null {
  const r = RANGE_RE.exec(text);
  if (r) {
    const start = toYm(r[1]!);
    const openEnd = new RegExp(`^${OPEN}$`, 'i').test(r[2]!.trim());
    const end = openEnd ? null : toYm(r[2]!);
    if (start || end) return { start, end, current: openEnd, raw: r[0], index: r.index };
  }
  const s = SINGLE_RE.exec(text);
  if (s) {
    const ym = toYm(s[2]!);
    if (!ym) return null;
    const lead = (s[1] ?? '').toLowerCase();
    if (lead === 'since' || lead === 'from') return { start: ym, end: null, current: true, raw: s[0], index: s.index };
    return { start: null, end: ym, current: false, raw: s[0], index: s.index };
  }
  return null;
}

export function hasDateRange(text: string): boolean {
  return RANGE_RE.test(text);
}
