// @jobleft/crawler: the crawler core, ported from the S1 spike (spikes/s1-ingest/crawler/src) and grown by the crawler
// lane into a production crawler.
//   adapters -> polite HTTP client (pacer, robots.txt, never-crawl list, conditional requests) -> normalise -> store
//   -> read each board's listing -> close what two complete readings agree is gone
//   scheduler: a catch-up run on launch, a refresh on schedule, resumable runs, crawl reports
// Interface: docs/INTERFACES.md, section "@jobleft/crawler". The CLI lives in src/cli.ts (not exported here,
// because it runs on import).

export const PACKAGE_NAME = '@jobleft/crawler';

// Adapter contract and crawl types
export type {
  Ats, BoardRef, BoardStats, HttpGetter, Job, Job as CrawledJob, Level, PayPeriod, RawJob, RawPay, Source, SourceRegistry,
  WorkMode,
} from './types.ts';

// Configuration and identity
export {
  ConfigError, DEFAULT_CONFIG, DEFAULT_USER_AGENT, checkUserAgent, loadConfigFile, makeConfig, productTokenOf,
} from './config.ts';
export type { CrawlerConfig } from './config.ts';

// Hosts the crawler may and may not contact
export { HELD_BACK_FAMILIES, forbiddenHostOf, forbiddenReason, isLocalName, isPrivateAddress, loopbackOrigin } from './hosts.ts';
export type { ForbiddenHost, ForbiddenKind } from './hosts.ts';

// The only code that touches the network
export {
  AbortedError, BlockedError, BoardHttp, BudgetError, CutOffError, DeniedHostError, HeldBackHostError, HostFailingError, HostMapError,
  HostTrippedError, HostWaitError, HttpClient, HttpError, NetworkError, NotFoundError, NotJobDataError, NotModifiedError, Pacer,
  PRODUCT_TOKEN, PrivateAddressError, RedirectError, RequestTimeoutError, RobotsError, TooLargeError, USER_AGENT, checkHostMap,
  hostMapFromEnv, parseJobJson,
} from './http.ts';
export type {
  BoardHttpOptions, HostRecord, HostStateStore, HostStats, HttpOptions, HttpResult, RequestOptions, RobotsRecord, Validators,
} from './http.ts';

export { nodeTransport } from './transport.ts';
export type { TransportOptions } from './transport.ts';

// Failures in plain words
export { BoardDeadlineError, TooManyJobsError, describeFailure } from './failures.ts';
export type { BoardStatus, Failure, ReasonCode } from './failures.ts';

// robots.txt (RFC 9309)
export { ALLOW_ALL, DISALLOW_ALL, parseRobots } from './robots.ts';
export type { RobotsRules } from './robots.ts';

// Normalisation and dedupe spine
export {
  canonicalizeUrl, cleanText, contentHash, dedupHash, dedupeBatch, normalizeCompany, normalizeTitle, partitionNew,
} from './normalize.ts';
export type { CanonOptions, DedupeItem, TitleOptions } from './normalize.ts';
export { httpUrl, normalizeJob, roleKeyOf, skipReason } from './job.ts';
export { isGenericPlace, parsePlace, remoteRegions, splitPlaces, workModelOf } from './places.ts';
export type { WorkModelFact } from './places.ts';

// Close-vanished lifecycle (pure guards)
export {
  COOLDOWN_BASE_MS, COOLDOWN_MAX_MS, COOLDOWN_THRESHOLD, DEFAULT_SWEEP_GRACE_MS, EMPTY_FEED_MIN_STREAK, MAX_CLOSE_SHARE,
  MAX_UNREADABLE_PERCENT, boardListedAnyPosting, boardQualifies, boardReachedPostings, boardReadWhatItListed,
  closeTooBroad, cooldownFor, emptyFeedShouldClose, emptyStats, shouldSweep, sweepableBoards,
} from './lifecycle.ts';
export type { SweepCandidate } from './lifecycle.ts';

// SQLite crawl store (tables: jobs, jobs_fts, boards, job_sources, crawler_*)
export { ATS_NAMES, CRAWLER_SCHEMA_VERSION, SchemaTooNewError, Store } from './store.ts';
export type { BoardRow, ClosePolicy, ReadingResult, SaveResult, SaveStatus, StoreOptions } from './store.ts';

// Contract Job records from crawl rows
export { ftsQuery, getJobById, jobIdOf, queryJobs, simpleCompanyKey, toContractJob } from './contract.ts';
export type { JobPage, JobQuery, JobRow, ToJobOptions } from './contract.ts';

// Runs (resumable) and the crawl lease
export { Runs } from './runs.ts';
export type { BoardOutcome, RunBoardRow, RunReason, RunRow, RunState } from './runs.ts';

// Orchestrator
export { DEFAULT_CONFIRM_GAP_MS, DEFAULT_MAX_JOBS_PER_BOARD, DEFAULT_NOT_FOUND_CLOSE_MS, crawl } from './crawl.ts';
export type { BoardResult, CrawlOptions, HttpMetrics, RunReport } from './crawl.ts';

// Built-in adapters (Greenhouse, Lever, Ashby) and their hosts
export { SOURCES, hostFor } from './sources/index.ts';
export { ashby, mapAshby } from './sources/ashby.ts';
export { greenhouse, mapGreenhouse, PAY_QUERY } from './sources/greenhouse.ts';
export { lever, mapLever } from './sources/lever.ts';
export {
  arr, countryFromCode, employmentTypeFromText, isRemote, isoDate, makePay, num, obj, roundSalaryPart, str, unmappable,
  workModeFromRemote, workplaceTypeMode,
} from './sources/util.ts';
