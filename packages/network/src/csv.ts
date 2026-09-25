// The connections-file parser. It reads the CSV that the person downloads from their own professional-network data
// archive: a few note lines, then the header
//   First Name,Last Name,URL,Email Address,Company,Position,Connected On
// then one row per first-degree connection. It keeps every real row exactly as written (commas and accents
// inside quoted fields, emoji, non-Latin names, blank emails), and it reports every row it skips with a reason.
// A broken row (a wrong number of fields, a quote that never closes) is skipped on its own; it never stops the
// import and never swallows the rows after it.

import { fold, isEmailLike, learnSlashOrder, looksGarbled, parseConnectedOn, stripBom } from './text.ts';

export interface ParsedConnection {
  /** The file line (1-based) where the row starts. */
  line: number;
  firstName: string;
  lastName: string;
  profileUrl: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  /** YYYY-MM-DD, or null when blank or not readable. */
  connectedOn: string | null;
  /** The name may be garbled by the export. It is kept exactly as in the file. */
  maybeGarbled: boolean;
}

export interface ParseResult {
  rows: ParsedConnection[];
  skipped: Array<{ line: number; reason: string }>;
  notAConnectionsFile: boolean;
  warnings: string[];
  /** The file line of the header row (null when none was found). */
  headerLine: number | null;
  /** Rows after the header that hold data (kept + skipped; blank lines not counted). */
  dataRows: number;
}

type Column = 'firstName' | 'lastName' | 'url' | 'email' | 'company' | 'position' | 'connectedOn';

const HEADER_NAMES: Record<string, Column> = {
  firstname: 'firstName', lastname: 'lastName', url: 'url', profileurl: 'url', emailaddress: 'email', email: 'email',
  company: 'company', position: 'position', connectedon: 'connectedOn',
};
const REQUIRED: Column[] = ['firstName', 'lastName', 'company', 'position', 'connectedOn'];
/** How far down the file the header may be (the export has 3 note lines). */
const HEADER_SEARCH_LINES = 40;

function headerKey(cell: string): string {
  return fold(stripBom(cell)).replace(/[^a-z]/g, '');
}

// ---------------------------------------------------------------- record reader

interface RawRecord {
  fields: string[];
  /** 1-based physical line where the record starts, and where it ends. */
  startLine: number;
  endLine: number;
  /** Offset just after the record's line break. */
  next: number;
  unclosedQuote: boolean;
}

/**
 * Reads one CSV record starting at `pos`. RFC 4180 quoting ("" is a quote inside a quoted field); a quoted field may
 * span lines. Text right after a closing quote is kept (lenient, as spreadsheets are). A quote inside an unquoted
 * field is a plain character.
 */
function readRecord(text: string, pos: number, line: number, delim: string): RawRecord {
  const fields: string[] = [];
  let field = '';
  let i = pos;
  let cur = line;
  const n = text.length;
  let atFieldStart = true;
  let inQuotes = false;
  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\r') { if (text[i + 1] === '\n') i++; cur++; field += '\n'; i++; continue; }
      if (c === '\n') { cur++; field += '\n'; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; i++; continue; }
    if (c === delim) { fields.push(field); field = ''; atFieldStart = true; i++; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      fields.push(field);
      return { fields, startLine: line, endLine: cur, next: i, unclosedQuote: false };
    }
    field += c; atFieldStart = false; i++;
  }
  fields.push(field);
  return { fields, startLine: line, endLine: cur, next: n, unclosedQuote: inQuotes };
}

/** Offset of the start of the physical line after `line` that starts at `lineStart`, or text.length. */
function nextLineStart(text: string, lineStart: number): number {
  const n = text.length;
  for (let i = lineStart; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) return i + 1;
    if (c === 13) return text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
  }
  return n;
}

/**
 * A record that spans lines is kept only when no later line inside it reads, on its own, as a full row with a date
 * in the Connected On column. Otherwise an unclosed quote has swallowed real rows, and only the first line is bad.
 */
function swallowsARow(text: string, start: number, rec: RawRecord, delim: string, width: number, dateCol: number): boolean {
  let pos = nextLineStart(text, start);
  for (let line = rec.startLine + 1; line <= rec.endLine && pos < rec.next; line++) {
    const end = nextLineStart(text, pos);
    const alone = readRecord(text.slice(pos, end), 0, line, delim);
    if (!alone.unclosedQuote && alone.fields.length === width && parseConnectedOn(clean(alone.fields[dateCol])) !== null) return true;
    pos = end;
  }
  return false;
}

