// Text helpers for the Network tool: decode the uploaded bytes, spot names the export garbled, read the
// "Connected On" dates, and compute calendar dates in the person's own time zone.
// Nothing here changes a name or fills a missing value: it only reads and flags.

/** The encodings a connections file can come in. LinkedIn writes UTF-8 (sometimes with a BOM). */
export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/**
 * Turns the raw file bytes into text. UTF-8 (with or without BOM) is the normal case. A UTF-16 file (a spreadsheet
 * "Unicode text" save) and a Windows-1252 file (a spreadsheet re-save on Windows) are read too, with a warning.
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: CsvEncoding; warnings: string[] } {
  const warnings: string[] = [];
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: stripBom(new TextDecoder('utf-8').decode(bytes.subarray(3))), encoding: 'utf-8', warnings };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    warnings.push('The file is saved as UTF-16 text. It was read as UTF-16.');
    return { text: stripBom(new TextDecoder('utf-16le').decode(bytes.subarray(2))), encoding: 'utf-16le', warnings };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    warnings.push('The file is saved as UTF-16 text. It was read as UTF-16.');
    return { text: stripBom(new TextDecoder('utf-16be').decode(bytes.subarray(2))), encoding: 'utf-16be', warnings };
  }
  // UTF-16 without a BOM: many zero bytes on one side of each pair.
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length >= 8) {
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2 === 0) evenZero++; else oddZero++; }
    const half = sample.length / 2;
    if (oddZero > half * 0.4 && evenZero < half * 0.05) {
      warnings.push('The file is saved as UTF-16 text. It was read as UTF-16.');
      return { text: stripBom(new TextDecoder('utf-16le').decode(bytes)), encoding: 'utf-16le', warnings };
    }
    if (evenZero > half * 0.4 && oddZero < half * 0.05) {
      warnings.push('The file is saved as UTF-16 text. It was read as UTF-16.');
      return { text: stripBom(new TextDecoder('utf-16be').decode(bytes)), encoding: 'utf-16be', warnings };
    }
  }
  try {
    return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8', warnings };
  } catch {
    warnings.push('The file is not UTF-8 text (a spreadsheet may have saved it again). It was read as Windows-1252; check names with accents.');
    return { text: stripBom(new TextDecoder('windows-1252').decode(bytes)), encoding: 'windows-1252', warnings };
  }
}

/** Removes byte-order marks at the start (some tools write two). */
export function stripBom(text: string): string {
  let i = 0;
  while (i < text.length && text.charCodeAt(i) === 0xfeff) i++;
  return i ? text.slice(i) : text;
}

// ---------------------------------------------------------------- garbled names

/** Windows-1252 bytes 0x80..0x9F, as Unicode code points. */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** The Windows-1252 bytes of a string, or null when a character has no such byte. */
function cp1252Bytes(s: string): Uint8Array | null {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) || (cp >= 0x80 && cp <= 0x9f)) out.push(cp);
    else if (CP1252_HIGH[cp] !== undefined) out.push(CP1252_HIGH[cp]!);
    else return null;
  }
  return Uint8Array.from(out);
}

/**
 * true when a name looks damaged by the export: a replacement character, question marks where letters were,
 * control characters, or UTF-8 text that was read as Windows-1252 ("JosÃ©" for "José", "å¼ ä¼Ÿ" for "张伟").
 * A correct non-Latin name (张伟, 山田太郎, דוד כהן) is NOT flagged. The name itself is never changed.
 */
export function looksGarbled(name: string): boolean {
  if (!name) return false;
  if (name.includes('�')) return true;
  if (name.includes('?')) return true;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(name)) return true;
  if (!/[\u0080-ÿŒœŠšŸŽžƒˆ˜–-™]/.test(name)) return false;
  const bytes = cp1252Bytes(name);
  if (!bytes) return false;
  try {
    const again = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return again !== name && /[^\u0000-\u007F]/.test(again);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function year2(yy: number): number {
  // Professional-network connections exist only from the 2000s on.
  return yy < 100 ? 2000 + yy : yy;
}

/** The kind of a slash date ("3/4/2021"): which part is the month, when the text alone cannot tell. */
export type SlashOrder = 'mdy' | 'dmy' | null;

/**
 * Reads a "Connected On" value. The export writes "24 Sep 2026". Also read: "Sep 24, 2026", "2026-09-24",
 * "24-Sep-26" and slash dates. A slash date whose day and month are both 12 or less is read only when `slashOrder`
 * (learned from the other rows of the same file) says which part is the month; otherwise it stays unknown.
 * Returns null for anything else. Never a guess.
 */
export function parseConnectedOn(raw: string, slashOrder: SlashOrder = null): string | null {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?,?[ -](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    return mon ? isoDate(year2(Number(m[3])), mon, Number(m[1])) : null;
  }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    return mon ? isoDate(Number(m[3]), mon, Number(m[2])) : null;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = year2(Number(m[3]));
    if (a > 12 && b <= 12) return isoDate(y, b, a);
    if (b > 12 && a <= 12) return isoDate(y, a, b);
    if (a === b) return isoDate(y, a, b);
    if (slashOrder === 'mdy') return isoDate(y, a, b);
    if (slashOrder === 'dmy') return isoDate(y, b, a);
    return null;
  }
  return null;
}

/** Learns the order of slash dates from the rows that can only be read one way. null when unclear or mixed. */
export function learnSlashOrder(values: Iterable<string>): SlashOrder {
  let mdy = 0;
  let dmy = 0;
  for (const raw of values) {
    const m = /^\s*(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})\s*$/.exec(raw);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (mdy && !dmy) return 'mdy';
  if (dmy && !mdy) return 'dmy';
  return null;
}

/** "2026-09-24" -> "24 Sep 2026" (how the export writes it, so a person can check a reason against the file). */
export function displayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${names[Number(m[2]) - 1]} ${m[1]}`;
}

/** Whole years from one calendar date to another (birthday rule). Negative when `to` is before `from`. */
export function wholeYearsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toIso.split('-').map(Number) as [number, number, number];
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return years;
}

/** Days from one calendar date to another. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86_400_000);
}

/** The system time zone (the person's own), e.g. "America/Chicago". JOBLEFT_TZ overrides it for tests. */
export function localTimeZone(env: Record<string, string | undefined> = process.env): string {
  const tz = env.JOBLEFT_TZ || env.TZ;
  if (tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { /* fall through */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. Follow-up dates are compared with this. */
export function localDate(ms: number, timeZone: string = localTimeZone()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** true for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return !!m && isoDate(Number(m[1]), Number(m[2]), Number(m[3])) === s;
}

// ---------------------------------------------------------------- comparing names

/** Lower case with accents removed, for search and comparison only (stored text never changes). */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** A basic "looks like an email address" test (the export leaves many blank; blank is never an email). */
export function isEmailLike(s: string | null | undefined): boolean {
  return !!s && /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>".]{2,}$/.test(s.trim());
}
