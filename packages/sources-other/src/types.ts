// Types of the sources-other lane. The first block is the interface the foundation fixed in docs/INTERFACES.md
// (FeedHttp, FeedContext, FeedResult, JobFeed). Everything after it is additive: optional fields and new types.

import type {
  Credit, EmploymentType, JobEvidence, Level, Pay, Place, PostingStatements, RemoteScope, SourceInfo, WorkModel,
} from '@jobleft/contracts';
import type { RawJob } from '@jobleft/crawler';

/** Options for one request. Only FeedClient implements them; a plain crawler HttpClient ignores them. */
export interface FeedRequestOptions {
  accept?: string;
  /** Extra headers the source's own documentation requires (for example USAJOBS `Authorization-Key`). */
  headers?: Record<string, string>;
  /**
   * Replaces the fixed jobleft User-Agent for this request. Only USAJOBS uses it (its terms ask for the registered
   * email there, sources-other O11). The client refuses it for any host outside the source's own hosts.
   */
  userAgent?: string;
  /** A conditional GET: send If-None-Match with this ETag. */
  ifNoneMatch?: string | null;
}

export interface FeedResponse {
  status: number;
  body: string;
  etag: string | null;
  /** Seconds from a Retry-After header, when present. */
  retryAfterSeconds: number | null;
}

/** The network a feed may use: the crawler's polite HttpClient (pacer, robots.txt, never-crawl list, User-Agent). */
export interface FeedHttp {
  getJson(url: string): Promise<unknown>;
  getText(url: string, accept?: string): Promise<string>;
  /** Richer call (headers a source requires, conditional GET). Present on FeedClient. */
  request?(url: string, opts?: FeedRequestOptions): Promise<FeedResponse>;
}

export interface FeedContext {
  http: FeedHttp;
  /** The source's key from the secret store; null when the source needs none or none is saved. */
  key: string | null;
  now: number;
  signal?: AbortSignal;
  /** The ETag kept from the last good answer of a single-file source (conditional GET). */
  etag?: string | null;
}

/** Facts as the source states them. `null` = the source does not say (never a default). */
export interface FeedFacts {
  places: Place[];
  workModel: WorkModel | null;
  remoteScope: RemoteScope | null;
  employmentType: EmploymentType | null;
  level: Level | null;
  pay: Pay | null;
  postedAt: string | null;
  /** true = in the US or open to US applicants (stated), false = clearly elsewhere, null = cannot tell. */
  isUs: boolean | null;
  statements: PostingStatements;
  evidence: JobEvidence;
}

/** One posting read from a feed. */
export interface FeedPosting {
  raw: RawJob;
  /** The posting's page on this source: the link back that the source's terms ask for. */
  sourceUrl: string;
  facts: FeedFacts;
  /** A per-posting credit (for example the HN thread it was posted in). Defaults to the feed's credit. */
  credit?: Credit | null;
}

export interface FeedResult {
  /** Postings in the crawler's RawJob shape, so they share normalisation and dedupe. */
  jobs: RawJob[];
  /** true when this answer is the whole feed (only then may jobs missing from it be closed). */
  complete: boolean;
  /** The same postings with the facts the source states (FeedClient-era feeds always fill it). */
  postings?: FeedPosting[];
  /** Ids of listed postings that could not be read. They count as still listed (never closed by this run). */
  unreadableIds?: string[];
  /** Listed postings that could not be read and have no id. Any such posting stops closing for this run. */
  unreadableWithoutId?: number;
  /** Items that are not postings by the source's own rules (HN replies, inactive list rows). Informational. */
  skipped?: number;
  /** 304 Not Modified: nothing changed since the kept ETag. Every listed job counts as seen again. */
  notModified?: boolean;
  /** The ETag of this answer, kept for the next conditional GET. */
  etag?: string | null;
  /** Plain notes for the run report (for example "read 3 of 4 files"). */
  notes?: string[];
  /**
   * Set when part of the feed failed (for example page 3 of 5). The postings read are stored, nothing is closed,
   * and the source shows this problem as failing.
   */
  problem?: string;
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
  // ---- additive (sources-other lane) ----
  /** Real hosts this feed may contact. Any other host is refused before a request is made. */
  readonly hosts?: readonly string[];
  /** At most this many HTTP requests in one run and in any 24 hours (robots.txt and retries count). */
  readonly requestLimits?: { perRun: number; perDay: number };
  /** Plain steps to get and save a key (shown with the "needs a key" status). */
  readonly keyHelp?: string;
  /** Checks a key's format before it is saved. Returns a plain reason when it is wrong. */
  checkKey?(key: string): string | null;
}

/** Reads a saved source key. The server backs it with the OS secret store; the CLI with environment variables. */
export type KeyReader = (sourceId: string) => Promise<string | null>;
