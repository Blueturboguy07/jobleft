// How a place from the place lookup is named in the city picker and saved in a preference. Several places share a
// name (Austin, Texas and Austin, Minnesota; London, England and London, Ontario), so every row and every saved place
// names its state or country (JL-onboarding-3). Pure (unit tested).

import type { Place } from '@jobleft/contracts';
import { countryName } from './countries.ts';

/** A region written as a short code ("TX", "ON", "NSW"), not a district name. */
const isCode = (r: string | null): r is string => !!r && /^[A-Z]{2,3}$/.test(r);

/** The text saved for a chosen place: "Austin, TX", "Toronto, ON, Canada", "London, United Kingdom". */
export function placeText(p: Place): string {
  const city = (p.city ?? p.text).trim();
  if (!p.country) return [city, p.region].filter(Boolean).join(', ');
  if (p.country === 'US') return [city, p.region].filter(Boolean).join(', ');
  return [city, isCode(p.region) ? p.region : null, countryName(p.country)].filter(Boolean).join(', ');
}

/** The row of the picker list: the place, its state or region, and its country ("Austin, MN, United States"). */
export function placeOptionLabel(p: Place): string {
  const city = (p.city ?? p.text).trim();
  return [city, p.region, p.country ? countryName(p.country) : null].filter(Boolean).join(', ');
}

/** Picker rows for a lookup answer, one per place id, each with a label no other row has. */
export function placeOptions(places: Place[]): Array<{ value: string; label: string; place: Place }> {
  const out: Array<{ value: string; label: string; place: Place }> = [];
  for (const p of places) {
    if (!p.placeId || out.some((o) => o.value === p.placeId)) continue;
    out.push({ value: p.placeId, label: placeOptionLabel(p), place: p });
  }
  // Same label twice (two places of one name in one state): add where each is, so the rows still differ.
  for (const o of out) {
    if (out.filter((x) => x.label === o.label).length > 1 && typeof o.place.lat === 'number' && typeof o.place.lon === 'number') {
      o.label = `${o.label} (${Math.abs(o.place.lat).toFixed(2)}°${o.place.lat >= 0 ? 'N' : 'S'}, ${Math.abs(o.place.lon).toFixed(2)}°${o.place.lon >= 0 ? 'E' : 'W'})`;
    }
  }
  return out;
}
