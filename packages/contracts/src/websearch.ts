// Web search through the person's own SearXNG (Settings > Web search). jobleft sends the search words to that one
// address and reads its JSON answer; SearXNG asks the search engines. A result page is opened only when the person
// adds the job, through the same read as add-by-link (robots.txt, the never-contact list). Added after contracts
// 1.1.0 (new routes; additive).

import { HttpUrlSchema, IdSchema, IsoDateTimeSchema } from './common.ts';
import { CrawlAtsIdSchema } from './job.ts';
import { arr, bool, enm, int, named, nullable, obj, str, type Infer } from './schema.ts';

/** The answer to "does this SearXNG work?". */
export const WebSearchCheckSchema = named(obj({
  ok: bool(),
  /** One plain sentence: what works, or what to change and where. */
  message: str(),
  /** Search engines that answered the test search. */
  engines: arr(str()),
  /** Engines SearXNG reported as not answering (blocked, CAPTCHA, timeout). */
  unresponsive: arr(str()),
  results: int({ minimum: 0 }),
  /**
   * Engines whose answers kept to the sites asked for ("site:"). jobleft's searches need at least one: an engine that
   * ignores "site:" answers with any page about the words.
   */
  siteEngines: arr(str()),
}), 'WebSearchCheck');

export const WebSearchRequestSchema = named(obj({
  /** What the person is looking for: a title, skills or a company. */
  q: str({ minLength: 1, maxLength: 200 }),
}, {
  /** Where: a city, region or country, in the person's words. */
  place: str({ maxLength: 200 }),
  /** Only results the engines date within this time. Absent = any time. */
  timeRange: enm(['day', 'week', 'month', 'year']),
  /** Which page of results: 1 first (the default; the engines' pages 1 and 2), 2 for "More results" (3 and 4), and so on. */
  page: int({ minimum: 1, maximum: 5 }),
  /**
   * Ask the AI provider for titles that mean the same job (in Dutch and English for a Dutch place) and search for
   * those too. One small AI call, remembered for a day. Without a provider the search runs with the words given.
   */
  widen: bool(),
}), 'WebSearchRequest');

/**
 * What jobleft can do with a result:
 * - board_job: one job on a board jobleft reads (it can add the job, and follow the board);
 * - board: a board's own page on a system jobleft reads (it can follow the board);
 * - page: another site; adding the job reads the page once, if robots.txt allows;
 * - list: a page that lists many jobs (a job site's search page): open it in the browser;
 * - never: a site jobleft never contacts (LinkedIn, Indeed, Glassdoor, Workday and the others). Open it in the
 *   browser, or paste the job text into External.
 */
export const WebSearchKindSchema = enm(['board_job', 'board', 'page', 'list', 'never']);

export const WebSearchResultSchema = named(obj({
  url: HttpUrlSchema,
  title: str(),
  /** The engines' short text about the page (untrusted text). */
  snippet: str(),
  host: str(),
  kind: WebSearchKindSchema,
  ats: nullable(CrawlAtsIdSchema),
  board: nullable(str()),
  region: nullable(str()),
  /** "<ats>:<board>" or "<ats>:<region>:<board>" when the result is on a board. */
  boardId: nullable(str()),
  /** The date an engine gives for the page, when it gives one. */
  publishedAt: nullable(IsoDateTimeSchema),
  engines: arr(str()),
  /** The job's id when jobleft already has this job (in the feed or added before). */
  jobId: nullable(IdSchema),
  /** Why jobleft does not open the page (kind "never"). null otherwise. */
  note: nullable(str()),
}), 'WebSearchResult');

/** A board that the results named, with how many results came from it. */
export const WebSearchBoardSchema = named(obj({
  boardId: str({ minLength: 3 }),
  ats: CrawlAtsIdSchema,
  board: str({ minLength: 1 }),
  region: nullable(str()),
  /** The employer name jobleft already knows for the board. null = not known yet (follow it to find out). */
  company: nullable(str()),
  results: int({ minimum: 1 }),
  /** In the person's board list (followed or not). */
  added: bool(),
  followed: bool(),
}), 'WebSearchBoard');

