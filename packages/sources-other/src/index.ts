// @jobleft/sources-other: job sources that are not an employer's ATS board (government APIs, remote-job boards,
// community lists, per-query partners when approved), add-a-job by URL or by pasted text, and the metered fetch
// and search client (paid, through publik or the user's own provider key, OFF until the person turns it on).
// Interface: docs/INTERFACES.md, section "@jobleft/sources-other". Source notes: docs/sources/*.md.

export const PACKAGE_NAME = '@jobleft/sources-other';

// ---- the interface fixed by the foundation (plus additive fields) ----
export type {
  FeedContext, FeedFacts, FeedHttp, FeedPosting, FeedRequestOptions, FeedResponse, FeedResult, JobFeed, KeyReader,
} from './types.ts';

// ---- the sources ----
export { ALL_FEEDS, LISTED_ONLY, OTHER_FEEDS, ROBOTS_EXCEPTIONS, feedById, keyEnvName } from './catalog.ts';
export { parseRemoteOk, remoteOk, REMOTEOK_CREDIT, REMOTEOK_URL } from './feeds/remoteok.ts';
export { parseRemotive, remotive, REMOTIVE_CREDIT, REMOTIVE_URL } from './feeds/remotive.ts';
export { MUSE_BASE, MUSE_CREDIT, MUSE_SLICE, museUrl, parseMusePage, theMuse } from './feeds/themuse.ts';
export { parseUsajobsPage, parseUsajobsSecret, usajobs, usajobsUrl } from './feeds/usajobs.ts';
export { HN_CREDIT, HN_SEARCH_URL, hnItemUrl, hnPostUrl, hnWhoIsHiring, parseHnComment, parseHnThread, pickHiringThread } from './feeds/hn.ts';
export type { HnThreadRef } from './feeds/hn.ts';
export { GITHUB_FEEDS, GITHUB_LISTS, parseListings, parseSpeedyMarkdown, rawUrl, speedyId } from './feeds/github.ts';
export type { GithubList } from './feeds/github.ts';

// ---- network, limits, storage ----
export { DbPacer, FeedClient, FeedError, MemoryPacer, NEVER_CRAWL, parseJsonBody, shapeError } from './http.ts';
export type { FeedClientOptions, FeedErrorCode, HostPacer } from './http.ts';
export { NewerSchemaError, OWNER, SCHEMA_VERSION, migrateSourcesOther } from './db.ts';
export { DAY_MS, backoffMs, finishRun, getState, nextAllowed, recordRequest, reserveRun, setEnabled } from './limits.ts';
export type { RunReason, Wait, WaitReason } from './limits.ts';
export { MASS_CLOSE_CONFIRM_MS, MASS_CLOSE_MIN_OPEN, MASS_CLOSE_SHARE, applyFeedResult, jobKeyOf, plainProblem, refreshSources } from './runner.ts';
export type { RefreshOptions, SkipReason, SourceRunResult } from './runner.ts';
export { SHOWN_SQL, creditLine, enabledSources, ephemeralJobs, exportFeedJobs, feedJobs, openJobsFor } from './view.ts';
export type { FeedJobQuery } from './view.ts';
export { SourceService, SourceServiceError, envSecretStore } from './service.ts';
export type { RefreshReport, SourceServiceOptions } from './service.ts';
export { atsBoardFromUrl, discoverBoards } from './discover.ts';
export type { AtsLink, BoardCandidate, DiscoveryReport } from './discover.ts';
export {
  countryCode, employmentTypeOf, fixMojibake, makePay, parseRemoteScope, payFromSalaryField, payFromText, placeFromText,
  safeHttpUrl, scopeOpenToUs,
} from './text.ts';

// ---- add a job by URL or text, and the metered client ----
export { jobFromText, jobFromUrl } from './external.ts';
export type { ExternalJobDraft } from './external.ts';
export { METERED_PRICES_MICROS, MeteredFetchError, createMeteredFetchClient } from './metered.ts';
export type { MeteredFetchClient } from './metered.ts';