// ---------------------------------------------------------------- header

interface Header {
  line: number;
  delim: string;
  columns: Array<Column | null>;
  next: number;
}

function findHeader(text: string): Header | null {
  let pos = 0;
  for (let line = 1; line <= HEADER_SEARCH_LINES && pos < text.length; line++) {
    const end = nextLineStart(text, pos);
    const raw = text.slice(pos, end);
    if (/first\s*name/i.test(raw) && /last\s*name/i.test(raw)) {
      for (const delim of [',', ';', '\t']) {
        if (!raw.includes(delim)) continue;
        const rec = readRecord(text, pos, line, delim);
        const columns = rec.fields.map((f) => HEADER_NAMES[headerKey(f)] ?? null);
        const have = new Set(columns.filter((c): c is Column => c !== null));
        if (REQUIRED.every((c) => have.has(c))) return { line, delim, columns, next: rec.next };
      }
    }
    pos = end;
  }
  return null;
}

/** A plain message for a file that is some other CSV. */
function notConnectionsMessage(text: string): string {
  const head = fold(text.slice(0, 4000));
  const base = 'This is not a connections file: no header row with First Name, Last Name, Company, Position and Connected On was found';
  if (/conversation id|conversation title|sender profile url/.test(head)) return `${base}. It looks like messages.csv from the same archive. Pick Connections.csv instead.`;
  if (/inviter|invitee|sent at/.test(head)) return `${base}. It looks like Invitations.csv from the same archive. Pick Connections.csv instead.`;
  if (/^pk/.test(text.slice(0, 2).toLowerCase()) || text.includes('\u0000')) return `${base}. It looks like a zip or a spreadsheet file, not CSV text. Unzip the archive and pick Connections.csv.`;
  if (!text.trim()) return 'The file is empty.';
  return `${base} in its first ${HEADER_SEARCH_LINES} lines.`;
}

// ---------------------------------------------------------------- rows

function clean(v: string | undefined): string {
  // Only the ends are trimmed. The text inside stays exactly as in the file.
  return (v ?? '').replace(/^[\s ﻿]+|[\s ﻿]+$/g, '');
}

function httpUrl(v: string): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (v.length > 4096) return null;
    return v;
  } catch {
    return null;
  }
}

/** The key that says two rows are the same person: the profile link, lower case, without query or trailing slash. */
export function urlIdentity(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|[a-z]{2})\./, '');
    const path = decodeURIComponentSafe(u.pathname).replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** The key for a row with no profile link: every field folded (only identical rows share it). */
function fullRowIdentity(r: Omit<ParsedConnection, 'line' | 'maybeGarbled'>): string {
  return [r.firstName, r.lastName, r.email ?? '', r.company ?? '', r.position ?? '', r.connectedOn ?? ''].map((x) => fold(x).trim()).join('\u001f');
}

/**
 * Parses the export: skips the note lines above the header, handles a BOM, CRLF and quoted commas, and reports every
 * skipped row with a reason. A file that is not a connections export gives notAConnectionsFile: true and no rows.
 */