export const WebSearchResponseSchema = named(obj({
  results: arr(WebSearchResultSchema),
  /** Boards the results named. Empty since the open-web search (boards are followed in Settings > Job sources). */
  boards: arr(WebSearchBoardSchema),
  /** Searches sent to SearXNG, and how many of them failed. */
  queries: int({ minimum: 0 }),
  failedQueries: int({ minimum: 0 }),
  /** Engines SearXNG reported as not answering during this search. */
  unresponsive: arr(str()),
  /** One plain sentence about the search as a whole. */
  message: str(),
}, {
  /** The country the place names ("Netherlands", "Utrecht" -> NL), when jobleft knows it: results are checked against it. */
  country: nullable(str()),
  /** Results on job boards jobleft reads, left out: follow those boards instead. */
  boardResults: int({ minimum: 0 }),
  /**
   * The same search on job sites jobleft never contacts, as links for the browser (LinkedIn, Indeed, Glassdoor,
   * Google's job search). jobleft only builds the address; the person's browser opens it.
   */
  searchLinks: arr(obj({ name: str(), url: HttpUrlSchema })),
  /** The titles the AI added when the search was widened. */
  widenedWith: arr(str()),
  /** Why the search was not widened, when it was asked to be (no provider, the provider failed). */
  widenProblem: str(),
  /** Results left out because neither their title nor their text names any word of the titles searched for. */
  unrelatedResults: int({ minimum: 0 }),
}), 'WebSearchResponse');

/** What came of reading one result (Jobs > Web jobs shows it on the result). */
export const WebResultOutcomeSchema = named(obj({
  url: str(),
  /** likely_job: the title names the job searched for and the address reads like one job, but the page's details could not be read (a page built by script). */
  state: enm(['unread', 'queued', 'reading', 'job', 'known', 'likely_job', 'closed', 'not_job', 'off_topic', 'refused', 'failed']),
  message: nullable(str()),
  /** The job the page is, when it is one. */
  job: nullable(obj({
    id: IdSchema, title: str(), company: str(), places: str(), countries: arr(str()), remote: bool(), postedAt: nullable(IsoDateTimeSchema),
  })),
  /** Whether the job is in the country asked for: null when unknown (no place stated, or not a job). */
  inPlace: nullable(bool()),
}), 'WebResultOutcome');

export type WebResultOutcome = Infer<typeof WebResultOutcomeSchema>;

/** The background reading of web search results (each job page is read once and becomes a job card). */
export const WebReadStatusSchema = named(obj({
  running: bool(),
  /** Addresses waiting to be read. */
  queued: int({ minimum: 0 }),
  /** Since jobleft started: addresses read, jobs added, jobs found closed, reads that failed. */
  read: int({ minimum: 0 }),
  added: int({ minimum: 0 }),
  closed: int({ minimum: 0 }),
  failed: int({ minimum: 0 }),
  /** Every job web search has found and kept. */
  jobs: int({ minimum: 0 }),
}), 'WebReadStatus');

/**
 * A saved web search: it runs by itself every `everyHours` hours (12 or 24; 0 = only by hand) while jobleft runs, asks for the
 * past week, and the job pages it finds are read like any search's. An alert names the jobs that are new.
 */
export const WebSavedSearchSchema = named(obj({
  id: IdSchema,
  q: str({ minLength: 1, maxLength: 200 }),
  place: nullable(str({ maxLength: 200 })),
  everyHours: int({ minimum: 0, maximum: 24 }),
  createdAt: IsoDateTimeSchema,
  lastRunAt: nullable(IsoDateTimeSchema),
  /** New jobs the last run found (after their pages were read). null until it ran and its pages were read. */
  lastNew: nullable(int({ minimum: 0 })),
  lastError: nullable(str()),
}, {
  /** Widened with the AI provider's titles when it runs (as it was when saved). */
  widen: bool(),
}), 'WebSavedSearch');

export const WebSavedSearchInputSchema = named(obj({
  q: str({ minLength: 1, maxLength: 200 }),
}, {
  place: str({ maxLength: 200 }),
  everyHours: int({ minimum: 0, maximum: 24 }),
  widen: bool(),
}), 'WebSavedSearchInput');

export type WebSavedSearch = Infer<typeof WebSavedSearchSchema>;
export type WebSavedSearchInput = Infer<typeof WebSavedSearchInputSchema>;
export type WebReadStatus = Infer<typeof WebReadStatusSchema>;
export type WebSearchCheck = Infer<typeof WebSearchCheckSchema>;
export type WebSearchRequest = Infer<typeof WebSearchRequestSchema>;
export type WebSearchKind = Infer<typeof WebSearchKindSchema>;
export type WebSearchResult = Infer<typeof WebSearchResultSchema>;
export type WebSearchBoard = Infer<typeof WebSearchBoardSchema>;
export type WebSearchResponse = Infer<typeof WebSearchResponseSchema>;
