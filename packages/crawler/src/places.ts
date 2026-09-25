// Places, work model and remote scope from a board's own words. Conservative: a part of a place is filled only when
// the text states it plainly ("Austin, TX", "Toronto, ON", "Berlin, Germany"). Nothing is ever filled by default:
// an empty location gives no place, and "Remote" gives no country.

import type { Place, RemoteScope } from '@jobleft/contracts';

const US_STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan',
  MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire',
  NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio',
  OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota',
  TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia',
  WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia', PR: 'puerto rico',
};
const US_STATE_BY_NAME = Object.fromEntries(Object.entries(US_STATES).map(([c, n]) => [n, c]));
const CA_PROVINCES: Record<string, string> = {
  ON: 'ontario', QC: 'quebec', BC: 'british columbia', AB: 'alberta', MB: 'manitoba', SK: 'saskatchewan',
  NS: 'nova scotia', NB: 'new brunswick', NL: 'newfoundland and labrador', PE: 'prince edward island', YT: 'yukon',
  NT: 'northwest territories', NU: 'nunavut',
};
const CA_PROVINCE_BY_NAME = Object.fromEntries(Object.entries(CA_PROVINCES).map(([c, n]) => [n, c]));

const COUNTRIES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'us': 'US', 'u.s.': 'US', 'u.s.a.': 'US',
  'america': 'US', 'united kingdom': 'GB', 'uk': 'GB', 'u.k.': 'GB', 'great britain': 'GB', 'england': 'GB',
  'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB', 'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR',
  'argentina': 'AR', 'chile': 'CL', 'colombia': 'CO', 'peru': 'PE', 'ireland': 'IE', 'germany': 'DE', 'france': 'FR',
  'spain': 'ES', 'portugal': 'PT', 'italy': 'IT', 'netherlands': 'NL', 'the netherlands': 'NL', 'belgium': 'BE',
  'switzerland': 'CH', 'austria': 'AT', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
  'poland': 'PL', 'czech republic': 'CZ', 'czechia': 'CZ', 'romania': 'RO', 'greece': 'GR', 'hungary': 'HU',
  'ukraine': 'UA', 'turkey': 'TR', 'israel': 'IL', 'united arab emirates': 'AE', 'uae': 'AE', 'saudi arabia': 'SA',
  'india': 'IN', 'pakistan': 'PK', 'singapore': 'SG', 'japan': 'JP', 'south korea': 'KR', 'korea': 'KR',
  'china': 'CN', 'hong kong': 'HK', 'taiwan': 'TW', 'philippines': 'PH', 'vietnam': 'VN', 'thailand': 'TH',
  'malaysia': 'MY', 'indonesia': 'ID', 'australia': 'AU', 'new zealand': 'NZ', 'south africa': 'ZA', 'nigeria': 'NG',
  'kenya': 'KE', 'egypt': 'EG', 'estonia': 'EE', 'latvia': 'LV', 'lithuania': 'LT', 'serbia': 'RS', 'croatia': 'HR',
  'bulgaria': 'BG', 'slovakia': 'SK', 'slovenia': 'SI', 'luxembourg': 'LU', 'iceland': 'IS', 'costa rica': 'CR',
  'uruguay': 'UY', 'puerto rico': 'PR',
};

const REMOTE_WORD = /\b(remote|anywhere|work from home|wfh|distributed|telecommute|virtual)\b/i;
const HYBRID_WORD = /\bhybrid\b/i;
const ONSITE_WORD = /\b(on-?site|in[- ]office|in[- ]person)\b/i;
/** Words that say "several places" without naming them. */
const GENERIC = /^(multiple|various|several|many|all|numerous|different|flexible)( (us |u\.s\. )?(locations?|offices?|cities|sites|places))?\.?$|^(tbd|n\/a|na|none|see (job )?description|location flexible|to be determined)$/i;

