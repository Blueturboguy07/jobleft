// Job search: the filter set of the "All Filters" drawer, the three sort orders, saved filters, and results.

import { CountryCodeSchema, IdSchema, IsoDateTimeSchema } from './common.ts';
import { CompanyStageSchema } from './company.ts';
import {
  EmploymentTypeSchema, ExperienceLevelSchema, JobSummarySchema, WorkModelSchema,
} from './job.ts';
import { MatchSummarySchema } from './match.ts';
import { TrackerStatusSchema } from './tracker.ts';
import { arr, bool, enm, int, named, nullable, num, obj, str, type Infer } from './schema.ts';

/** Recommended = relevance, quality and freshness; Top Matched = fit to the profile; Most Recent = posted date. */
export const JobSortSchema = enm(['recommended', 'top_matched', 'most_recent']);

/** A place to search around. `placeId` comes from the place lookup; `radiusMiles` null = the place itself. */
export const PlaceQuerySchema = named(obj({
  text: str(),
  placeId: nullable(str()),
  radiusMiles: nullable(num({ minimum: 0, maximum: 500 })),
}), 'PlaceQuery');

/**
 * Every filter is optional. An absent filter does not restrict. A job whose fact is unknown FAILS a filter on that
 * fact unless `includeUnknown` names it (so a job with unknown pay never passes a minimum pay filter by accident).
 * Exclude filters always win over include filters.
 */
export const JobFilterSchema = named(obj({}, {
  status: enm(['open', 'closed']),
  countries: arr(CountryCodeSchema),
  places: arr(PlaceQuerySchema),
  workModels: arr(WorkModelSchema),
  /** Remote jobs open to people in these regions (ISO codes or WORLDWIDE). */
  remoteRegions: arr(str()),
  employmentTypes: arr(EmploymentTypeSchema),
  levels: arr(ExperienceLevelSchema),
  /** Required experience at most this many years. */
  maxYearsRequired: int({ minimum: 0, maximum: 50 }),
  postedWithin: enm(['24h', '3d', '7d', '30d']),
  /** Minimum annual pay in USD (converted pay counts). */
  minAnnualPayUsd: num({ minimum: 0 }),
  /** Jobs with a positive sponsor tag: the company history says likely, or the post says it sponsors. */
  h1bSponsorship: bool(),
  excludeClearanceRequired: bool(),
  excludeUsCitizenOnly: bool(),
  jobFunctions: arr(str()),
  excludedTitles: arr(str()),
  industries: arr(str()),
  excludedIndustries: arr(str()),
  skills: arr(str()),
  excludedSkills: arr(str()),
  roleTypes: arr(enm(['ic', 'manager'])),
  /** Company keys. */
  companies: arr(str()),
  excludedCompanies: arr(str()),
  companyStages: arr(CompanyStageSchema),
  excludeStaffingAgencies: bool(),
  /** Source ids (see SourceAttribution.sourceId). */
  sources: arr(str()),
  includeUnknown: arr(enm(['place', 'workModel', 'employmentType', 'level', 'years', 'postedAt', 'pay', 'remoteRegion'])),
}), 'JobFilter');

export const JobSearchRequestSchema = named(obj(
  { sort: JobSortSchema },
  {
    /** Words to search for. Punctuation such as C++, C#, .NET and 401(k) is kept. Operators are treated as words. */
    q: str({ maxLength: 500 }),
    filter: JobFilterSchema,
    /** Opaque cursor from the previous page. Paging never repeats or skips a job. */
    cursor: str(),
    limit: int({ minimum: 1, maximum: 100 }),
  },
), 'JobSearchRequest');

export const FitStateSchema = named(obj({
  /** ready; indexing (some jobs wait); not_ready (model missing); needs_profile (Top Matched without a profile). */
  state: enm(['ready', 'indexing', 'not_ready', 'needs_profile']),
  waiting: int({ minimum: 0 }),
  model: nullable(str()),
}), 'FitState');

/** One list item: the job summary plus the user's own state on it. */
export const JobListItemSchema = named(obj({
  job: JobSummarySchema,
  match: nullable(MatchSummarySchema),
  liked: bool(),
  hidden: bool(),
  trackerStatus: nullable(TrackerStatusSchema),
  /** How many of the user's connections work there. null = no network data or no match (never 0 by default). */
  networkCount: nullable(int({ minimum: 1 })),
  /**
   * The sponsor tag to show. null = no tag (unknown). post_says_no only when the POSTING says so.
   * Never derived from a company missing from the sponsor data.
   */
  h1bTag: nullable(enm(['likely_by_history', 'post_says_yes', 'post_says_no'])),
  /** Vector fit in Top Matched order; null when not scored yet (the job is still shown, marked "not scored"). */
  fitScore: nullable(num()),
}, {
  // Added by the i-core lane (additive): the sponsor tag in plain words with its basis and data date, for example
  // "H-1B sponsor likely: 513 certified filings, Oct 2024 to Jun 2026 (US Dept. of Labor LCA data)". Absent = no tag.
  h1bNote: str(),
}), 'JobListItem');

export const JobSearchResponseSchema = named(obj({
  items: arr(JobListItemSchema),
  /** Distinct open, non-hidden, non-duplicate jobs that match. Paging to the end yields exactly this many. */
  total: int({ minimum: 0 }),
  nextCursor: nullable(str()),
  fit: FitStateSchema,
  tookMs: int({ minimum: 0 }),
}), 'JobSearchResponse');

export const SavedFilterSchema = named(obj({
  id: IdSchema,
  name: str({ minLength: 1, maxLength: 120 }),
  filter: JobFilterSchema,
  sort: JobSortSchema,
  alert: obj({ enabled: bool(), lastNotifiedAt: nullable(IsoDateTimeSchema) }),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}), 'SavedFilter');

export type JobSort = Infer<typeof JobSortSchema>;
export type PlaceQuery = Infer<typeof PlaceQuerySchema>;
export type JobFilter = Infer<typeof JobFilterSchema>;
export type JobSearchRequest = Infer<typeof JobSearchRequestSchema>;
export type FitState = Infer<typeof FitStateSchema>;
export type JobListItem = Infer<typeof JobListItemSchema>;
export type JobSearchResponse = Infer<typeof JobSearchResponseSchema>;
export type SavedFilter = Infer<typeof SavedFilterSchema>;
