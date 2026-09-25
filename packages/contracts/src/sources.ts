// Boards, sources, crawl progress and reports, fit-index status, shipped datasets and the static-data lookups.

import { CreditSchema, HttpUrlSchema, IsoDateSchema, IsoDateTimeSchema, MicrosSchema } from './common.ts';
import { H1bSummarySchema } from './company.ts';
import { CrawlAtsIdSchema, PlaceSchema } from './job.ts';
import { arr, bool, enm, int, named, nullable, obj, str, type Infer } from './schema.ts';

export const BoardStateSchema = enm(['not_checked', 'live', 'failing', 'unreachable', 'cooldown', 'blocked']);

/** One board in the user's list: from the shipped directory or added by the user. */
export const BoardEntrySchema = named(obj({
  /** "<ats>:<board>" or "<ats>:<region>:<board>", lower case. */
  id: str({ minLength: 3 }),
  ats: CrawlAtsIdSchema,
  board: str({ minLength: 1 }),
  region: nullable(str()),
  /** The employer name the board itself or the directory reports. Never guessed. */
  company: str({ minLength: 1 }),
  origin: enm(['directory', 'user']),
  followed: bool(),
  hidden: bool(),
  disabled: bool(),
  state: BoardStateSchema,
  lastCheckAt: nullable(IsoDateTimeSchema),
  lastSuccessAt: nullable(IsoDateTimeSchema),
  nextCheckAt: nullable(IsoDateTimeSchema),
  /** Open jobs from the last good check. null before the first check. */
  openJobs: nullable(int({ minimum: 0 })),
  lastError: nullable(str()),
}), 'BoardEntry');

/** The answer to "what board is behind this link?". Nothing is added until the user confirms. */
export const BoardResolveResponseSchema = named(obj({
  candidates: arr(obj({
    boardId: str(),
    ats: CrawlAtsIdSchema,
    board: str(),
    region: nullable(str()),
    company: str(),
    openJobs: nullable(int({ minimum: 0 })),
    alreadyAdded: bool(),
  })),
  /** Why there is no candidate. null when there is at least one. */
  reason: nullable(enm([
    'not_a_link', 'broken_link', 'unsupported_provider', 'forbidden_host', 'no_board_found', 'blocked_by_robots', 'offline',
  ])),
  message: str(),
  /** A paid lookup the user may accept, with its price in dollars from the balance. null = none offered. */
  paidLookup: nullable(obj({ priceMicros: MicrosSchema })),
}), 'BoardResolveResponse');

/** One job source (an ATS family or another feed): crawled or not, why, and how it is doing. */
export const SourceInfoSchema = named(obj({
  id: str({ minLength: 1 }),
  name: str(),
  kind: enm(['ats', 'job_board', 'government', 'community', 'search_partner']),
  crawled: bool(),
  /** Why it is not crawled (no public feed, robots.txt, terms, login, owner approval). null when crawled. */
  reason: nullable(str()),
  /** The date the reason or the evidence was checked. */
  checkedOn: IsoDateSchema,
  evidenceUrl: nullable(HttpUrlSchema),
  enabled: bool(),
  needsKey: bool(),
  keySet: bool(),
  credit: nullable(CreditSchema),
  /** The source's own limits in words, e.g. "4 fetches a day". */
  limits: nullable(str()),
  status: obj({
    state: enm(['never_run', 'ok', 'failing', 'needs_key', 'off', 'rate_limited']),
    lastSuccessAt: nullable(IsoDateTimeSchema),
    openJobs: nullable(int({ minimum: 0 })),
    lastProblem: nullable(str()),
    nextAllowedAt: nullable(IsoDateTimeSchema),
  }),
}), 'SourceInfo');

export const CrawlRunSummarySchema = named(obj({
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  boards: int({ minimum: 0 }),
  ok: int({ minimum: 0 }),
  failed: int({ minimum: 0 }),
  inserted: int({ minimum: 0 }),
  updated: int({ minimum: 0 }),
  closed: int({ minimum: 0 }),
  requests: int({ minimum: 0 }),
}), 'CrawlRunSummary');

export const CrawlProgressSchema = named(obj({
  running: bool(),
  reason: nullable(enm(['first_run', 'launch_catch_up', 'schedule', 'manual'])),
  boardsDone: int({ minimum: 0 }),
  boardsTotal: int({ minimum: 0 }),
  jobsSeen: int({ minimum: 0 }),
  startedAt: nullable(IsoDateTimeSchema),
  nextScheduledAt: nullable(IsoDateTimeSchema),
  lastRun: nullable(CrawlRunSummarySchema),
}, {
  // Added by the i-core lane (additive): a plain note when the last refresh attempt could not reach the job boards
  // (offline), naming the attempt time and the last successful refresh. Absent = nothing to report.
  offlineNote: str(),
}), 'CrawlProgress');

