// Company: facts with a source and a date for each one (static-data O10, O11), and the H-1B filing summary.

import { HttpUrlSchema, IsoDateSchema, IsoDateTimeSchema, SourceRefSchema } from './common.ts';
import { arr, bool, enm, int, named, nullable, num, obj, str, type Infer, type Schema } from './schema.ts';

/** One company fact: the value, where it came from and when jobleft read it. A fact nobody states is absent. */
export function fact<V>(value: Schema<V>) {
  return obj({ value, source: SourceRefSchema });
}

export const CompanyStageSchema = enm(['early', 'growth', 'late', 'public']);

/**
 * The company's H-1B filing history from the shipped US Department of Labor LCA data.
 * There is no "does not sponsor" value: a company missing from the data has `h1b: null` (unknown).
 */
export const H1bSummarySchema = named(obj({
  /** likely = many certified filings in about the last two years; some_history = few or older filings. */
  status: enm(['likely', 'some_history']),
  /** Certified H-1B LCA rows for the filer entities in the window. Withdrawn and denied rows never count. */
  certifiedFilings: int({ minimum: 0 }),
  window: obj({ from: IsoDateSchema, to: IsoDateSchema }),
  byYear: arr(obj({ year: int(), count: int({ minimum: 0 }), partial: bool(), yearKind: enm(['fiscal', 'calendar']) })),
  /** Share of filings in a role family like this job (0 to 1), when known. */
  similarRoleShare: nullable(num({ minimum: 0, maximum: 1 })),
  roleFamily: nullable(str()),
  /** The legal filer names behind the numbers. */
  filerEntities: arr(str(), { minItems: 1 }),
  /** Newest filing date in the shipped data. */
  dataThrough: IsoDateSchema,
  source: str({ description: 'e.g. "US Department of Labor, LCA disclosure data"' }),
  /** The hedge sentence to show: past filings do not guarantee sponsorship for this role. */
  note: str(),
}), 'H1bSummary', 'H-1B filing history of a company (never a "no")');

export const CompanySchema = named(obj({
  /** companyKey (see @jobleft/static-data). */
  key: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  aliases: arr(str()),
  facts: obj({}, {
    website: fact(HttpUrlSchema),
    description: fact(str()),
    founded: fact(int()),
    headquarters: fact(str()),
    /** A size bucket as the source states it, e.g. "1,001-5,000 employees". */
    size: fact(str()),
    industries: fact(arr(str())),
    stage: fact(CompanyStageSchema),
    totalFundingUsd: fact(num({ minimum: 0 })),
    investors: fact(arr(str())),
    leaders: fact(arr(obj({ name: str(), title: str() }))),
    news: fact(arr(obj({ title: str(), url: HttpUrlSchema, publishedAt: nullable(IsoDateSchema), outlet: nullable(str()) }))),
  }),
  h1b: nullable(H1bSummarySchema),
  /** true = a staffing or recruiting agency (filter "Exclude Staffing Agency"), null = unknown. */
  isStaffingAgency: nullable(bool()),
  /** When the kept facts expire and may be read again. */
  factsFreshUntil: nullable(IsoDateTimeSchema),
  updatedAt: IsoDateTimeSchema,
}), 'Company', 'A company with sourced, dated facts');

export type CompanyStage = Infer<typeof CompanyStageSchema>;
export type H1bSummary = Infer<typeof H1bSummarySchema>;
export type Company = Infer<typeof CompanySchema>;
