// Places: every place a posting names, with its city, state or region and country. Never a default country
// (parsers O7, O8). "Remote", "Multiple locations" and "Various" are not places.
import type { Place, WorkModel } from '@jobleft/contracts';
import { AU_STATE_CODES, CA_PROVINCE_CODES, COUNTRIES, COUNTRY_TYPOS, FOREIGN_REGIONS, GLOBAL_DOMINANT, MACRO_REGIONS, WORLD_CITY_COUNTRIES, WORLD_CITY_NAMES } from './geo-world.ts';
import { US_CITY_DOMINANT, US_CITY_STATES, US_PLACE_ALIASES, US_REGION_NAMES, US_STATES, US_STATE_ALIASES } from './geo-us.ts';
import { clip, cutOtherJobs, keyOf, normalizeText } from './text.ts';

// ---------------------------------------------------------------------------------------------------------------
// Lookup tables

const COUNTRY_BY_KEY = new Map<string, string>();
for (const [cc, names] of Object.entries(COUNTRIES)) for (const n of names) COUNTRY_BY_KEY.set(keyOf(n), cc);
for (const [typo, cc] of Object.entries(COUNTRY_TYPOS)) COUNTRY_BY_KEY.set(typo, cc);
// Plain "Georgia" is the US state; the country is written "Georgia (country)" or named by its cities.
COUNTRY_BY_KEY.delete('georgia');
const ISO3: Record<string, string> = {
  USA: 'US', GBR: 'GB', CAN: 'CA', DEU: 'DE', FRA: 'FR', ESP: 'ES', ITA: 'IT', NLD: 'NL', IND: 'IN', IRL: 'IE', BRA: 'BR',
  MEX: 'MX', JPN: 'JP', SGP: 'SG', ISR: 'IL', POL: 'PL', PRT: 'PT', SWE: 'SE', NOR: 'NO', DNK: 'DK', FIN: 'FI', CHE: 'CH',
  AUT: 'AT', BEL: 'BE', NZL: 'NZ', ZAF: 'ZA', ARE: 'AE', CHN: 'CN', KOR: 'KR', PHL: 'PH', ARG: 'AR', COL: 'CO', CHL: 'CL',
  ROU: 'RO', UKR: 'UA', TUR: 'TR', NGA: 'NG', KEN: 'KE', EGY: 'EG', AUS: 'AU', HKG: 'HK', TWN: 'TW', MYS: 'MY', IDN: 'ID',
  THA: 'TH', VNM: 'VN', CZE: 'CZ', HUN: 'HU', GRC: 'GR', SAU: 'SA', QAT: 'QA', PAK: 'PK', GEO: 'GE', PER: 'PE', CRI: 'CR',
};
const STATE_BY_NAME = new Map<string, string>();
for (const [code, name] of Object.entries(US_STATES)) STATE_BY_NAME.set(keyOf(name), code);
for (const [alias, code] of Object.entries(US_STATE_ALIASES)) STATE_BY_NAME.set(alias, code);
const FOREIGN_REGION_BY_KEY = new Map<string, [string, string]>();
for (const [k, v] of Object.entries(FOREIGN_REGIONS)) FOREIGN_REGION_BY_KEY.set(keyOf(k), v);
for (const [code, name] of Object.entries(CA_PROVINCE_CODES)) FOREIGN_REGION_BY_KEY.set(keyOf(name), ['CA', code]);

