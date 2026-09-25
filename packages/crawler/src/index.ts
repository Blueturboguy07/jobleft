// @jobleft/crawler: the crawler core, ported from the S1 spike (spikes/s1-ingest/crawler/src).
//   adapters -> polite HTTP client (pacer, robots.txt, never-crawl list) -> normalise -> dedupe -> store -> sweep
// Interface: docs/INTERFACES.md, section "@jobleft/crawler". The CLI lives in src/cli.ts (not exported here,
// because it runs on import).

export const PACKAGE_NAME = '@jobleft/crawler';

// Adapter contract and crawl types
export type {
  Ats, BoardRef, BoardStats, HttpGetter, Job, Job as CrawledJob, Level, PayPeriod, RawJob, RawPay, Source, SourceRegistry,
  WorkMode,
} from './types.ts';

// The only code that touches the network
export {
  BlockedError, BudgetError, DeniedHostError, HostMapError, HostTrippedError, HttpClient, HttpError, NotFoundError,
  Pacer, PRODUCT_TOKEN, RobotsError, USER_AGENT, checkHostMap, hostMapFromEnv,
} from './http.ts';
export type { HostStats, HttpOptions } from './http.ts';

// robots.txt (RFC 9309)
export { ALLOW_ALL, DISALLOW_ALL, parseRobots } from './robots.ts';
export type { RobotsRules } from './robots.ts';

// Normalisation and dedupe spine
export {
  canonicalizeUrl, cleanText, contentHash, dedupHash, dedupeBatch, normalizeCompany, normalizeTitle, partitionNew,
} from './normalize.ts';
export type { CanonOptions, DedupeItem, TitleOptions } from './normalize.ts';
export { normalizeJob } from './job.ts';

// Close-vanished lifecycle (pure guards)
export {
  COOLDOWN_BASE_MS, COOLDOWN_MAX_MS, COOLDOWN_THRESHOLD, DEFAULT_SWEEP_GRACE_MS, EMPTY_FEED_MIN_STREAK, MAX_CLOSE_SHARE,
  MAX_UNREADABLE_PERCENT, boardListedAnyPosting, boardQualifies, boardReachedPostings, boardReadWhatItListed,
  closeTooBroad, cooldownFor, emptyFeedShouldClose, emptyStats, shouldSweep, sweepableBoards,
} from './lifecycle.ts';
export type { SweepCandidate } from './lifecycle.ts';

// SQLite crawl store (tables: jobs, jobs_fts, boards)
export { Store } from './store.ts';
export type { BoardRow, SaveResult, SaveStatus, StoreOptions } from './store.ts';

// Orchestrator
export { crawl } from './crawl.ts';
export type { BoardResult, BoardStatus, CrawlOptions, HttpMetrics, RunReport } from './crawl.ts';

// Built-in adapters (Greenhouse, Lever, Ashby) and their hosts
export { SOURCES, hostFor } from './sources/index.ts';
export { ashby, mapAshby } from './sources/ashby.ts';
export { greenhouse, mapGreenhouse, PAY_QUERY } from './sources/greenhouse.ts';
export { lever, mapLever } from './sources/lever.ts';
export {
  arr, countryFromCode, employmentTypeFromText, isRemote, isoDate, makePay, num, obj, roundSalaryPart, str,
  workModeFromRemote, workplaceTypeMode,
} from './sources/util.ts';
