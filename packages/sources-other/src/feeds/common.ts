// Shared pieces for feed adapters.

import type { Credit, JobEvidence, PostingStatements } from '@jobleft/contracts';
import type { RawJob, RawPay } from '@jobleft/crawler';
import type { FeedFacts, FeedPosting, FeedResult } from '../types.ts';
import { clip } from '../text.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function noStatements(): PostingStatements {
  return { sponsorship: null, clearanceRequired: null, usCitizenOnly: null };
}

export function emptyFacts(): FeedFacts {
  return {
    places: [], workModel: null, remoteScope: null, employmentType: null, level: null, pay: null, postedAt: null,
    isUs: null, statements: noStatements(), evidence: {},
  };
}

export function ev(source: 'board_field' | 'title' | 'description' | 'location_text', text: string): NonNullable<JobEvidence['pay']> {
  return { source, text: clip(text) };
}

/** A RawJob with every field present (unknowns empty or null), ready for the crawler's normalizeJob. */
export function rawJob(p: Partial<RawJob> & Pick<RawJob, 'externalId' | 'url' | 'title' | 'company'>): RawJob {
  return {
    externalId: p.externalId,
    url: p.url,
    applyUrl: p.applyUrl ?? '',
    title: p.title,
    company: p.company,
    location: p.location ?? '',
    descriptionHtml: p.descriptionHtml ?? '',
    remote: p.remote ?? false,
    workMode: p.workMode ?? '',
    countries: p.countries ?? [],
    postedAt: p.postedAt ?? null,
    employmentType: p.employmentType ?? '',
    department: p.department ?? '',
    pay: p.pay ?? null,
  };
}

export function rawPayOf(facts: FeedFacts): RawPay | null {
  const p = facts.pay;
  if (!p || p.source !== 'board_field') return null;
  return { min: p.min, max: p.max, currency: p.currency, period: p.period };
}

/** Builds the FeedResult from postings (jobs mirrors postings). */
export function result(postings: FeedPosting[], extra: Omit<FeedResult, 'jobs' | 'postings'>): FeedResult {
  return { jobs: postings.map((p) => p.raw), postings, ...extra };
}

/** ISO time from a date string or a Unix time in seconds. Future times beyond 48 h are dropped. */
export function isoFrom(v: unknown, now: number): string | null {
  let t: number;
  if (typeof v === 'number' && Number.isFinite(v)) t = v < 1e12 ? v * 1000 : v;
  else if (typeof v === 'string' && v.trim()) {
    const x = v.trim();
    // A date-time with no zone is read as UTC (never as the laptop's local time).
    t = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(x) ? `${x}Z` : x);
  } else return null;
  if (!Number.isFinite(t) || t <= 0) return null;
  if (t > now + 48 * HOUR) return null;
  return new Date(t).toISOString();
}

export function str(v: unknown): string { return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''; }
export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
export function arr(v: unknown): unknown[] | null { return Array.isArray(v) ? v : null; }

/** Countries for RawJob.countries from the facts (so the crawler's US flag agrees with the source). */
export function countriesOf(facts: FeedFacts): string[] {
  if (facts.isUs === true) return ['US'];
  const cs = new Set<string>();
  for (const p of facts.places) if (p.country) cs.add(p.country);
  for (const r of facts.remoteScope?.regions ?? []) if (/^[A-Z]{2}$/.test(r) && r !== 'EU' && r !== 'NA') cs.add(r);
  if (facts.isUs === false && cs.size === 0) return ['ZZ'];
  return [...cs];
}

export function creditFor(text: string, url: string): Credit { return { text, url }; }

/**
 * Fields the adapter reads that no item has at all (a renamed or dropped field). A non-empty answer means the source
 * changed its format: the readable postings are kept, nothing closes, and the source shows the problem (O5).
 */
export function missingFields(items: unknown[], fields: readonly string[]): string[] {
  const objs = items.map(obj).filter((o): o is Record<string, unknown> => o !== null);
  if (objs.length === 0) return [];
  return fields.filter((f) => !objs.some((o) => f in o));
}

export function formatProblem(missing: string[]): string | undefined {
  if (!missing.length) return undefined;
  return `the data format changed: no posting has the field${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}`;
}
