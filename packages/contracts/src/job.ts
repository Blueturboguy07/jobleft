// Job: one posting as the store keeps it and the local API returns it.
// Crawled rows (the crawler's `jobs` table) are mapped to this shape by @jobleft/store.

import {
  CountryCodeSchema, CreditSchema, CurrencySchema, FactEvidenceSchema, HttpUrlSchema, IdSchema, IsoDateTimeSchema,
} from './common.ts';
import { arr, bool, enm, int, named, nullable, num, obj, str, type Infer } from './schema.ts';

/** ATS families jobleft may crawl (an adapter exists or is planned in Phase 1). */
export const CRAWL_ATS_IDS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio'] as const;
/**
 * ATS families jobleft can RECOGNISE from a URL (external jobs, autofill). Recognising never means crawling:
 * workday, icims, oracle, ukg, taleo and smartrecruiters get no request (see docs/INTERFACES.md, "Never-crawl hosts").
 */
export const ATS_IDS = [
  ...CRAWL_ATS_IDS, 'workday', 'icims', 'smartrecruiters', 'oracle', 'ukg', 'taleo', 'jobvite', 'bamboohr', 'teamtailor', 'breezy', 'other',
] as const;
export const CrawlAtsIdSchema = enm(CRAWL_ATS_IDS);
export const AtsIdSchema = enm(ATS_IDS);