export function parseConnectionsCsv(input: string): ParseResult {
  const text = stripBom(input);
  const warnings: string[] = [];
  const header = findHeader(text);
  if (!header) {
    return { rows: [], skipped: [], notAConnectionsFile: true, warnings: [notConnectionsMessage(text)], headerLine: null, dataRows: 0 };
  }
  const width = header.columns.length;
  const idx = (c: Column) => header.columns.indexOf(c);
  const col = { firstName: idx('firstName'), lastName: idx('lastName'), url: idx('url'), email: idx('email'), company: idx('company'), position: idx('position'), connectedOn: idx('connectedOn') };

  // Pass 1: records.
  const records: RawRecord[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];
  let pos = header.next;
  let line = header.line + 1;
  let dataRows = 0;
  while (pos < text.length) {
    const rec = readRecord(text, pos, line, header.delim);
    const blank = rec.fields.length === 1 && clean(rec.fields[0]) === '';
    if (blank && !rec.unclosedQuote) { pos = rec.next; line = rec.endLine + 1; continue; }
    // Trailing empty fields beyond the header width (spreadsheet padding) are dropped.
    while (rec.fields.length > width && clean(rec.fields[rec.fields.length - 1]) === '') rec.fields.pop();
    const spans = rec.endLine > rec.startLine;
    if (rec.unclosedQuote || (spans && (rec.fields.length !== width || swallowsARow(text, pos, rec, header.delim, width, col.connectedOn)))) {
      // A quote opened on this line never closes where it should. Skip this one line and read on from the next.
      dataRows++;
      skipped.push({ line: rec.startLine, reason: 'Broken row: a quote opens and does not close on this row.' });
      pos = nextLineStart(text, pos);
      line = rec.startLine + 1;
      continue;
    }
    dataRows++;
    if (rec.fields.length !== width) {
      const extra = rec.fields.length > width ? ' (a comma outside quotes may have split a field)' : '';
      skipped.push({ line: rec.startLine, reason: `Broken row: it has ${rec.fields.length} fields, but the header has ${width}${extra}.` });
    } else {
      records.push(rec);
    }
    pos = rec.next;
    line = rec.endLine + 1;
  }

  // Pass 2: fields. Slash dates are read in the order the rest of the file proves.
  const slashOrder = learnSlashOrder(records.map((r) => r.fields[col.connectedOn] ?? ''));
  const rows: ParsedConnection[] = [];
  const seen = new Map<string, number>();
  let badUrls = 0;
  let badDates = 0;
  let garbled = 0;
  let blankEmails = 0;
  for (const rec of records) {
    const f = rec.fields;
    const firstName = clean(f[col.firstName]);
    const lastName = clean(f[col.lastName]);
    const urlText = col.url >= 0 ? clean(f[col.url]) : '';
    const profileUrl = httpUrl(urlText);
    if (urlText && !profileUrl) badUrls++;
    const emailText = col.email >= 0 ? clean(f[col.email]) : '';
    const company = clean(f[col.company]);
    const position = clean(f[col.position]);
    const dateText = clean(f[col.connectedOn]);
    const connectedOn = parseConnectedOn(dateText, slashOrder);
    if (dateText && !connectedOn) badDates++;
    if (!firstName && !lastName && !profileUrl) {
      const any = f.some((x) => clean(x) !== '');
      skipped.push({ line: rec.startLine, reason: any ? 'No name and no profile link on this row.' : 'Empty row.' });
      continue;
    }
    const row: ParsedConnection = {
      line: rec.startLine,
      firstName,
      lastName,
      profileUrl,
      email: emailText || null,
      company: company || null,
      position: position || null,
      connectedOn,
      maybeGarbled: looksGarbled(firstName) || looksGarbled(lastName),
    };
    const key = profileUrl ? `url:${urlIdentity(profileUrl)}` : `row:${fullRowIdentity(row)}`;
    const first = seen.get(key);
    if (first !== undefined) {
      skipped.push({
        line: rec.startLine,
        reason: profileUrl
          ? `Duplicate: the same profile link as line ${first}. Line ${first} was kept.`
          : `Duplicate: every field is the same as line ${first}. Line ${first} was kept.`,
      });
      continue;
    }
    seen.set(key, rec.startLine);
    if (row.maybeGarbled) garbled++;
    if (!row.email) blankEmails++;
    rows.push(row);
  }

  skipped.sort((x, y) => x.line - y.line);
  if (badUrls) warnings.push(`${badUrls} ${badUrls === 1 ? 'row has' : 'rows have'} a URL that is not a web address; it is not shown.`);
  if (badDates) warnings.push(`${badDates} ${badDates === 1 ? 'row has' : 'rows have'} a Connected On date that could not be read without guessing; it shows as unknown.`);
  if (garbled) warnings.push(`${garbled} ${garbled === 1 ? 'name looks' : 'names look'} garbled by the export. ${garbled === 1 ? 'It is' : 'They are'} shown exactly as in the file.`);
  if (blankEmails) warnings.push(`${blankEmails} of ${rows.length} people have no email address in the file (normal for this export). No email is guessed.`);
  if (!rows.length && !skipped.length) warnings.push('The file has the header row but no people.');
  return { rows, skipped, notAConnectionsFile: false, warnings, headerLine: header.line, dataRows };
}

/** Exported for the fixture writer and tests: quote one CSV field the way the export does. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

export { isEmailLike };