/** One board's line in the crawl report (crawler O4, O9; sources-ats O4, O13). */
export const CrawlBoardReportSchema = named(obj({
  boardId: str(),
  status: enm(['ok', 'failed', 'cooled', 'blocked', 'host_skipped', 'robots', 'forbidden', 'no_adapter']),
  /** A short plain reason for anything but ok. */
  reason: nullable(str()),
  listed: int({ minimum: 0 }),
  inserted: int({ minimum: 0 }),
  updated: int({ minimum: 0 }),
  unchanged: int({ minimum: 0 }),
  skipped: int({ minimum: 0 }),
  unreadable: int({ minimum: 0 }),
  closed: int({ minimum: 0 }),
  /** Set when a close was held (for example over half of a big board at once). */
  closeHeld: nullable(str()),
  requests: int({ minimum: 0 }),
  finishedAt: IsoDateTimeSchema,
}), 'CrawlBoardReport');

export const FitIndexStatusSchema = named(obj({
  state: enm(['ready', 'indexing', 'model_missing', 'downloading', 'failed']),
  model: nullable(str()),
  /** Download size and source of the model, stated before the first download. */
  modelBytes: nullable(int({ minimum: 0 })),
  modelSource: nullable(HttpUrlSchema),
  indexed: int({ minimum: 0 }),
  waiting: int({ minimum: 0 }),
  lastRun: nullable(obj({ indexed: int({ minimum: 0 }), startedAt: IsoDateTimeSchema, finishedAt: nullable(IsoDateTimeSchema) })),
}), 'FitIndexStatus');

/** A dataset that ships with the app or is updated from a release file. */
export const DatasetInfoSchema = named(obj({
  id: str(),
  name: str(),
  version: str(),
  /** Newest record date in the data (for example the last filing date). */
  dataThrough: nullable(IsoDateSchema),
  licence: str(),
  attribution: nullable(str()),
  sourceUrl: nullable(HttpUrlSchema),
  bytes: int({ minimum: 0 }),
  updatedAt: IsoDateTimeSchema,
  /** The last update attempt failed and the previous data is still in use. */
  lastUpdateError: nullable(str()),
}), 'DatasetInfo');

export const H1bLookupSchema = named(obj({
  input: str(),
  companyKey: nullable(str()),
  /** unknown = not in the data or not sure. Never "no". */
  status: enm(['found', 'unknown']),
  summary: nullable(H1bSummarySchema),
}), 'H1bLookup');

export const PlaceLookupSchema = named(obj({
  input: str(),
  /** The resolved places (several for "New York, NY; Austin, TX"). */
  places: arr(PlaceSchema),
  /** Same-named places the input could mean ("Portland" without a state). */
  ambiguous: arr(PlaceSchema),
  /** The input names a work model or a country, not a city ("Remote - US", "United States"). */
  notACity: bool(),
}), 'PlaceLookup');

export const StorageInfoSchema = named(obj({
  dataDir: str(),
  dbPath: str(),
  dbBytes: int({ minimum: 0 }),
  jobs: int({ minimum: 0 }),
  openJobs: int({ minimum: 0 }),
}), 'StorageInfo');

export const ExternalJobRequestSchema = named(obj({}, {
  /** A job page URL (any site but the never-crawl hosts). */
  url: HttpUrlSchema,
  /** Or the pasted posting text. */
  text: str({ maxLength: 200_000 }),
  /** With pasted text: the apply link, if the user has one. */
  applyUrl: HttpUrlSchema,
}), 'ExternalJobRequest');

export type BoardState = Infer<typeof BoardStateSchema>;
export type BoardEntry = Infer<typeof BoardEntrySchema>;
export type BoardResolveResponse = Infer<typeof BoardResolveResponseSchema>;
export type SourceInfo = Infer<typeof SourceInfoSchema>;
export type CrawlRunSummary = Infer<typeof CrawlRunSummarySchema>;
export type CrawlProgress = Infer<typeof CrawlProgressSchema>;
export type CrawlBoardReport = Infer<typeof CrawlBoardReportSchema>;
export type FitIndexStatus = Infer<typeof FitIndexStatusSchema>;
export type DatasetInfo = Infer<typeof DatasetInfoSchema>;
export type H1bLookup = Infer<typeof H1bLookupSchema>;
export type PlaceLookup = Infer<typeof PlaceLookupSchema>;
export type StorageInfo = Infer<typeof StorageInfoSchema>;
export type ExternalJobRequest = Infer<typeof ExternalJobRequestSchema>;

/** A desktop notification the shell shows (new matches, tracker reminders, follow-ups). Never repeated once acked. */
export const NotificationSchema = named(obj({
  id: str({ minLength: 1 }),
  kind: enm(['new_matches', 'reminder', 'follow_up', 'saved_filter_alert']),
  title: str({ maxLength: 120 }),
  body: str({ maxLength: 400 }),
  /** The screen to open when the person clicks it, e.g. "/jobs/<id>". */
  target: nullable(str()),
  createdAt: IsoDateTimeSchema,
}), 'Notification');

export type Notification = Infer<typeof NotificationSchema>;