/** Country names in display form. */
export function countryName(cc: string): string {
  return COUNTRIES[cc]?.[0]?.replace(' (country)', '') ?? cc;
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

type Tok =
  | { kind: 'country'; cc: string }
  | { kind: 'state'; code: string; ambiguousCountry: string | null }
  | { kind: 'fregion'; cc: string; name: string; alsoState?: string }
  | { kind: 'macro'; region: string }
  | { kind: 'usregion'; region: string; state: string | null }
  | { kind: 'city'; name: string; key: string; us: string[]; world: string[]; state?: string; country?: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'noise' }
  | { kind: 'zip'; state: string | null };

const PLACEHOLDER = /^(?:n\/?a|na|none|tbd|tba|tbc|unknown|various|varies|multiple|multiple locations?|multiple cities|various cities|several cities|multiple sites|multiple offices|all offices|any office|select locations|various locations in the us|several locations|many locations|all locations|any location|locations?|flexible|flexible location|see (?:job )?description|see below|other|others|nowhere|xx|x|-|—|\.|\?|global locations|various locations|\d+ locations?|to be determined|home|field|field based|field-based|travel|traveling|travelling|on the road|any|any\s.*|anywhere in|any \w+ office|all \w+ locations|remote_\w+)$/i;
const ORG_WORDS = /\b(?:schools?|academy|college|university|univ|campus|hospital|clinic|medical center|health center|center for|centre for|store|warehouse|plant|facility|headquarters|hq|office|offices|building|bldg|tower|plaza|mall|pvt|ltd|llc|inc|corp|gmbh|s\.a\.|b\.v\.|limited|company|group|partners|branch|site|depot|distribution center|fulfillment center|dc|lab|labs|studio|studios|factory|terminal|yard|shop|restaurant|cafe|café|hotel|resort|casino|club|church|library|station|base|hub|kitchen|bakery|venue|arena|stadium|park & ride)\b/i;
const STREET = /\b(?:st|street|ave|avenue|road|rd|blvd|boulevard|drive|dr|lane|ln|way|suite|ste|floor|fl|flr|building|bldg|room|rm|unit|parkway|pkwy|highway|hwy|court|ct|place|pl|square|sq|terrace|circle|cir|trail|pike|route|rte|av|avenida|rua|calle|carrera|strasse|straße|stationsplein|boulevard|via|viale|rue|andar|piso|po box|p\.o\. box)\b/i;
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const WORK_WORDS = /\b(?:remote|remotely|hybrid|on-?site|on site|in-?office|in office|in-?person|in person|office-?based|work from home|wfh|home[- ]?based|homeworking|home working|telecommute|telework|virtual|distributed|anywhere|nationwide|national|field|flexible|onsite)\b/i;

function titleCase(s: string): string {
  if (s !== s.toUpperCase() || s.length <= 3) return s;
  return s.toLowerCase().replace(/(^|[\s\-'/.])([a-zà-ÿ])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/** Classifies one comma-free piece of location text. */
function classify(raw: string): Tok {
  let t = raw.trim().replace(/^[\s,.;:\-–—]+|[\s,;:\-–—]+$/g, '').replace(/\.$/, '');
  if (!t) return { kind: 'noise' };
  if (PLACEHOLDER.test(t)) return { kind: 'noise' };
  // ZIP ("10001"), state + ZIP ("NY 10001"), UK postcode.
  if (/^\d{5}(?:-\d{4})?$/.test(t)) return { kind: 'zip', state: null };
  const sz = /^([A-Z]{2})\s+\d{5}(?:-\d{4})?$/.exec(t);
  if (sz && US_STATES[sz[1]]) return { kind: 'state', code: sz[1], ambiguousCountry: null };
  if (UK_POSTCODE.test(t)) return { kind: 'country', cc: 'GB' };
  // Postal codes glued to a place: "Shanghai 200002", "3511 ED Utrecht", "75009 Paris".
  t = t.replace(/\s+\d{4,6}(?:-\d{3,4})?$/, '').replace(/^\d{4}\s?[A-Z]{2}\s+/, '').replace(/^\d{5}\s+(?=[A-Za-zÀ-ÿ])/, '');
  if (/\d/.test(t) && (STREET.test(t) || /^\d/.test(t) || /\d{3,}/.test(t) || /\b\d+(?:st|nd|rd|th)\b/i.test(t))) return { kind: 'noise' };
  if (/^(?:suite|ste|floor|unit|room|building|no\.?|#)\b/i.test(t)) return { kind: 'noise' };
  if (/^(?:avenida|av\.|boulevard|bd|rua|calle|carrera|via|viale|rue|avenue|street|road|stra(?:ss|ß)e|the\s+roof|level|piso|andar)\b/i.test(t)) return { kind: 'noise' };
  if (/\b(?:street|road|avenue|boulevard|blvd|drive|lane|parkway|highway|strasse|straße|square)$/i.test(t)) return { kind: 'noise' };
  const k = keyOf(t);
  if (!k) return { kind: 'noise' };
  // Codes.
  if (/^[A-Z]{2}$/.test(t)) {
    if (t === 'UK' || t === 'GB') return { kind: 'country', cc: 'GB' };
    if (t === 'US') return { kind: 'country', cc: 'US' };
    if (t === 'EU') return { kind: 'macro', region: 'EU' };
    if (US_STATES[t]) {
      // Codes that are also a country (CA Canada, DE Germany, IN India, ...) are settled by the city before them.
      const cc = COUNTRIES[t] ? t : null;
      return { kind: 'state', code: t, ambiguousCountry: cc };
    }
    if (CA_PROVINCE_CODES[t]) return { kind: 'fregion', cc: 'CA', name: t === 'PQ' ? 'QC' : t };
    if (COUNTRIES[t]) return { kind: 'country', cc: t };
  }
  if (/^[A-Z]{3}$/.test(t)) {
    if (ISO3[t]) return { kind: 'country', cc: ISO3[t] };
    if (AU_STATE_CODES[t]) return { kind: 'fregion', cc: 'AU', name: t };
    if (t === 'JAL') return { kind: 'fregion', cc: 'MX', name: 'Jalisco' };
  }
  if (/^[A-Z]{4}$/.test(t) && t === 'CDMX') return { kind: 'city', name: 'Mexico City', key: 'mexico city', us: [], world: ['MX'], country: 'MX' };
  // Names.
  const macro = MACRO_REGIONS[k];
  const alias = US_PLACE_ALIASES[k];
  if (alias) return { kind: 'city', name: alias.city, key: keyOf(alias.city), us: [alias.state], world: [], state: alias.state, country: 'US' };
  const usRegion = US_REGION_NAMES[k];
  if (usRegion) return { kind: 'usregion', region: usRegion.region, state: usRegion.state };
  const cc = COUNTRY_BY_KEY.get(k);
  const stateByName = STATE_BY_NAME.get(k);
  const usCity = US_CITY_STATES.get(k) ?? [];
  const wCity = WORLD_CITY_COUNTRIES.get(k) ?? [];
  // "New York" is a city first (the state is written "New York, NY" or "New York State").
  if (stateByName && k !== 'new york' && k !== 'washington') {
    const fr = FOREIGN_REGION_BY_KEY.get(k);
    return fr ? { kind: 'fregion', cc: fr[0], name: fr[1], alsoState: stateByName } : { kind: 'state', code: stateByName, ambiguousCountry: null };
  }
  if (k === 'new york state' || k === 'nys') return { kind: 'state', code: 'NY', ambiguousCountry: null };
  if (k === 'washington state') return { kind: 'state', code: 'WA', ambiguousCountry: null };
  if (cc && usCity.length === 0 && wCity.length === 0) return { kind: 'country', cc };
  if (cc && (cc === 'SG' || cc === 'HK' || cc === 'MO' || cc === 'LU')) return { kind: 'city', name: countryName(cc), key: k, us: [], world: [cc], country: cc };
  if (cc) return { kind: 'country', cc };
  if (macro && usCity.length === 0 && wCity.length === 0) return { kind: 'macro', region: macro };
  const fr = FOREIGN_REGION_BY_KEY.get(k);
  if (fr && usCity.length === 0 && wCity.length === 0) return { kind: 'fregion', cc: fr[0], name: fr[1] };
  // A province far better known than the US town of the same name ("Ontario" is Canada's province).
  if (fr && k === 'ontario') return { kind: 'fregion', cc: fr[0], name: fr[1] };
  if (usCity.length || wCity.length) {
    const name = wCity.length && !usCity.length ? (WORLD_CITY_NAMES.get(k) ?? titleCase(t)) : titleCase(t);
    return { kind: 'city', name, key: k, us: usCity, world: wCity };
  }
  if (k === 'washington') return { kind: 'city', name: 'Washington', key: k, us: ['DC'], world: [] };
  if (macro) return { kind: 'macro', region: macro };
  // "Edmonds Branch", "Bellevue Office", "Taipei City", "Harlem NYC", "NYC-Privy": the place inside the words.
  const stripped = innerBySuffix(t);
  if (stripped) return stripped;
  if (ORG_WORDS.test(t) || WORK_WORDS.test(t)) return { kind: 'noise' };
  const inner = innerPlace(t);
  if (inner) return inner;
  // Unknown words: a place name only if it looks like one.
  if (t.length > 40 || t.split(/\s+/).length > 5 || !/^[\p{L}][\p{L}\p{M}' .\-()]*$/u.test(t)) return { kind: 'noise' };
  if (/^[a-z]/.test(t) && !/^(?:de|la|le|el|san|santa|são|sao)\b/.test(t)) return { kind: 'noise' };
  return { kind: 'unknown', name: titleCase(t) };
}

const SUFFIX_WORDS = /\s+(?:branch|office|offices|campus|store|clinic|location|site|hq|headquarters|center|centre|hub|facility|plant|warehouse|studio|lab|hospital)$/i;

const GENERIC_WORDS = new Set(['center', 'centre', 'union', 'normal', 'mobile', 'independence', 'commerce', 'liberty', 'enterprise',
  'paradise', 'hope', 'unity', 'friendship', 'industry', 'college', 'university', 'beach', 'lake', 'park', 'springs', 'hills',
  'valley', 'heights', 'village', 'city', 'town', 'county', 'station', 'junction', 'harbor', 'harbour', 'port', 'bay', 'point',
  'grove', 'ridge', 'falls', 'rapids', 'mills', 'lakes', 'woods', 'plains', 'river', 'forest', 'garden', 'gardens', 'north',
  'south', 'east', 'west', 'central', 'midland', 'highland', 'clinton', 'franklin', 'washington', 'jackson', 'lincoln', 'madison',
  'jefferson', 'monroe', 'marion', 'salem', 'fairfield', 'greenville', 'springfield', 'georgetown', 'richmond', 'arlington',
  'manchester', 'burlington', 'dover', 'milton', 'newport', 'auburn', 'bristol', 'chester', 'oxford', 'cambridge', 'victoria',
  'hudson', 'orange', 'troy', 'athens', 'florence', 'lebanon', 'mexico', 'peru', 'jordan', 'delta', 'surprise', 'humble', 'katy',
  'spring', 'allen', 'frisco', 'plano', 'tyler', 'bryan', 'temple', 'mission', 'sherman', 'marshall', 'decatur', 'aurora',
  'columbia', 'concord', 'lafayette', 'bloomington', 'rochester', 'kingston', 'hamilton', 'warren', 'kent', 'essex', 'reading',
  'bedford', 'wilmington', 'charleston', 'portland', 'albany', 'jamestown', 'greenwood', 'woodland', 'lakewood', 'riverside',
  'fremont', 'glendale', 'pasadena', 'ontario', 'santa', 'san', 'saint', 'st', 'mount', 'fort', 'new', 'old', 'great', 'little',
  'grand', 'long', 'rock', 'green', 'white', 'black', 'red', 'blue', 'royal', 'golden', 'silver', 'crystal', 'diamond', 'sun',
  'moon', 'star', 'eagle', 'bear', 'wolf', 'fox', 'deer', 'elk', 'buffalo', 'mobile', 'energy', 'data', 'digital', 'global']);

const REGION_SUFFIX = /\s+(?:region|area|metro|metro area|metropolitan area|county)$/i;
const AREA_PREFIX = /^(?:greater|metro|metropolitan|downtown|uptown|midtown|central|north|south|east|west|northern|southern|eastern|western)\s+/i;

function innerBySuffix(t: string): Tok | null {
  // "Western North Carolina Region", "Greater St. Louis", "East Coast US", "Denver Metro Area".
  for (const cand of [t.replace(REGION_SUFFIX, ''), t.replace(/\s+(?:US|USA|U\.S\.)$/, '').replace(/^(?:US|USA|U\.S\.)\s+/, '')]) {
    if (cand !== t && cand.trim()) {
      const c = classify(cand.trim());
      if (c.kind === 'city' || c.kind === 'state' || c.kind === 'usregion' || c.kind === 'fregion') return c;
    }
  }
  if (AREA_PREFIX.test(t)) {
    const c = classify(t.replace(AREA_PREFIX, ''));
    if (c.kind === 'city' || c.kind === 'usregion' || c.kind === 'state') return c;
  }
  const stripped = t.replace(SUFFIX_WORDS, '').trim();
  if (stripped && stripped !== t) {
    const c = classify(stripped);
    if (c.kind === 'city' || c.kind === 'state' || c.kind === 'country' || c.kind === 'fregion') return c;
  }
  if (/\s+city$/i.test(t)) {
    const c = classify(t.replace(/\s+city$/i, ''));
    if (c.kind === 'city' && !c.us.length) return c;
  }
  return null;
}

function innerPlace(t: string): Tok | null {
  const words = t.split(/[\s\-_/]+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return null;
  // The last or first one to three words, when they are a known city with one reading or a US alias.
  for (const n of [3, 2, 1]) {
    for (const part of [words.slice(-n).join(' '), words.slice(0, n).join(' ')]) {
      if (part === t || part.length < 2) continue;
      const k = keyOf(part);
      const alias = US_PLACE_ALIASES[k];
      if (alias && /^[A-Z]{2,3}$/.test(part)) return { kind: 'city', name: alias.city, key: keyOf(alias.city), us: [alias.state], world: [], state: alias.state, country: 'US' };
      if (part.length < 4) continue;
      if (n === 1 && (GENERIC_WORDS.has(k) || part.length < 5)) continue;
      const us = US_CITY_STATES.get(k) ?? [];
      const w = WORLD_CITY_COUNTRIES.get(k) ?? [];
      if ((us.length === 1 && !w.length) || (!us.length && w.length === 1)) {
        const name = w.length ? (WORLD_CITY_NAMES.get(k) ?? part) : titleCase(part);
        return { kind: 'city', name, key: k, us, world: w };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Building places

interface Draft {
  text: string;
  city: string | null;
  cityTok: Extract<Tok, { kind: 'city' }> | null;
  region: string | null;
  country: string | null;
  stateHint: string | null;
}

function emptyDraft(): Draft {
  return { text: '', city: null, cityTok: null, region: null, country: null, stateHint: null };
}

/** Settles a city and the code or name after it into one place. */
function settle(d: Draft, context: string): Place | null {
  const tok = d.cityTok;
  let city = d.city, region = d.region, country = d.country;
  if (tok) {
    city = tok.name;
    if (tok.state && tok.country) { region = region ?? tok.state; country = country ?? tok.country; }
  }
  // A US state was written ("Paris, TX"): US, unless the city is a foreign city and the code also names that country
  // or one of its regions ("Toronto, CA", "Perth, WA", "Berlin, DE", "Tbilisi, Georgia").
  if (d.stateHint && !country) {
    const code = d.stateHint;
    const usHere = tok ? tok.us.includes(code) : false;
    const foreignHere = tok ? tok.world.find((cc) => cc === code || (cc === 'CA' && CA_PROVINCE_CODES[code]) || (cc === 'AU' && AU_STATE_CODES[code]) || (cc === 'GE' && code === 'GA')) : undefined;
    const ambiguousCode = COUNTRIES[code] ? code : null;
    if (tok && !usHere && foreignHere) {
      country = foreignHere;
      region = foreignHere === code || (foreignHere === 'GE' && code === 'GA') ? null : code;
    } else if (!tok && ambiguousCode && city === null) {
      // A lone code: the state ("TX"), except the country-only codes handled in classify.
      region = code; country = 'US';
    } else if (tok && !usHere && tok.world.length && !foreignHere && ambiguousCode && tok.world.includes(ambiguousCode)) {
      country = ambiguousCode; region = null;
    } else {
      region = code; country = 'US';
      if (code === 'GA' && tok && tok.world.includes('GE') && !tok.us.includes('GA')) { country = 'GE'; region = null; }
      // "Georgia" with the posting naming Tbilisi, Batumi or the lari: the country.
      else if (code === 'GA' && !(tok && tok.us.includes('GA')) && GEORGIA_COUNTRY_CONTEXT.test(context)) { country = 'GE'; region = null; }
    }
  }
  if (d.stateHint && country === 'US' && !region) region = d.stateHint;
  if (tok && country === 'US' && !region && tok.us.length) region = tok.us.length === 1 ? tok.us[0] : (US_CITY_DOMINANT[tok.key] || null);
  if (tok && !country) {
    // A bare city: its only country, or the dominant reading, or the posting's own words.
    const readings: string[] = [...tok.us.map((s) => `US-${s}`), ...tok.world];
    const fromContext = readContext(tok, context);
    if (fromContext) {
      if (fromContext.startsWith('US-')) { country = 'US'; region = region ?? fromContext.slice(3); } else country = fromContext;
    } else if (tok.us.length && !tok.world.length) {
      country = 'US';
      if (tok.us.length === 1) region = region ?? tok.us[0];
      else { const dom = US_CITY_DOMINANT[tok.key]; if (dom) region = region ?? dom; }
    } else if (!tok.us.length && tok.world.length === 1) {
      country = tok.world[0];
    } else {
      const dom = GLOBAL_DOMINANT[tok.key];
      if (dom) {
        if (dom === 'US') country = 'US';
        else if (dom.startsWith('US-')) { country = 'US'; region = region ?? dom.slice(3); }
        else country = dom;
      } else if (readings.length && readings.every((r) => r.startsWith('US-'))) country = 'US';
      else if (tok.world.length > 1 && !tok.us.length && tok.world.every((c) => c === tok.world[0])) country = tok.world[0];
    }
    if (country === 'US' && !region && tok.us.length > 1) { const dom = US_CITY_DOMINANT[tok.key]; if (dom) region = dom; }
  }
  if (!city && !region && !country) return null;
  if (country && region === null && city === null && d.text === '') return null;
  return { text: d.text.trim(), city, region, country, placeId: null };
}

const GEORGIA_COUNTRY_CONTEXT = /\b(?:tbilisi|batumi|kutaisi|rustavi|zugdidi|sakartvelo|georgian\s+(?:lari|language|speaking|citizens?)|GEL\s?\d|\d\s?GEL\b|georgia\s*\(country\)|caucasus)\b/i;

/** Clues in the rest of the posting for a bare ambiguous city ("Portland" with "Maine" in the text). */
function readContext(tok: Extract<Tok, { kind: 'city' }>, context: string): string | null {
  if (!context) return null;
  const readings = [...tok.us.map((s) => `US-${s}`), ...tok.world];
  if (readings.length <= 1) return null;
  const name = tok.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = new Set<string>();
  for (const r of readings) {
    if (r.startsWith('US-')) {
      const st = r.slice(3);
      const re = new RegExp(`\\b${name},?\\s+(?:${st}|${US_STATES[st]})\\b`, 'i');
      if (re.test(context)) hits.add(r);
    } else {
      const names = (COUNTRIES[r] ?? []).filter((n) => n.length > 2).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (names.length && new RegExp(`\\b${name},?\\s+(?:${names.join('|')})\\b`, 'i').test(context)) hits.add(r);
    }
  }
  if (hits.size === 1) return [...hits][0];
  // "Portland" and a posting that names Maine (and not Oregon) elsewhere.
  if (!hits.size && tok.us.length > 1) {
    const named = tok.us.filter((st) => new RegExp(`\\b${US_STATES[st]}\\b`, 'i').test(context));
    if (named.length === 1 && !tok.world.some((cc) => (COUNTRIES[cc] ?? []).some((n) => n.length > 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(context)))) return `US-${named[0]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Location text

export interface LocationParse {
  places: Place[];
  /** The text says the job is outside the US ("Remote (outside of the United States)"). */
  excludesUs?: boolean;
  /** Work-model words in the location text ("Remote", "Hybrid", "On-site"), in order. */
  workModels: WorkModel[];
  /** Where a remote job is open, from the location text ("Remote - US" -> ["US"]). */
  remoteRegions: string[];
  /** The remote part of the text, for evidence ("Remote - US"). */
  remoteText: string | null;
}

const SPLIT_KEEP = /\b(?:trinidad and tobago|bosnia and herzegovina|antigua and barbuda|newfoundland and labrador|tyne and wear|turks and caicos|saint kitts and nevis|st\.? kitts and nevis|sao tome and principe|são tomé and príncipe|heard and mcdonald|wallis and futuna|saint vincent and the grenadines|uk and ireland)\b/gi;

function splitSegments(text: string): string[] {
  // Protect multi-word names that contain "and", and separators inside parentheses ("(3x in office/week)").
  const protectedText = text.replace(SPLIT_KEEP, (m) => m.replace(/ and /gi, ' §AND§ '))
    .replace(/\([^()]*\)/g, (m) => m.replace(/\//g, '§SL§').replace(/;/g, ',').replace(/\|/g, ',').replace(/\s+(?:and|or|&)\s+/gi, ' §AND§ '));
  return protectedText
    .split(/\s*(?:;|\||•|·|\n|\s\/\s|(?<=[a-z)])\/(?=[A-Za-z(])|\s+(?:or|Or)\s+|\s+OR\s+(?=[A-Z][a-z])|\s+and\s+|\s+&\s+|\s+y\s+|\s+et\s+|\s+und\s+|\s+e\s+(?=[A-Z]))\s*/)
    .map((s) => s.replace(/ §AND§ /g, ' and ').replace(/§SL§/g, '/').trim())
    .filter(Boolean);
}

const REMOTE_RE = /\b(?:remote(?:ly)?|work from home|wfh|home[- ]?based|homeworking|home working|telecommute|telework|virtual|distributed|anywhere|work from anywhere|nationwide|remoto|à distance|teletrabajo|home office)\b/i;
const HYBRID_RE = /\bhybrid\b|\bhíbrido\b|\bhybride\b/i;
const ONSITE_RE = /\b(?:on-?site|on site|in-?office|in office|in-?person|in person|office-?based|office based|presencial|sur site)\b/i;

/** Reads a location field: every place, the work-model words, and where a remote job is open. */
export function parseLocationText(input: string, opts: { context?: string } = {}): LocationParse {
  const out: LocationParse = { places: [], workModels: [], remoteRegions: [], remoteText: null };
  if (!input) return out;
  const text = normalizeText(input).replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!text) return out;
  const context = opts.context ?? '';
  if (/\b(?:outside|excluding|except)\s+(?:of\s+)?(?:the\s+)?(?:US|U\.S\.A?\.?|USA|United\s+States)\b|\bnon[- ](?:US|U\.S\.)\b/i.test(text)) {
    out.excludesUs = true;
    return out;
  }
  const addModel = (m: WorkModel) => { if (!out.workModels.includes(m)) out.workModels.push(m); };
  const addRegion = (r: string) => { if (!out.remoteRegions.includes(r)) out.remoteRegions.push(r); };

  // "US: SF, NYC, Seattle and Remote" - a country or region before a colon applies to the whole list.
  let colonCountry: string | null = null;
  let body = text;
  const colon = /^([A-Za-z .]{2,25}):\s*(.+)$/.exec(text);
  if (colon) {
    const head = classify(colon[1]);
    if (head.kind === 'country') { colonCountry = head.cc; body = colon[2]; }
    else if (head.kind === 'macro') { body = colon[2]; }
  }

  for (const seg0 of splitSegments(body)) {
    let seg = seg0;
    let segRemote = false;
    // Parentheses: work model words, a country for the remote part, or a place ("Hybrid (San Francisco, CA)").
    const parens: string[] = [];
    seg = seg.replace(/\(([^()]*)\)/g, (_m, inner: string) => { parens.push(inner); return ' '; }).replace(/[()]/g, ' ').trim();
    const models: WorkModel[] = [];
    const noteModels = (s: string) => {
      if (REMOTE_RE.test(s)) models.push('remote');
      if (HYBRID_RE.test(s)) models.push('hybrid');
      // "3x in office/week", "2 days in office" describe a hybrid schedule, not an onsite job.
      if (ONSITE_RE.test(s)) models.push(/\b\d\s*(?:x|days?)\b|\bdays?\s+(?:a|per)\s+week\b/i.test(s) ? 'hybrid' : 'onsite');
    };
    noteModels(seg);
    const innerPlaces: string[] = [];
    const innerScopes: string[] = [];
    for (const p of parens) {
      const before = models.length;
      noteModels(p);
      const cleaned = p.replace(new RegExp(`${REMOTE_RE.source}|${HYBRID_RE.source}|${ONSITE_RE.source}`, 'gi'), ' ').replace(/\b(?:hq|headquarters|only|office|based|x|\d+x?|days?|week|per|in|a|\/)\b/gi, ' ').replace(/[,/]+\s*$/, '').trim();
      if (!cleaned) continue;
      const toks = cleaned.split(/\s*,\s*/).map(classify);
      const allScope = toks.every((t) => t.kind === 'country' || t.kind === 'macro' || t.kind === 'noise');
      if (allScope && toks.some((t) => t.kind !== 'noise')) innerScopes.push(cleaned);
      else if (models.length === before || toks.some((t) => t.kind === 'city')) innerPlaces.push(cleaned);
    }
    for (const m of models) addModel(m);
    segRemote = models.includes('remote');
    // Take the work-model words out; what is left names the place.
    let placeText = seg
      .replace(/\b(?:fully|100%|full|partially|temporarily)\s+(?=remote|hybrid)/gi, ' ')
      .replace(new RegExp(`${REMOTE_RE.source}|${HYBRID_RE.source}|${ONSITE_RE.source}`, 'gi'), ' ')
      .replace(/\b(?:in the|within the|within|based in|based out of|from|only|eligible|friendly|first|optional|possible|ok|okay|position|role|job|opportunity|option|work|working|national|nationally|nationwide)\b/gi, ' ')
      .replace(/\b(?:hq|headquarters|office|offices|campus|location|locations)\b(?!\s*,?\s*[A-Z]{2}\b)/gi, ' ')
      .replace(/\s*[-–—:]\s*$/g, '').replace(/^\s*[-–—:,]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
    placeText = placeText.replace(/^(?:[-–—:,]\s*)+|(?:\s*[-–—:,])+$/g, '').trim();

    // "Segment: detail" - a place before the colon keeps it ("Austin: Domain Northside"); a country applies to the list.
    const colonSeg = /^([^:]{2,40}):\s*(.+)$/.exec(placeText);
    if (colonSeg) {
      const head = classify(colonSeg[1]);
      if (head.kind === 'city' || head.kind === 'state' || head.kind === 'unknown') placeText = colonSeg[1];
      else if (head.kind === 'country' || head.kind === 'macro') placeText = colonSeg[2] + (head.kind === 'country' ? ', ' + colonSeg[1] : '');
    }
    const segPlaces = placesFromPiece(placeText, context);
    // Parentheses name a place only when the text around them names no city ("India (Hyderabad)", "Hybrid (Austin, TX)").
    if (!segPlaces.some((p) => p.city)) {
      for (const ip of innerPlaces) {
        const inner = placesFromPiece(ip, context);
        if (!inner.length) continue;
        const outerCountry = segPlaces.find((p) => !p.city && p.country)?.country;
        for (const q of inner) if (!q.country && outerCountry) q.country = outerCountry;
        if (outerCountry) for (let i = segPlaces.length - 1; i >= 0; i--) if (!segPlaces[i].city && segPlaces[i].country === outerCountry) segPlaces.splice(i, 1);
        segPlaces.push(...inner);
      }
    }
    // A remote segment names where the job is open: "Remote - US", "Remote (Canada, UK, EU)", "US Remote".
    if (segRemote) {
      const scopeTexts = [...innerScopes];
      const scopes: string[] = [];
      for (const st of scopeTexts) for (const t of st.split(/\s*,\s*/).map(classify)) {
        if (t.kind === 'country') scopes.push(t.cc); else if (t.kind === 'macro') scopes.push(t.region);
      }
      for (const p of segPlaces) if (p.country) scopes.push(p.country);
      if (!scopes.length && colonCountry) scopes.push(colonCountry);
      if (/\b(?:nationwide|national)\b/i.test(seg) && !scopes.length && colonCountry) scopes.push(colonCountry);
      for (const r of scopes) addRegion(r);
      if (!out.remoteText) out.remoteText = seg0.trim();
      else if (scopes.length) out.remoteText += '; ' + seg0.trim();
      // A remote segment that names only a country or region adds that area as a place ("Remote - US").
      for (const p of segPlaces) out.places.push(p);
      for (const st of innerScopes) for (const t of st.split(/\s*,\s*/).map(classify)) {
        if (t.kind === 'country') out.places.push({ text: seg0.trim(), city: null, region: null, country: t.cc, placeId: null });
      }
    } else {
      for (const p of segPlaces) out.places.push(p);
      for (const st of innerScopes) for (const t of st.split(/\s*,\s*/).map(classify)) {
        if (t.kind === 'country') out.places.push({ text: seg0.trim(), city: null, region: null, country: t.cc, placeId: null });
      }
    }
  }
  if (colonCountry) for (const p of out.places) if (!p.country) p.country = colonCountry;
  out.places = dedupePlaces(out.places);
  return out;
}

function sameKey(p: Place): string {
  return [p.city ? keyOf(p.city) : '', p.region ? keyOf(p.region) : '', p.country ?? ''].join('|');
}

function dedupePlaces(places: Place[]): Place[] {
  const out: Place[] = [];
  for (const p of places) {
    const k = sameKey(p);
    if (out.some((o) => sameKey(o) === k)) continue;
    // A country-only place adds nothing next to a place in that country ("US-Remote, Chicago").
    out.push(p);
  }
  return out.filter((p, _i, all) => !(p.city === null && p.region === null && p.country && all.some((o) => o !== p && o.country === p.country && (o.city || o.region))));
}

/** Places in one segment without work-model words: "Austin, TX", "US-CA-San Francisco", "London, England, UK". */
function placesFromPiece(piece: string, context: string): Place[] {
  const text = piece.trim();
  if (!text) return [];
  const commaParts = text.split(/\s*,\s*/).filter(Boolean);
  const toks: Array<{ raw: string; tok: Tok; sub?: Tok[] }> = [];
  for (const part of commaParts) {
    // "Austin - TX", "US-CA-San Francisco", "Canada-Toronto", "MX- Mexico City": a dash group is one place.
    const dashParts = splitDash(part);
    if (dashParts.length > 1) {
      toks.push({ raw: part, tok: { kind: 'noise' }, sub: dashParts.map(classify) });
      continue;
    }
    // "Houston TX", "Seattle WA 98101", "New York City NY": a state code after the city with no comma.
    const m = /^(.+?)\s+([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(part);
    if (m && (US_STATES[m[2]] || CA_PROVINCE_CODES[m[2]]) && !/^[A-Z]{2}$/.test(m[1])) {
      const c = classify(m[1]);
      const s = classify(m[2]);
      if ((c.kind === 'city' || c.kind === 'unknown') && (s.kind === 'state' || s.kind === 'fregion')) {
        toks.push({ raw: part, tok: { kind: 'noise' }, sub: [c, s] });
        continue;
      }
    }
    toks.push({ raw: part, tok: classify(part) });
  }
  // "City, Region, Country" with a region that is not a US state: one place.
  const places: Place[] = [];
  let cur = emptyDraft();
  const flush = () => {
    const p = settle(cur, context);
    if (p) places.push(p);
    cur = emptyDraft();
  };
  const addText = (s: string) => { cur.text = cur.text ? `${cur.text}, ${s}` : s; };
  for (const { raw, tok, sub } of toks) {
    if (sub) {
      // One place from a dash group: roles by kind.
      if (cur.city || cur.cityTok || cur.region || cur.country) flush();
      const d = emptyDraft();
      d.text = raw;
      for (const s of sub) {
        if (s.kind === 'city' && !d.cityTok && !d.city) d.cityTok = s;
        else if (s.kind === 'unknown' && !d.cityTok && !d.city) d.city = s.name;
        else if (s.kind === 'state' && !d.stateHint) {
          if (s.ambiguousCountry && sub.indexOf(s) === 0 && sub.length > 1) d.country = s.ambiguousCountry === 'CA' ? 'CA' : s.ambiguousCountry;
          else d.stateHint = s.code;
        }
        else if (s.kind === 'fregion' && !d.region) { d.region = s.name; d.country = d.country ?? s.cc; }
        else if (s.kind === 'country' && !d.country) d.country = s.cc;
        else if (s.kind === 'usregion' && !d.region) { d.region = s.state; d.country = 'US'; }
      }
      // "US-CA-San Francisco": after a US country code, "CA" is California.
      if (d.country === 'US' && !d.stateHint) {
        const st = sub.find((s) => s.kind === 'state') as Extract<Tok, { kind: 'state' }> | undefined;
        if (st) d.region = st.code;
      }
      const p = settle(d, context);
      if (p) places.push(p);
      continue;
    }
    switch (tok.kind) {
      case 'noise': case 'zip': break;
      case 'city':
        if (cur.cityTok && keyOf(cur.cityTok.name) === tok.key) { addText(raw); break; } // "Paris, Paris, France"
        // "Richland, Washington", "Albany, New York": a state name after a city is the state.
        if ((cur.cityTok || cur.city) && !cur.region && !cur.stateHint && !cur.country && !cur.cityTok?.state && (keyOf(raw) === 'washington' || keyOf(raw) === 'new york')) {
          cur.stateHint = tok.key === 'washington' ? 'WA' : 'NY'; addText(raw); break;
        }
        if (cur.city || cur.cityTok || cur.region || cur.country || cur.stateHint) flush();
        cur.cityTok = tok; addText(raw);
        break;
      case 'unknown':
        if (cur.cityTok && !cur.region && !cur.stateHint && !cur.country) {
          // "Amsterdam, North Holland, Netherlands" with an unlisted region, or a neighbourhood.
          cur.region = tok.name; addText(raw); break;
        }
        if (cur.city || cur.cityTok || cur.region || cur.country || cur.stateHint) flush();
        cur.city = tok.name; addText(raw);
        break;
      case 'state':
        if (cur.region && cur.country && tok.ambiguousCountry === cur.country) { addText(raw); flush(); break; }
        if ((cur.cityTok || cur.city) && !cur.stateHint && !cur.region && !cur.country) { cur.stateHint = tok.code; addText(raw); break; }
        if (cur.cityTok || cur.city || cur.region || cur.stateHint || cur.country) flush();
        cur.stateHint = tok.code; addText(raw);
        break;
      case 'fregion':
        if ((cur.cityTok || cur.city) && !cur.region && !cur.stateHint) {
          // "London, ON" -> Canada; "Portland, Maine" is a US state and never gets here.
          if (tok.alsoState && cur.cityTok && cur.cityTok.us.includes(tok.alsoState)) { cur.stateHint = tok.alsoState; addText(raw); break; }
          cur.region = tok.name; cur.country = cur.country ?? tok.cc; addText(raw); break;
        }
        if (cur.cityTok || cur.city || cur.region || cur.country) flush();
        cur.region = tok.name; cur.country = tok.cc; addText(raw);
        break;
      case 'usregion':
        if (cur.cityTok || cur.city || cur.region || cur.country) flush();
        cur.region = tok.state; cur.country = 'US'; addText(raw);
        if (!tok.state) cur.city = null;
        flush();
        break;
      case 'country':
        // "Monterrey, NL, México": a region code read as another country's province gives way to the stated country.
        if (cur.country && cur.country !== tok.cc && cur.region && /^[A-Z]{2,3}$/.test(cur.region) && (!cur.cityTok || cur.cityTok.world.includes(tok.cc) || !cur.cityTok.world.includes(cur.country))) {
          cur.country = tok.cc; addText(raw); flush(); break;
        }
        if (cur.cityTok || cur.city || cur.region || cur.stateHint) {
          if (!cur.country || cur.country === tok.cc) {
            // "Tbilisi, Georgia (country)"; "Toronto, ON, Canada"; "London, UK".
            if (cur.stateHint && tok.cc !== 'US') {
              // "Vancouver, BC, CA" style is handled by codes; a US state next to a foreign country: the country wins
              // only when the city is known there.
              const known = cur.cityTok?.world.includes(tok.cc);
              if (known) { cur.stateHint = null; cur.country = tok.cc; }
              else { cur.country = null; }
            } else cur.country = tok.cc;
            addText(raw); flush();
            break;
          }
        }
        if (cur.cityTok || cur.city || cur.region || cur.stateHint || cur.country) flush();
        places.push({ text: raw, city: null, region: null, country: tok.cc, placeId: null });
        break;
      case 'macro':
        if (cur.cityTok || cur.city || cur.region || cur.stateHint || cur.country) flush();
        places.push({ text: raw, city: null, region: tok.region, country: null, placeId: null });
        break;
    }
  }
  flush();
  // "The Roof, Huangpu District, Shanghai": unlisted words next to a known place are address parts, not places.
  if (places.some((p) => p.country) && places.some((p) => !p.country && !p.region)) {
    return places.filter((p) => p.country || p.region);
  }
  return places;
}

function splitDash(part: string): string[] {
  // Spaced dashes always split; a tight dash splits only next to a country code or name ("US-NYC", "Canada-Remote").
  const spaced = part.split(/\s+[-–—]\s+|\s+[-–—](?=\S)|(?<=\S)[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  if (spaced.length > 1) return spaced.flatMap((s) => tightDash(s));
  return tightDash(part);
}

function tightDash(s: string): string[] {
  if (!/-/.test(s)) return [s];
  const parts = s.split('-').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [s];
  const first = classify(parts[0]);
  const last = classify(parts[parts.length - 1]);
  const isCode = (t: Tok) => t.kind === 'country' || (t.kind === 'state' && /^[A-Z]{2}$/.test(parts[0]));
  if (isCode(first) || isCode(last) || /^(?:remote|hybrid|onsite)$/i.test(parts[0]) || /^(?:remote|hybrid|onsite|hq)$/i.test(parts[parts.length - 1])) return parts;
  return [s];
}

/** Every place in a location text, never a default country. */
export function parsePlaces(text: string, opts: { context?: string } = {}): Place[] {
  return parseLocationText(text, opts).places;
}

// ---------------------------------------------------------------------------------------------------------------
// Places named in the posting text (pasted jobs, or a board with an empty location field)

const LABELED = /(?:^|[.;!]\s+)[\s\-*•]*(?:job\s+|work\s+|primary\s+|office\s+|position\s+|role\s+)?(?:location|locations|location\(s\)|work\s+site|worksite|city|ubicación|ubicacion|lugar\s+de\s+trabajo|lieu(?:\s+de\s+travail)?|standort|arbeitsort|localização|local\s+de\s+trabalho)\s*[:\-–]\s*([^\n]{2,160})$/gim;
const SENTENCE = /\b(?:this|the)\s+(?:role|position|job|opportunity)\s+(?:is|will\s+be)\s+(?:based|located|onsite|on-site|in-office)\s+(?:in|at|out\s+of)\s+(?:our\s+)?(?:office\s+in\s+)?([^.;\n]{2,80})/gi;
const BOILERPLATE = /\b(?:headquarter\w*|hq|founded|offices?\s+(?:in|across|around)|we\s+(?:have|are)|our\s+company|corporate\s+office|global\s+presence|locations\s+across)\b/i;

export function placesFromText(text: string, opts: { context?: string } = {}): { places: Place[]; evidence: string | null } {
  if (!text) return { places: [], evidence: null };
  // Places in a "Similar jobs" block belong to other jobs.
  const t = cutOtherJobs(normalizeText(text));
  const found: Place[] = [];
  let evidence: string | null = null;
  LABELED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABELED.exec(t)) !== null) {
    const line = m[0];
    if (BOILERPLATE.test(line)) continue;
    const ps = parseLocationText(m[1], opts).places;
    if (ps.length) { found.push(...ps); evidence = evidence ?? clip(line.trim(), 300); }
    if (found.length >= 25) break;
  }
  if (!found.length) {
    SENTENCE.lastIndex = 0;
    while ((m = SENTENCE.exec(t)) !== null) {
      const ps = parseLocationText(m[1].replace(/\b(?:office|offices|headquarters|hq)\b.*$/i, ''), opts).places.filter((p) => p.city || p.region);
      if (ps.length) { found.push(...ps); evidence = evidence ?? clip(m[0], 300); break; }
    }
  }
  if (!found.length) {
    // A place at the end of the first line (the title): "Nurse - Portland, ME", "Therapist in Wayne, PA", "(Louisville, KY)".
    const first = t.split('\n').find((l) => l.trim()) ?? '';
    const tm = /(?:\s[-–|@]\s*|\bin\s+|\(|,\s+)([A-Z][\p{L}.' -]{1,40},\s*(?:[A-Z]{2}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?))\)?\s*$/u.exec(first.trim());
    if (tm) {
      const ps = parseLocationText(tm[1], opts).places.filter((p) => p.city && p.country);
      if (ps.length) { found.push(...ps); evidence = first.trim().slice(0, 300); }
    }
  }
  if (!found.length) {
    // A pasted page: a short line near the top that is only a place ("St. Louis, MO", "Austin, TX 78701").
    const lines = t.split('\n').slice(0, 15).map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      if (l.length > 60 || BOILERPLATE.test(l)) continue;
      if (!/^[\p{L}][\p{L} .'\-]+,\s*[A-Z]{2}(?:\s+\d{5})?$|^[\p{L}][\p{L} .'\-]+,\s*[\p{L} ]+$/u.test(l)) continue;
      const ps = parseLocationText(l, opts).places.filter((p) => p.city && p.country);
      if (ps.length) { found.push(...ps); evidence = l; break; }
    }
  }
  return { places: dedupePlaces(found), evidence };
}

// ---------------------------------------------------------------------------------------------------------------
// Structured addresses from boards (Ashby postalAddress, Workable, Recruitee, JSON-LD)

export interface BoardAddress {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  postalCode?: string | null;
  text?: string | null;
}

export function placeFromAddress(a: BoardAddress, context = ''): Place | null {
  const city = (a.city ?? '').trim();
  const region = (a.region ?? '').trim();
  const countryRaw = (a.country ?? '').trim();
  let country: string | null = null;
  if (countryRaw) {
    if (/^[A-Za-z]{2}$/.test(countryRaw)) country = countryRaw.toUpperCase() === 'UK' ? 'GB' : countryRaw.toUpperCase();
    else if (/^[A-Za-z]{3}$/.test(countryRaw) && ISO3[countryRaw.toUpperCase()]) country = ISO3[countryRaw.toUpperCase()];
    else { const k = keyOf(countryRaw); country = COUNTRY_BY_KEY.get(k) ?? (k === 'georgia' ? null : null); }
  }
  const parts = [city, region].filter(Boolean);
  if (!parts.length && !country) return null;
  const text = a.text?.trim() || [city, region, countryRaw].filter(Boolean).join(', ');
  if (country && country !== 'US') {
    let reg: string | null = region || null;
    if (reg && country === 'CA') { const code = Object.entries(CA_PROVINCE_CODES).find(([, n]) => keyOf(n) === keyOf(reg!))?.[0]; if (code) reg = code; }
    return { text, city: city || null, region: reg, country, placeId: null };
  }
  const parsed = parsePlaces([city, region, country === 'US' ? 'US' : ''].filter(Boolean).join(', '), { context });
  const p = parsed[0];
  if (p) return { ...p, text, country: p.country ?? country };
  return { text, city: city || null, region: region || null, country, placeId: null };
}

// ---------------------------------------------------------------------------------------------------------------
// US or not

/**
 * true = the job is in the US or open to people in the US; false = clearly elsewhere; null = cannot tell.
 * Board country codes win; a remote job limited to another area is not a US job.
 */
export function usFromFacts(places: Place[], remoteRegions: string[], boardCountries: string[] = []): boolean | null {
  const cc = boardCountries.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  if (cc.length) return cc.includes('US');
  const openUs = (r: string) => r === 'US' || r === 'NA' || r === 'AMER' || r === 'WORLDWIDE';
  if (remoteRegions.length && places.every((p) => !p.city && !p.region || p.country === null || remoteRegions.includes(p.country))) {
    if (remoteRegions.some(openUs)) return true;
    if (places.some((p) => p.country === 'US')) return true;
    return false;
  }
  const countries = places.map((p) => p.country);
  if (countries.includes('US')) return true;
  if (remoteRegions.some(openUs)) return true;
  const known = places.filter((p) => p.country !== null || (p.region && /^(?:EU|EMEA|APAC|LATAM)$/.test(p.region)));
  if (known.length && known.length === places.length) return false;
  // A long list of foreign places with one or two unreadable names ("Warsaw; Serbia; Split; Córdoba; ...").
  if (known.length >= 2 && known.length * 3 >= places.length * 2) return false;
  if (remoteRegions.length) return false;
  if (known.length && places.every((p) => p.country !== 'US')) return places.some((p) => p.country === null && (p.city || p.region)) ? null : false;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Old spike API

/** true US, false clearly elsewhere, null unknown ("Remote", empty). Board country codes win. */
export function isUsLocation(location: string, countries: string[] = []): boolean | null {
  if (countries.length > 0) return countries.some((c) => c.toUpperCase() === 'US');
  const r = parseLocationText(location ?? '');
  if (r.excludesUs) return false;
  return usFromFacts(r.places, r.remoteRegions);
}

export function isRemoteText(location: string): boolean {
  return /remote/i.test(location);
}

