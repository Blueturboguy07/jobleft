// US places in job location texts: the state codes a text names ("Austin, TX", "Dallas, Texas", "Houston"). Shared by
// the personal ranking (core/feed.ts) and the place filter (interim/jobs.ts).

export const STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
  LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico',
  NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([c, n]) => [n, c]));
const STATE_NAME_RE = new RegExp(`\\b(${[...STATE_BY_NAME.keys()].sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');
// Big cities whose postings often omit the state.
const CITY_STATE: Record<string, string> = {
  houston: 'TX', dallas: 'TX', austin: 'TX', 'san antonio': 'TX', 'fort worth': 'TX', 'el paso': 'TX', plano: 'TX', irving: 'TX',
  'new york city': 'NY', nyc: 'NY', manhattan: 'NY', brooklyn: 'NY', 'san francisco': 'CA', 'los angeles': 'CA', 'san diego': 'CA',
  'san jose': 'CA', seattle: 'WA', chicago: 'IL', boston: 'MA', atlanta: 'GA', denver: 'CO', miami: 'FL', phoenix: 'AZ',
  philadelphia: 'PA', detroit: 'MI', minneapolis: 'MN', nashville: 'TN', portland: 'OR', 'salt lake city': 'UT',
};
const CITY_RE = new RegExp(`\\b(${Object.keys(CITY_STATE).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');

export function memo<T>(fn: (s: string) => T, max = 100_000): (s: string) => T {
  const cache = new Map<string, T>();
  return (s: string) => {
    let v = cache.get(s);
    if (v === undefined) { v = fn(s); if (cache.size >= max) cache.clear(); cache.set(s, v); }
    return v;
  };
}

/** US state codes a place text names ("Austin, TX", "Dallas, Texas", "Houston"). */
export const statesIn = memo(statesInRaw);
function statesInRaw(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[,(/;|\s-])([A-Z]{2})(?=$|[\s,)/;|.-])/g)) if (STATES[m[1]!]) out.add(m[1]!);
  for (const m of text.matchAll(STATE_NAME_RE)) out.add(STATE_BY_NAME.get(m[1]!.toLowerCase())!);
  for (const m of text.matchAll(CITY_RE)) out.add(CITY_STATE[m[1]!.toLowerCase()]!);
  // "Washington, DC" is DC, not the state.
  if (/washington,?\s*d\.?c\.?/i.test(text)) { out.add('DC'); if (!/washington state|, wa\b/i.test(text)) out.delete('WA'); }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Words in a place text that name no region: "Remote", "Hybrid", "Office", "Greater ... Area", the country itself. */
const PLAIN_PLACE_WORDS = /\b(?:remote|hybrid|on-?site|in[- ]office|office|offices|hq|headquarters|metro|metropolitan|area|greater|city|downtown|region|united\s+states(?:\s+of\s+america)?|usa|us|u\.s\.a?\.?)\b/gi;

/**
 * JL-feed-5: a place chosen from the place list reads "City, Region" or "City, Region, Country" ("Austin, TX",
 * "Portland, Victoria, Australia"). A job matches when one of its places names that city and either names that
 * region (code or name) or names no other region at all ("Austin" alone). "Austin, MN" is not "Austin, TX". A place
 * with no region ("Austin") matches every place that names the city, as before.
 */
export function placeMatches(location: string, query: string): boolean {
  const [city = '', region = '', country = ''] = query.split(',').map((x) => x.trim());
  if (!city) return false;
  const cityRe = new RegExp(`(^|[^\\p{L}])${esc(city.toLowerCase())}($|[^\\p{L}])`, 'u');
  for (const seg of location.split(/[;|]/)) {
    const low = seg.toLowerCase();
    if (!cityRe.test(low)) continue;
    if (!region) return true;
    const state = STATES[region.toUpperCase()];
    if (state && (new RegExp(`\\b${region.toUpperCase()}\\b`).test(seg) || low.includes(state))) return true;
    if (!state && (low.includes(region.toLowerCase()) || (country && low.includes(country.toLowerCase())))) return true;
    const rest = low.replace(cityRe, ' ').replace(PLAIN_PLACE_WORDS, ' ').replace(/[^\p{L}]+/gu, '');
    if (!rest) return true;
  }
  return false;
}
