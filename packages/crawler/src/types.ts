// Shared types. Erasable TypeScript only (no enums, no parameter properties) so that
// Node 24 can run the files directly with type stripping and no build step.

import type { CrawlAtsId } from '@jobleft/contracts';
import type { Level, PayPeriod } from '@jobleft/parsers';
export type { Level, PayPeriod };

/** An ATS family the crawler may crawl (the contract list: greenhouse, lever, ashby, workable, recruitee, personio). */
export type Ats = CrawlAtsId;
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | '';

/** One company board on one ATS. `board` is the token in the public API path. */
export interface BoardRef {
  ats: Ats;
  board: string;
  company: string;
  /** Lever only: "eu" selects api.eu.lever.co. */
  region?: string;
}

/** Pay exactly as the ATS API states it. Never parsed from free text. */
export interface RawPay {
  min: number | null;
  max: number | null;
  currency: string;
  period: PayPeriod;
}

/** One posting as an adapter reads it from the ATS, before normalisation. */
export interface RawJob {
  externalId: string;
  /** Public job page. */
  url: string;
  /** Apply page when the API gives one, else empty (the store falls back to `url`). */
  applyUrl: string;
  title: string;
  company: string;
  location: string;
  /** HTML as served (Greenhouse serves it entity-encoded). Converted to text by the store path. */
  descriptionHtml: string;
  remote: boolean;
  workMode: WorkMode;
  /** ISO alpha-2 codes when the API states a country, e.g. ["US"]. */
  countries: string[];
  /** ISO 8601, or null when the API gives no usable date. */
  postedAt: string | null;
  /** full_time | part_time | contract | internship | "" */
  employmentType: string;
  department: string;
  pay: RawPay | null;
  /** The listing named the posting but its detail could not be read (freehire "Unreadable"). */
  unreadable?: boolean;
}

/** The only thing an adapter may do to the network. The pacer, robots check and UA live behind it. */
export interface HttpGetter {
  getJson(url: string): Promise<unknown>;
}

/** Adapter contract (mirrors freehire `Source`: Provider() + Fetch()). */
export interface Source {
  readonly ats: Ats;
  /**
   * True when ONE request returns the whole board, with no pagination loop that could stop early.
   * Only such a source may close postings by absence (freehire `fullBoardListing` marker).
   */
  readonly fullBoardListing: boolean;
  fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]>;
  /** The host this board is fetched from (boards on one host run in series). Built-in adapters use hostFor(). */
  host?(board: BoardRef): string;
}

/** Adapters by ATS. A crawl may run with only some of them; a board whose ATS has no adapter fails with a reason. */
export type SourceRegistry = Partial<Record<Ats, Source>>;

/** A normalised job, ready for the store. */
export interface Job {
  ats: Ats;
  board: string;
  jobId: string;
  applyUrl: string;
  canonicalUrl: string;
  dedupHash: string;
  title: string;
  company: string;
  companySlug: string;
  location: string;
  remote: boolean;
  workMode: WorkMode;
  /** 1 US, 0 not US, null unknown (e.g. plain "Remote"). */
  isUs: boolean | null;
  level: Level | null;
  levelSource: 'title' | 'description' | null;
  payMin: number | null;
  payMax: number | null;
  payCurrency: string | null;
  payPeriod: PayPeriod | null;
  payMinAnnual: number | null;
  payMaxAnnual: number | null;
  paySource: 'api' | 'text' | null;
  postedAt: string | null;
  employmentType: string;
  department: string;
  description: string;
  contentHash: string;
}

export interface BoardStats {
  /** Postings saved or refreshed. */
  ingested: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Postings whose canonical URL already belongs to another stored row. */
  dupUrl: number;
  /** Stored rows flagged as a repost of an older (company, title) role. */
  dupRole: number;
  /** Fetched but not persistable (no title, id or URL). */
  skipped: number;
  /** freehire "rejected by catalogue filter". Always 0 here: this crawler has no IT-only gate. */
  rejected: number;
  unreadable: number;
  /** 1 when the board fetch itself failed. */
  failed: number;
}
