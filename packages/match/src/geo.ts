// Just enough geography to compare a posting's places with the places a person wants, without a place dictionary:
// US state names and codes, and a city and state comparison. Distances need the place dictionary of
// @jobleft/static-data; when the caller passes one (MatchInput.distanceMiles), radius preferences are checked too.

import type { Place, PlaceQuery } from '@jobleft/contracts';

export const US_STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
  PR: 'puerto rico', GU: 'guam', VI: 'virgin islands',
};
const STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [name, code]));

/** "TX", "Texas", "texas" -> "TX"; anything else -> the trimmed upper-case text. */
export function regionKey(region: string | null | undefined): string | null {
  if (!region) return null;
  const r = region.trim();
  if (!r) return null;
  const up = r.toUpperCase();
  if (US_STATES[up]) return up;
  const byName = STATE_BY_NAME.get(r.toLowerCase());
  return byName ?? up;
}

export function cityKey(city: string | null | undefined): string | null {
  if (!city) return null;
  const c = city.toLowerCase().replace(/\bsaint\b/g, 'st').replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();
  return c || null;
}

export interface ParsedPlace { city: string | null; region: string | null; country: string | null; text: string }

/** Reads "Austin, TX", "Austin, Texas", "Texas", "Chicago, IL, USA", "Remote - US". */
export function parsePlaceText(text: string): ParsedPlace {
  const t = text.trim();
  const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
  let country: string | null = null;
  if (parts.length && /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(parts[parts.length - 1])) { country = 'US'; parts.pop(); }
  if (parts.length === 1) {
    const r = regionKey(parts[0]);
    if (r && US_STATES[r]) return { city: null, region: r, country: 'US', text: t };
    return { city: parts[0], region: null, country, text: t };
  }
  if (parts.length >= 2) {
    const r = regionKey(parts[1]);
    if (r && US_STATES[r]) country = 'US';
    return { city: parts[0], region: r, country, text: t };
  }
  return { city: null, region: null, country, text: t };
}

export type PlaceVerdict = 'match' | 'same_region_unknown_distance' | 'different' | 'unknown';

/**
 * Compares a posting's place with one wanted place. Without a distance function, two different cities in the same
 * state are "same_region_unknown_distance" (never a broken deal-breaker); different states are "different".
 */
export function comparePlace(job: Place, want: PlaceQuery, distanceMiles?: (a: Place, b: PlaceQuery) => number | null): PlaceVerdict {
  const w = parsePlaceText(want.text);
  const jobCity = cityKey(job.city);
  const jobRegion = regionKey(job.region);
  if (distanceMiles) {
    const d = distanceMiles(job, want);
    if (d !== null) return d <= Math.max(want.radiusMiles ?? 0, 10) ? 'match' : 'different';
  }
  if (!w.city && w.region) {
    if (!jobRegion) return 'unknown';
    return jobRegion === w.region ? 'match' : 'different';
  }
  if (!jobCity && !jobRegion) return 'unknown';
  const wCity = cityKey(w.city);
  if (wCity && jobCity === wCity && (!w.region || !jobRegion || jobRegion === w.region)) return 'match';
  if (w.region && jobRegion) return jobRegion === w.region ? ((want.radiusMiles ?? 0) > 0 ? 'same_region_unknown_distance' : 'different') : 'different';
  return 'unknown';
}

export function placeLabel(p: Place): string {
  if (p.city && p.region) return `${p.city}, ${p.region}`;
  return p.text;
}
