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
  /** Which page of the engines' answers: 1 first (the default), 2 for "More results", and so on. */
  page: int({ minimum: 1, maximum: 5 }),
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
  boards: arr(WebSearchBoardSchema),
  /** Searches sent to SearXNG, and how many of them failed. */
  queries: int({ minimum: 0 }),
  failedQueries: int({ minimum: 0 }),
  /** Engines SearXNG reported as not answering during this search. */
  unresponsive: arr(str()),
  /** One plain sentence about the search as a whole. */
  message: str(),
}), 'WebSearchResponse');

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
}), 'WebSavedSearch');

export const WebSavedSearchInputSchema = named(obj({
  q: str({ minLength: 1, maxLength: 200 }),
}, {
  place: str({ maxLength: 200 }),
  everyHours: int({ minimum: 0, maximum: 24 }),
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