/** Fine-grained seniority (the parsers' output). */
export const LEVELS = ['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'exec'] as const;
export const LevelSchema = enm(LEVELS);

/** The six experience-level buckets of the filter and the job card. */
export const EXPERIENCE_LEVELS = ['intern_new_grad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec'] as const;
export const ExperienceLevelSchema = enm(EXPERIENCE_LEVELS);
export const EXPERIENCE_LEVEL_LABELS: Readonly<Record<(typeof EXPERIENCE_LEVELS)[number], string>> = {
  intern_new_grad: 'Intern/New Grad', entry: 'Entry Level', mid: 'Mid Level', senior: 'Senior Level',
  lead_staff: 'Lead/Staff', director_exec: 'Director/Executive',
};

export const WorkModelSchema = enm(['onsite', 'hybrid', 'remote']);
export const EmploymentTypeSchema = enm(['full_time', 'part_time', 'contract', 'internship', 'temporary', 'other']);
export const PayPeriodSchema = enm(['hour', 'day', 'week', 'month', 'year']);
export const JobStatusSchema = enm(['open', 'closed']);

/** Pay exactly as the posting or its board states it. Never an estimate (parsers O3). */
export const PaySchema = named(obj({
  /** null = the posting gives no minimum ("up to $150,000"). */
  min: nullable(num({ minimum: 0 })),
  /** null = the posting gives no maximum ("from $20/hour"). */
  max: nullable(num({ minimum: 0 })),
  currency: CurrencySchema,
  period: PayPeriodSchema,
  /** board_field = the ATS pay field; description = parsed from the posting text. */
  source: enm(['board_field', 'description']),
  /** How many different ranges the posting states (several = tiers by city or level). 1 normally. */
  ranges: int({ minimum: 1 }),
  /** Converted to a year (2,080 hours, 260 days, 52 weeks, 12 months). Show "converted" next to it when period != year. */
  annualMin: nullable(num({ minimum: 0 })),
  annualMax: nullable(num({ minimum: 0 })),
}), 'Pay', 'Pay as the posting states it');

/** One place a posting lists. `text` is always the posting's own words. */
export const PlaceSchema = named(obj({
  text: str(),
  city: nullable(str()),
  /** State, province or region code or name ("TX", "Ontario"). */
  region: nullable(str()),
  country: nullable(CountryCodeSchema),
  /** Id in the shipped place dictionary (@jobleft/static-data), null when not resolved. */
  placeId: nullable(str()),
}, { lat: num({ minimum: -90, maximum: 90 }), lon: num({ minimum: -180, maximum: 180 }) }), 'Place');

/** Where a remote job accepts people from, as the posting states it. */
export const RemoteScopeSchema = named(obj({
  /** ISO alpha-2 codes, or WORLDWIDE, EU, EMEA, APAC, LATAM, NA. */
  regions: arr(str()),
  text: str({ description: "The posting's own words, e.g. 'Remote (US only)'" }),
}), 'RemoteScope');

/** One source that listed this job, with its link back and any credit its terms require. */
export const SourceAttributionSchema = named(obj({
  /** e.g. "ats:greenhouse", "remotive", "usajobs", "external:url", "external:text". */
  sourceId: str({ minLength: 1 }),
  /** Display name, e.g. "Acme careers (Greenhouse)". */
  name: str({ minLength: 1 }),
  /** The posting on that source. */
  url: HttpUrlSchema,
  credit: nullable(CreditSchema),
  firstSeenAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
}), 'SourceAttribution');

/** Sponsorship or limits that the POSTING states. The company's filing history is in Company.h1b. */
export const PostingStatementsSchema = named(obj({
  /** yes = the post says it sponsors; no = the post says it does not; null = the post says nothing. */
  sponsorship: nullable(enm(['yes', 'no'])),
  clearanceRequired: nullable(bool()),
  usCitizenOnly: nullable(bool()),
}), 'PostingStatements');

/** Evidence for the facts that are not plain board fields. Keys are present only when the fact is known. */
export const JobEvidenceSchema = named(obj({}, {
  pay: FactEvidenceSchema,
  level: FactEvidenceSchema,
  years: FactEvidenceSchema,
  places: FactEvidenceSchema,
  workModel: FactEvidenceSchema,
  remoteScope: FactEvidenceSchema,
  employmentType: FactEvidenceSchema,
  sponsorship: FactEvidenceSchema,
  clearanceRequired: FactEvidenceSchema,
  usCitizenOnly: FactEvidenceSchema,
}), 'JobEvidence');

const JOB_FIELDS = {
  /** Stable local id: "<ats>:<board>:<externalId>" for crawled jobs, "ext:<sha256 prefix>" for added jobs. */
  id: IdSchema,
  status: JobStatusSchema,
  closedAt: nullable(IsoDateTimeSchema),
  /** unseen = gone from a board that was proven read; board_empty = the empty-feed net; source_removed = a feed dropped it. */
  closedReason: nullable(enm(['unseen', 'board_empty', 'source_removed', 'user'])),
  title: str({ minLength: 1 }),
  company: str({ minLength: 1 }),
  /** Company match key (@jobleft/static-data companyKey): legal suffixes, case, accents and punctuation removed. */
  companyKey: str(),
  /** The ATS that hosts the posting, when known. */
  ats: nullable(AtsIdSchema),
  board: nullable(str()),
  externalId: nullable(str()),
  /** The posting page on the employer's site or ATS (the link back). */
  url: HttpUrlSchema,
  /** The apply page when it differs; null when the source gave none or it is not http(s). */
  applyUrl: nullable(HttpUrlSchema),
  canonicalUrl: HttpUrlSchema,
  /** Every place the posting lists. [] = not stated. */
  places: arr(PlaceSchema),
  /** true = US, false = clearly elsewhere, null = cannot tell. */
  isUs: nullable(bool()),
  workModel: nullable(WorkModelSchema),
  remoteScope: nullable(RemoteScopeSchema),
  employmentType: nullable(EmploymentTypeSchema),
  level: nullable(LevelSchema),
  /** Experience-level buckets for the filter and the card. [] = unknown. */
  levels: arr(ExperienceLevelSchema, { uniqueItems: true }),
  yearsRequired: nullable(obj({ min: nullable(int({ minimum: 0 })), max: nullable(int({ minimum: 0 })) })),
  pay: nullable(PaySchema),
  /** When the employer posted it, from the source. null = not stated (never the crawl time). */
  postedAt: nullable(IsoDateTimeSchema),
  /** When jobleft first and last saw it on any source. */
  firstSeenAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  department: nullable(str()),
  statements: PostingStatementsSchema,
  /** Skills named in the posting, normalised (may be filled later by @jobleft/match). */
  skills: arr(str()),
  evidence: JobEvidenceSchema,
  /** Every source that listed this job. At least one. */
  sources: arr(SourceAttributionSchema, { minItems: 1 }),
  /** Set when this row repeats an older open row of the same role (same company and title). Hidden from search. */
  duplicateOf: nullable(IdSchema),
  /** Hash of what a reader sees; equal hash on a re-crawl means nothing changed. */
  contentHash: str(),
};

/** A job with its full plain-text description (the detail view). */
export const JobSchema = named(obj(
  { ...JOB_FIELDS, description: str({ description: 'Plain text. Never HTML. Rendered as text, never as markup.' }) },
  { /** True for per-query results that a source's terms forbid storing (sources-other O13). */ ephemeral: bool() },
), 'Job', 'One job posting');

/** A job without its description, plus a short snippet (list items). */
export const JobSummarySchema = named(obj(
  { ...JOB_FIELDS, snippet: str({ maxLength: 400 }) },
  { ephemeral: bool() },
), 'JobSummary', 'A job without its full description');

export type CrawlAtsId = Infer<typeof CrawlAtsIdSchema>;
export type AtsId = Infer<typeof AtsIdSchema>;
export type Level = Infer<typeof LevelSchema>;
export type ExperienceLevel = Infer<typeof ExperienceLevelSchema>;
export type WorkModel = Infer<typeof WorkModelSchema>;
export type EmploymentType = Infer<typeof EmploymentTypeSchema>;
export type PayPeriod = Infer<typeof PayPeriodSchema>;
export type JobStatus = Infer<typeof JobStatusSchema>;
export type Pay = Infer<typeof PaySchema>;
export type Place = Infer<typeof PlaceSchema>;
export type RemoteScope = Infer<typeof RemoteScopeSchema>;
export type SourceAttribution = Infer<typeof SourceAttributionSchema>;
export type PostingStatements = Infer<typeof PostingStatementsSchema>;
export type JobEvidence = Infer<typeof JobEvidenceSchema>;
export type Job = Infer<typeof JobSchema>;
export type JobSummary = Infer<typeof JobSummarySchema>;

/** Maps a fine-grained level to its filter bucket. */
export function experienceLevelOf(level: Level): ExperienceLevel {
  switch (level) {
    case 'intern': return 'intern_new_grad';
    case 'entry': return 'entry';
    case 'mid': return 'mid';
    case 'senior': return 'senior';
    case 'staff': case 'principal': case 'lead': case 'manager': return 'lead_staff';
    case 'director': case 'vp': case 'exec': return 'director_exec';
  }
}
