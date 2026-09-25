// Helpers shared by this lane's adapters. Pure functions except `textGetter`, which only checks a capability.

import { nowMs } from '@jobleft/contracts';
import { decodeEntities } from '@jobleft/parsers';
import { isoDate } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, PayPeriod, RawJob, RawPay } from '@jobleft/crawler';
import { BoardTokenError } from './errors.ts';
import { decodeEntitiesFull, stripControls } from './entities.ts';

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
    const d = decodeEntitiesFull(t);
    if (d === t) break;
    t = d;
  }
  const plain = /<\/?[a-z!]/i.test(t) ? htmlToPlain(t) : t;
  // Control characters go last: a numeric reference such as "&#27;" decodes to one.
  return stripControls(plain).replace(/\s+/g, ' ').trim();
}

/**
 * A long text (a description) as plain text, ready to hand to the crawler. Every layer of escaping is removed,
 * whatever mix of live and escaped HTML the posting uses; named references decode with the full HTML 4 table;
 * terminal control characters are removed. The result is escaped once ("&", "<", ">"), so the crawler's own
 * htmlToText, which runs on it later, gives back exactly this text and nothing is decoded twice or left as markup.
 */
export function cleanDescription(html: string): string {
  return escapeHtml(descriptionText(html));
}

/** One encoded layer is removed only when encoded tag openers outnumber live ones (a page that shows markup as an example stays). */
function unescapeEncodedLayer(s: string): string {
  if (!s.includes('&lt;')) return s;
  const enc = (s.match(/&lt;\/?[a-zA-Z]/g) ?? []).length;
  const live = (s.match(/<\/?[a-zA-Z]/g) ?? []).length;
  return enc > live ? decodeEntitiesFull(s) : s;
}

/**
 * HTML to plain text, like the crawler's htmlToText (lists as "- " lines, blocks as lines) but with the full entity
 * table: the crawler's own table knows a few dozen names and turns "&euro;" into "EUR" and "&atilde;" into nothing.
 */
export function htmlToPlain(input: string): string {
  if (!input) return '';
  let s = unescapeEncodedLayer(input);
  s = s.replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|section|article|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<(p|div|h[1-6]|ul|ol|tr|table|section|article|blockquote|pre)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntitiesFull(s);
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  const out: string[] = [];
  let blank = 0;
  for (const l of s.split('\n').map((x) => x.replace(/[ \t\r\f\v]+/g, ' ').trim())) {
    if (l === '') { blank++; if (blank <= 1) out.push(''); } else { blank = 0; out.push(l); }
  }
  return out.join('\n').trim();
}

/** The plain text of a description (lists as "- " lines, no tags, no raw entity codes, no control characters). */
export function descriptionText(html: string): string {
  if (!html) return '';
  let t = html;
  for (let i = 0; i < 4; i++) {
    const next = htmlToPlain(t);
    const again = /<\/?[a-z!]|&lt;\/?[a-z!]|&(?:amp;)+(?:lt|gt);/i.test(next);
    t = next;
    if (!again) break;
  }
  // Anything still shaped like a tag after four layers is dropped: the stored text is never markup.
  t = t.replace(/<\/?[a-z!][^>]*>/gi, ' ');
  return stripControls(t).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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

/**
 * Pay exactly as the board states it: amounts are NOT rounded ("22.50" stays 22.5), a period the board does not
 * state stays null ("not stated"), a zero or missing amount is dropped. Null when neither amount is a positive number.
 */
export function statedPay(min: number | null, max: number | null, currency: string, period: PayPeriod | null): RawPay | null {
  const a = min !== null && min > 0 ? min : null;
  const b = max !== null && max > 0 ? max : null;
  if (a === null && b === null) return null;
  // RawPay.period is typed without null, but the store keeps a null period as "not stated" (pay_period is nullable).
  return { min: a, max: b, currency: currency.toUpperCase(), period: period as PayPeriod };
}