/** Splits a board's location field into the places it names ("Austin, TX; Denver, CO | Remote"). */
export function splitPlaces(text: string): string[] {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(/\s*(?:;|\||•|·|\n|\s\/\s)\s*/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** True when the text names no real place ("Multiple Locations", "TBD"). */
export function isGenericPlace(text: string): boolean {
  return GENERIC.test(text.trim());
}

function countryOf(s: string): string | null {
  const k = s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (COUNTRIES[k]) return COUNTRIES[k]!;
  return null;
}

const CITY = /^[\p{L}][\p{L}\p{M} .'’()-]{0,58}[\p{L}.)]?$/u;

function stripDecor(text: string): string {
  return text
    .replace(/^\s*(hybrid|remote|on-?site|in[- ]office)\s*(?:[-–—:]|\bin\b)\s*/i, '')
    .replace(/\s*\((hybrid|remote|on-?site|in[- ]office)[^)]*\)\s*$/i, '')
    .replace(/\s*[-–—]\s*(hybrid|remote|on-?site|in[- ]office)\s*$/i, '')
    .trim();
}

/** One place from one piece of text. `text` is always kept as the board wrote it. */
export function parsePlace(text: string): Place {
  const place: Place = { text: text.trim(), city: null, region: null, country: null, placeId: null };
  const t = text.trim();
  if (!t) return place;
  if (REMOTE_WORD.test(t)) {
    // A remote place states at most a country or region ("Remote - US", "Remote (Canada)").
    const scope = remoteRegions(t);
    const countries = scope.filter((r) => /^[A-Z]{2}$/.test(r));
    if (countries.length === 1) place.country = countries[0]!;
    return place;
  }
  const core = stripDecor(t).replace(/\s*\((hq|headquarters|head office|main office|office|campus)\)\s*$/i, '');
  const parts = core.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    const c = countryOf(parts[0]!);
    if (c) place.country = c;
    return place;
  }
  const last = parts[parts.length - 1]!;
  let country = countryOf(last);
  // "Toronto, ON, CA": after a Canadian province, "CA" is the country code of Canada, not California.
  if (!country && parts.length >= 3 && last.toUpperCase() === 'CA' && CA_PROVINCES[parts[parts.length - 2]!.toUpperCase()]) country = 'CA';
  const rest = country ? parts.slice(0, -1) : parts;
  if (rest.length === 0) { place.country = country; return place; }
  const city = rest[0]!;
  const regionText = rest.length >= 2 ? rest[rest.length - 1]! : null;
  let region: string | null = null;
  if (regionText) {
    const up = regionText.toUpperCase().replace(/\./g, '');
    const low = regionText.toLowerCase();
    if (US_STATES[up] && (!country || country === 'US')) { region = up; country = 'US'; }
    else if (US_STATE_BY_NAME[low] && (!country || country === 'US')) { region = US_STATE_BY_NAME[low]!; country = 'US'; }
    else if (CA_PROVINCES[up] && (!country || country === 'CA')) { region = up; country = 'CA'; }
    else if (CA_PROVINCE_BY_NAME[low] && (!country || country === 'CA')) { region = CA_PROVINCE_BY_NAME[low]!; country = 'CA'; }
    else if (country && CITY.test(regionText)) region = regionText;
    else if (!country) return place; // "Springfield, Something": not sure what the second part is
  }
  if (!CITY.test(city) || HYBRID_WORD.test(city) || ONSITE_WORD.test(city)) {
    place.country = country;
    place.region = region;
    return place;
  }
  place.city = city;
  place.region = region;
  place.country = country;
  return place;
}

/** Regions a remote text names: ISO codes, or WORLDWIDE, EU, EMEA, APAC, LATAM, NA. [] when it names none. */
export function remoteRegions(text: string): string[] {
  const t = ` ${text.toLowerCase()} `;
  const out = new Set<string>();
  if (/\b(worldwide|anywhere in the world|global|globally|international)\b/.test(t)) out.add('WORLDWIDE');
  if (/\bemea\b/.test(t)) out.add('EMEA');
  if (/\bapac\b|\basia[- ]pacific\b/.test(t)) out.add('APAC');
  if (/\blatam\b|\blatin america\b/.test(t)) out.add('LATAM');
  if (/\bnorth america\b|\bnoram\b/.test(t)) out.add('NA');
  if (/\b(eu|europe|european union)\b/.test(t)) out.add('EU');
  if (/\b(us|usa|u\.s\.a?\.?|united states|us-based|us only)\b/.test(t)) out.add('US');
  for (const [name, code] of Object.entries(COUNTRIES)) {
    if (name.length <= 3) continue; // short forms handled above
    if (t.includes(` ${name} `) || t.includes(`(${name})`) || t.includes(` ${name})`) || t.includes(`(${name} `) || t.includes(` ${name},`)) out.add(code);
  }
  return [...out];
}

export interface WorkModelFact {
  workModel: 'onsite' | 'hybrid' | 'remote' | null;
  remoteScope: RemoteScope | null;
  /** 'board_field' when the board states the work model as a field; 'location_text' when read from the places. */
  source: 'board_field' | 'location_text' | null;
  evidence: string | null;
}

/**
 * The work model. A board field wins. Otherwise the place texts decide ("Remote - US" -> remote, "Hybrid - NYC" ->
 * hybrid). Never a default: a plain city says nothing about the work model.
 */
export function workModelOf(field: string, placeTexts: string[], fieldEvidence?: string): WorkModelFact {
  const f = (field ?? '').toLowerCase();
  const remoteTexts = placeTexts.filter((p) => REMOTE_WORD.test(p));
  const scopeFrom = (texts: string[]): RemoteScope | null => {
    for (const t of texts) {
      const regions = remoteRegions(t);
      if (regions.length > 0) return { regions, text: t };
    }
    return null;
  };
  if (f === 'remote' || f === 'hybrid' || f === 'onsite') {
    return {
      workModel: f,
      remoteScope: f === 'remote' ? scopeFrom(remoteTexts.length ? remoteTexts : placeTexts) : null,
      source: 'board_field',
      evidence: (fieldEvidence ?? field).slice(0, 500),
    };
  }
  const hybrid = placeTexts.find((p) => HYBRID_WORD.test(p));
  if (hybrid) return { workModel: 'hybrid', remoteScope: null, source: 'location_text', evidence: hybrid.slice(0, 500) };
  if (remoteTexts.length > 0) {
    return { workModel: 'remote', remoteScope: scopeFrom(remoteTexts), source: 'location_text', evidence: remoteTexts[0]!.slice(0, 500) };
  }
  const onsite = placeTexts.find((p) => ONSITE_WORD.test(p));
  if (onsite) return { workModel: 'onsite', remoteScope: null, source: 'location_text', evidence: onsite.slice(0, 500) };
  return { workModel: null, remoteScope: null, source: null, evidence: null };
}
