// Every country a person can choose (ISO 3166-1 alpha-2), named in English by the platform (Intl.DisplayNames), so a
// person who lives in or wants to work in India, France or Japan can say so (JL-onboarding-27). Pure (unit tested).
// The list itself lives in the contracts, so the local service accepts exactly the countries the app offers.

import { ISO_COUNTRY_CODES } from '@jobleft/contracts';

const CODES = ISO_COUNTRY_CODES;

let names: Intl.DisplayNames | null = null;
/** "IN" -> "India"; an unknown code comes back as written. */
export function countryName(code: string): string {
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return names.of(code) ?? code;
  } catch { return code; }
}

/** The countries most jobleft users pick, shown first and as buttons. */
export const COMMON_COUNTRY_CODES = ['US', 'CA', 'GB', 'IE', 'DE', 'AU'];

/** Every country: the common ones first, then the rest by name. */
export const ALL_COUNTRIES: Array<{ value: string; label: string }> = [
  ...COMMON_COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) })),
  ...CODES.filter((c) => !COMMON_COUNTRY_CODES.includes(c)).map((c) => ({ value: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label, 'en')),
];

/** Search order of a country picker: names that start with the typed text come first ("India" before "British Indian Ocean Territory"). */
export function countrySort(a: { label?: unknown }, b: { label?: unknown }, info?: { searchValue?: string }): number {
  const q = (info?.searchValue ?? '').trim().toLowerCase();
  const rank = (o: { label?: unknown }) => (q && String(o.label ?? '').toLowerCase().startsWith(q) ? 0 : 1);
  return rank(a) - rank(b);
}
