// Helpers shared by this lane's adapters. Pure functions except `textGetter`, which only checks a capability.

import { nowMs } from '@jobleft/contracts';
import { decodeEntities, htmlToText } from '@jobleft/parsers';
import { isoDate } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, RawJob } from '@jobleft/crawler';
import { BoardTokenError } from './errors.ts';

/** A DNS label: the board is part of a host name (acme.recruitee.com), so nothing else may pass. */
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/** A path segment slug (apply.workable.com/<slug>, api.gem.com/job_board/v0/<slug>). */
const PATH_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

/** Checks a board token that becomes a sub-domain. Throws before any request when it is not a plain label. */
export function subdomainBoard(ats: string, board: string): string {
  const b = board.trim();
  if (!SUBDOMAIN.test(b)) throw new BoardTokenError(ats, board);
  return b.toLowerCase();
}

/** Checks a board token that becomes one URL path segment. */
export function pathBoard(ats: string, board: string): string {
  const b = board.trim();
  if (!PATH_SLUG.test(b)) throw new BoardTokenError(ats, board);
  return b;
}

export function isSubdomainToken(b: string): boolean { return SUBDOMAIN.test(b); }
export function isPathToken(b: string): boolean { return PATH_SLUG.test(b); }

/** An absolute http(s) URL as given, or '' (javascript:, data:, relative and broken links are refused). */
export function httpUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? t : '';
  } catch {
    return '';
  }
}

/**
 * One line of plain text from a short field (title, place, department). Tags are removed and entities decoded
 * once, so "R&amp;D" reads "R&D" and "<b>Nurse</b>" reads "Nurse". The result is text, never markup.
 */
export function textField(v: unknown): string {
  if (typeof v !== 'string' || v === '') return '';
  let t = v;
  // A short field escaped more than once ("AT&amp;amp;T") is decoded until no entity is left (at most 3 layers).
  for (let i = 0; i < 3 && /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(t); i++) {
    const d = decodeEntities(t);
    if (d === t) break;
    t = d;
  }
  const plain = /<\/?[a-z!]/i.test(t) ? htmlToText(t) : t;
  return plain.replace(/\s+/g, ' ').trim();
}

/**
 * A description escaped twice or more ("&amp;lt;p&amp;gt;") loses its extra layers, so the crawler's htmlToText
 * (which removes one encoded layer itself) sees ordinary or once-encoded HTML. Only when the text has no live tag.
 * The result still goes through htmlToText: it is stored as text, never shown as markup.
 */
export function unwrapEscapedHtml(s: string): string {
  let t = s;
  for (let i = 0; i < 3; i++) {
    if (/<\/?[a-z][^>]*>/i.test(t) || !/&(?:amp;)+(?:lt|gt);/i.test(t)) break;
    t = decodeEntities(t);
  }
  return t;
}

/** Escapes text so it can sit inside HTML that htmlToText reads later (section headings). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The posted date as RFC 3339 UTC, or null. A date with no time ("2026-07-30") becomes 12:00 UTC of that day, so the
 * calendar day stays the same in every time zone from UTC-12 to UTC+11. A date more than 48 hours in the future,
 * or one that does not parse, gives null (never the crawl time).
 */
export function postedIso(v: unknown): string | null {
  if (typeof v !== 'string') return isoDate(v, nowMs());
  const t = v.trim();
  if (!t) return null;
  const d = DATE_ONLY.exec(t);
  if (d) {
    const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 12);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== Number(d[1]) || back.getUTCMonth() !== Number(d[2]) - 1 || back.getUTCDate() !== Number(d[3])) return null;
    return isoDate(ms, nowMs());
  }
  // Recruitee writes "2026-09-23 09:10:19 UTC".
  const spaced = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) ?(UTC|Z)$/i.exec(t);
  if (spaced) return isoDate(`${spaced[1]}T${spaced[2]}Z`, nowMs());
  return isoDate(t, nowMs());
}

/** Joins the non-empty, distinct parts of a place ("İstanbul, İstanbul, Türkiye" becomes "İstanbul, Türkiye"). */
export function placeText(...parts: unknown[]): string {
  const out: string[] = [];
  for (const p of parts) {
    const t = textField(p);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.join(', ');
}

/** Joins distinct non-empty strings. */
export function joinDistinct(parts: string[], sep: string): string {
  const out: string[] = [];
  for (const p of parts) if (p && !out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
  return out.join(sep);
}

/** Distinct ISO alpha-2 codes in upper case. */
export function countryCodes(codes: unknown[]): string[] {
  const out: string[] = [];
  for (const c of codes) {
    if (typeof c !== 'string') continue;
    const t = c.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * A listed posting this adapter could not read (no id or no title). It is counted as "unreadable" by the crawler,
 * never dropped silently: a board with more than 5% unreadable postings proves nothing and closes nothing.
 */
export function unreadableJob(board: BoardRef, why: string): RawJob {
  return {
    externalId: '', url: '', applyUrl: '', title: '', company: board.company, location: '', descriptionHtml: '',
    remote: false, workMode: '', countries: [], postedAt: null, employmentType: '', department: why, pay: null,
    unreadable: true,
  };
}

/** The crawler's HttpClient also reads text (XML, RSS). Adapters that need it check once, before any request. */
export interface TextGetter extends HttpGetter {
  getText(url: string, accept?: string): Promise<string>;
}
export function textGetter(http: HttpGetter, ats: string): TextGetter {
  const t = http as Partial<TextGetter>;
  if (typeof t.getText !== 'function') {
    throw new Error(`the ${ats} adapter reads XML and needs an HTTP client with getText (the crawler's HttpClient has it)`);
  }
  return t as TextGetter;
}
