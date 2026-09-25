// The Internship Machine dedupe spine (the owner's own Python project), ported from
// internships/pipeline/normalize.py and dedup.py:
//   layer 1: exact canonical URL match      -> the same posting
//   layer 2: sha256(normalized company | normalized title) -> the same role on other URLs
// Two deliberate, tested differences (see test/normalize.test.ts):
//   1. `gh_jid` is NOT stripped by default. Python strips it as tracking noise, but on a company-hosted
//      careers page (`careers.acme.com/jobs?gh_jid=123`) it is the ONLY thing that tells postings apart,
//      so stripping it collapses every posting of that company into one.
//   2. The title normaliser keeps "intern" / "program" by default. Python removes them because the
//      Internship Machine only sees internships; a general job app must keep "Engineer" and
//      "Engineer Intern" as two roles. Both are switchable to reproduce Python exactly.

import { createHash } from 'node:crypto';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gh_src', 'ref', 'source', 'src', 'referrer', 'trk', 'trackingid',
  'lever-source', 'lever-origin', 'from', 'via',
]);
const PYTHON_ONLY_TRACKING = ['gh_jid'];

const WRAPPER_HOSTS = new Set(['simplify.jobs', 'www.simplify.jobs', 'click.appcast.io', 'www.google.com']);
const WRAPPER_PARAMS = ['url', 'u', 'target', 'redirect', 'job', 'apply_url'];

export interface CanonOptions {
  /** Reproduce Python exactly: also strip gh_jid. Default false. */
  stripGhJid?: boolean;
}

function unwrap(url: string, depth = 0): string {
  if (depth > 2) return url;
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const host = u.host.toLowerCase();
  if (WRAPPER_HOSTS.has(host) || u.pathname.toLowerCase().includes('redirect')) {
    for (const key of WRAPPER_PARAMS) {
      const v = u.searchParams.get(key);
      if (v && v.startsWith('http')) return unwrap(v, depth + 1);
    }
  }
  return url;
}

/** Stable, dedupe-friendly form of an apply URL. Empty string when it cannot be parsed. */
export function canonicalizeUrl(url: string, opts: CanonOptions = {}): string {
  if (!url) return '';
  const raw = unwrap(url.trim());
  let u: URL;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const strip = new Set(TRACKING_PARAMS);
  if (opts.stripGhJid) for (const p of PYTHON_ONLY_TRACKING) strip.add(p);
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (v === '') continue; // Python: keep_blank_values=False
    if (strip.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(kept).toString();
  // Force https, lower-case host, default ports dropped by URL itself, fragment dropped.
  return `https://${u.host.toLowerCase().replace(/:(80|443)$/, '')}${path}${q ? '?' + q : ''}`;
}

const WS = /\s+/g;
export function cleanText(s: string | null | undefined): string {
  return (s ?? '').trim().replace(WS, ' ');
}

/** Lower-case and strip legal suffixes so "Stripe, Inc." equals "stripe". */
export function normalizeCompany(company: string): string {
  let c = (company ?? '').toLowerCase().trim();
  c = c.replace(/[.,]/g, '');
  c = c.replace(/\b(inc|llc|ltd|corp|corporation|co|company|the|technologies|technology|labs|ai)\b/g, '');
  return c.replace(/[^a-z0-9]+/g, '');
}

export interface TitleOptions {
  /** Reproduce Python exactly: also remove intern / internship / co-op / program. Default false. */
  stripInternTerms?: boolean;
}

/** Lower-case, drop parentheticals, years and seasons so "Nurse (Night Shift) 2027" stays comparable. */
export function normalizeTitle(title: string, opts: TitleOptions = {}): string {
  let t = (title ?? '').toLowerCase();
  t = t.replace(/\(.*?\)|\[.*?\]/g, ' ');
  t = t.replace(/\b(20\d\d)\b/g, ' ');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  const words = opts.stripInternTerms
    ? /\b(summer|fall|spring|winter|intern|internship|co-?op|program|req|requisition)\b/g
    : /\b(summer|fall|spring|winter|req|requisition)\b/g;
  t = t.replace(words, ' ');
  return t.replace(WS, ' ').trim();
}

export function dedupHash(company: string, title: string, opts: TitleOptions = {}): string {
  const key = `${normalizeCompany(company)}|${normalizeTitle(title, opts)}`;
  return createHash('sha256').update(key).digest('hex');
}

export interface DedupeItem {
  canonicalUrl: string;
  dedupHash: string;
  /** Higher wins a collision (company ATS > aggregator). */
  sourceTrust: number;
}

/**
 * Collapse duplicates WITHIN one crawl batch, on canonical URL and (optionally) on the role hash.
 * On a collision keep the higher-trust item in the first item's slot. Stable order otherwise.
 * `byHash` defaults to false here: one employer posts the same title in many cities with different
 * URLs, and those are different rows a candidate can filter on. The store flags them instead.
 */
export function dedupeBatch<T extends DedupeItem>(items: T[], opts: { byHash?: boolean } = {}): T[] {
  const byHash = opts.byHash ?? false;
  const slots: Array<T | null> = [];
  const urlSlot = new Map<string, number>();
  const hashSlot = new Map<string, number>();
  for (const it of items) {
    let idx = urlSlot.get(it.canonicalUrl);
    if (idx === undefined && byHash) idx = hashSlot.get(it.dedupHash);
    if (idx === undefined) {
      const i = slots.length;
      slots.push(it);
      urlSlot.set(it.canonicalUrl, i);
      if (byHash) hashSlot.set(it.dedupHash, i);
      continue;
    }
    const cur = slots[idx] as T;
    if (it.sourceTrust > cur.sourceTrust) {
      urlSlot.delete(cur.canonicalUrl);
      if (byHash) hashSlot.delete(cur.dedupHash);
      slots[idx] = it;
      urlSlot.set(it.canonicalUrl, idx);
      if (byHash) hashSlot.set(it.dedupHash, idx);
    }
  }
  return slots.filter((s): s is T => s !== null);
}

/**
 * Split into (fresh, duplicates) given what is already stored. A job is a duplicate when its
 * canonical URL OR its role hash was already seen (Internship Machine `partition_new`). Accepted jobs extend
 * the seen sets, so one batch cannot duplicate itself.
 */
export function partitionNew<T extends DedupeItem>(
  items: T[], seenUrls: Set<string>, seenHashes: Set<string>,
): { fresh: T[]; duplicates: T[] } {
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const it of items) {
    if (seenUrls.has(it.canonicalUrl) || seenHashes.has(it.dedupHash)) { duplicates.push(it); continue; }
    fresh.push(it);
    seenUrls.add(it.canonicalUrl);
    seenHashes.add(it.dedupHash);
  }
  return { fresh, duplicates };
}

/** Fingerprint of what a reader would see. Equal hash on re-crawl = the cheap "refresh only" path. */
export function contentHash(parts: Array<string | number | boolean | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\u0001')).digest('hex');
}
