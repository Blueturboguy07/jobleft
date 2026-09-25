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
