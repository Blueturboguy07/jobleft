// Shared primitives. Rule for every contract: `null` means "unknown" or "not stated". It is never
// replaced by a default value (no "$0", no "Onsite", no "United States", no "50%").

import { enm, int, named, nullable, obj, str, type Infer } from './schema.ts';

/** RFC 3339 date-time in UTC, e.g. "2026-09-25T05:00:00.000Z". */
export const IsoDateTimeSchema = str({ format: 'date-time', description: 'RFC 3339 date-time, UTC ("Z")' });
/** Calendar date, e.g. "2026-09-25". */
export const IsoDateSchema = str({ format: 'date', description: 'Calendar date YYYY-MM-DD' });
/** Year and month, e.g. "2023-06" (resume and profile dates). */
export const YearMonthSchema = str({ pattern: '^\\d{4}(-(0[1-9]|1[0-2]))?$', description: 'YYYY or YYYY-MM' });
/** An absolute http or https URL. Any other scheme (javascript:, file:, custom) is refused. */
export const HttpUrlSchema = str({ format: 'uri', pattern: '^https?://', maxLength: 4096, description: 'Absolute http(s) URL' });
/** A local identifier. */
export const IdSchema = str({ minLength: 1, maxLength: 300 });
/** Money in integer millionths of a US dollar (publik "micros"). $1.00 = 1,000,000. */
export const MicrosSchema = int({ description: 'Integer millionths of a US dollar' });
/** ISO 3166-1 alpha-2 country code, upper case. */
export const CountryCodeSchema = str({ pattern: '^[A-Z]{2}$', description: 'ISO 3166-1 alpha-2' });
/**
 * Every assigned ISO 3166-1 alpha-2 code: the countries a person can choose in the app, and the only codes a profile
 * save accepts (JL-onboarding-22: "XX" is two capital letters but no country).
 */
export const ISO_COUNTRY_CODES: readonly string[] = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG '
  + 'CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP '
  + 'GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS '
  + 'LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH '
  + 'PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM '
  + 'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');
const ISO_COUNTRY_SET = new Set(ISO_COUNTRY_CODES);
/** true for an assigned ISO 3166-1 alpha-2 code ("IN", "US"); false for "XX", "us" or "USA". */
export function isCountryCode(code: string): boolean {
  return ISO_COUNTRY_SET.has(code);
}
/** ISO 4217 currency code, upper case. */
export const CurrencySchema = str({ pattern: '^[A-Z]{3}$', description: 'ISO 4217 currency code' });

/** Where a shown fact came from, so the user can check it (parsers O14, static-data O3). */
export const FactEvidenceSchema = named(obj(
  {
    source: enm(['board_field', 'title', 'description', 'location_text', 'directory', 'dataset', 'web', 'user']),
    /** The supporting text, quoted from the source (at most 500 characters). */
    text: str({ maxLength: 500 }),
  },
  { url: HttpUrlSchema },
), 'FactEvidence', 'The source and the supporting text of one fact');

/** A named source with a link and the time jobleft read it (company facts, datasets). */
export const SourceRefSchema = named(obj(
  { name: str({ minLength: 1 }), url: nullable(HttpUrlSchema), retrievedAt: IsoDateTimeSchema },
  { licence: str() },
), 'SourceRef', 'A named source, its link and when jobleft read it');

/** A credit line a source's terms require next to its jobs (sources-other O2). */
export const CreditSchema = named(obj({ text: str({ minLength: 1 }), url: HttpUrlSchema }), 'Credit');

export type IsoDateTime = Infer<typeof IsoDateTimeSchema>;
export type IsoDate = Infer<typeof IsoDateSchema>;
export type HttpUrl = Infer<typeof HttpUrlSchema>;
export type Id = Infer<typeof IdSchema>;
export type Micros = Infer<typeof MicrosSchema>;
export type FactEvidence = Infer<typeof FactEvidenceSchema>;
export type SourceRef = Infer<typeof SourceRefSchema>;
export type Credit = Infer<typeof CreditSchema>;
