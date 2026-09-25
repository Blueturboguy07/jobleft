// @jobleft/sources-other: job sources that are not an employer's ATS board (government APIs, remote-job boards,
// community lists, per-query partners when approved), add-a-job by URL or by pasted text, and the metered fetch
// and search client (paid, through publik or the user's own provider key, OFF until the person turns it on).
// Status: interface stubs (foundation). Bodies throw until the sources-other lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/sources-other".

import type { Credit, SourceInfo } from '@jobleft/contracts';
import type { RawJob } from '@jobleft/crawler';

export const PACKAGE_NAME = '@jobleft/sources-other';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/sources-other)`);
}

/** The network a feed may use: the crawler's polite HttpClient (pacer, robots.txt, never-crawl list, User-Agent). */
export interface FeedHttp {
  getJson(url: string): Promise<unknown>;
  getText(url: string, accept?: string): Promise<string>;
}

export interface FeedContext {
  http: FeedHttp;
  /** The source's key from the secret store; null when the source needs none or none is saved. */
  key: string | null;
  now: number;
  signal?: AbortSignal;
}

export interface FeedResult {
  /** Postings in the crawler's RawJob shape, so they share normalisation and dedupe. */
  jobs: RawJob[];
  /** true when this answer is the whole feed (only then may jobs missing from it be closed). */
  complete: boolean;
}

/** One non-ATS source. */
export interface JobFeed {
  readonly id: string;
  readonly info: Omit<SourceInfo, 'enabled' | 'keySet' | 'status'>;
  readonly credit: Credit | null;
  /** The source's own limits, enforced across restarts (for example 4 fetches a day). */
  readonly limits: { minIntervalMs: number; maxPerDay: number | null };
  /** false for per-query partners whose terms forbid storing results (they are never saved). */
  readonly storable: boolean;
  fetch(ctx: FeedContext): Promise<FeedResult>;
}

/** Every approved feed. Empty until the lane adds them; each one ships OFF until reviewed. */
export const OTHER_FEEDS: readonly JobFeed[] = [];

/** A job the person adds by URL or by text, before the store saves it. */
export interface ExternalJobDraft {
  raw: RawJob;
  sourceId: 'external:url' | 'external:text';
  warnings: string[];
}

/** Reads a job page with a plain GET (JSON-LD JobPosting first, then the page text). Never a never-crawl host. */
export async function jobFromUrl(url: string, http: FeedHttp): Promise<ExternalJobDraft> { return notImplemented('jobFromUrl'); }

/** Builds a job from pasted text. Facts the text does not state stay unknown. */
export function jobFromText(text: string, applyUrl: string | null): ExternalJobDraft { return notImplemented('jobFromText'); }

/** Paid page fetch and web search. Each call states its price first; nothing runs while `enabled` is false. */
export interface MeteredFetchClient {
  readonly enabled: boolean;
  /** Prices per request in micros (publik list: search, plain page, JS page). */
  prices(): { search: number; page: number; jsPage: number };
  fetchPage(url: string, opts: { js: boolean; maxPriceMicros: number; signal?: AbortSignal }): Promise<{ url: string; html: string; costMicros: number }>;
  search(query: string, opts: { maxPriceMicros: number; signal?: AbortSignal }): Promise<{ results: Array<{ title: string; url: string; snippet: string }>; costMicros: number }>;
}

/** The metered client. It refuses every call until the person turns metered fetch on (ai-engine O15). */
export function createMeteredFetchClient(opts: {
  enabled: () => boolean;
  baseUrl: string;
  key: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): MeteredFetchClient {
  return notImplemented('createMeteredFetchClient');
}
