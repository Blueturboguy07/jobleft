// Pure text helpers for feeds: mojibake repair, remote scope, places, salary fields, safe links.
// Rule for every helper: when the text does not say it, the answer is null or empty. Nothing is guessed.

import type { EmploymentType, Pay, PayPeriod, Place, RemoteScope } from '@jobleft/contracts';
import { countryFromCode } from '@jobleft/crawler';
import { annualize, decodeEntities, parsePayFromText } from '@jobleft/parsers';

/** One line of plain text from a source field (a title, a company): entities decoded, tags and extra spaces removed. */
export function plainLine(v: string): string {
  return decodeEntities(fixMojibake(v).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Mojibake: UTF-8 bytes that were decoded as Latin-1 or Windows-1252 ("MecÃ¡nico" for "Mecánico").

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const SUSPECT = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]/;

/** Repairs double-encoded UTF-8. Returns the input unchanged unless the repair gives valid UTF-8. */
export function fixMojibake(s: string): string {
  if (!s || !SUSPECT.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0xff) bytes[i] = c;
    else {
      const b = CP1252[c];
      if (b === undefined) return s;
      bytes[i] = b;
    }
  }
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return out === s ? s : out;
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Links

/** An absolute http(s) URL, or null. `javascript:`, `data:`, relative and malformed links give null. */
export function safeHttpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 4096) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  // Keep the link exactly as the source wrote it (O1: the link opens the exact URL), unless it needs encoding.
  return /^https?:\/\/[^\s<>"]+$/.test(s) ? s : u.toString();
}

// ---------------------------------------------------------------------------------------------------------------
// Regions and places

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
]);
const US_STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida',
  'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma',
  'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'puerto rico',
]);
const EXTRA_COUNTRIES: Record<string, string> = {
  'the netherlands': 'NL', 'holland': 'NL', 'south korea': 'KR', 'korea': 'KR', 'north macedonia': 'MK',
  'czech republic': 'CZ', 'czechia': 'CZ', 'hungary': 'HU', 'greece': 'GR', 'turkey': 'TR', 'türkiye': 'TR',
  'malaysia': 'MY', 'thailand': 'TH', 'vietnam': 'VN', 'indonesia': 'ID', 'pakistan': 'PK', 'bangladesh': 'BD',
  'egypt': 'EG', 'nigeria': 'NG', 'kenya': 'KE', 'south africa': 'ZA', 'argentina': 'AR', 'colombia': 'CO',
  'chile': 'CL', 'peru': 'PE', 'uruguay': 'UY', 'costa rica': 'CR', 'romania': 'RO', 'bulgaria': 'BG',
  'serbia': 'RS', 'croatia': 'HR', 'ukraine': 'UA', 'estonia': 'EE', 'latvia': 'LV', 'lithuania': 'LT',
  'slovakia': 'SK', 'slovenia': 'SI', 'luxembourg': 'LU', 'iceland': 'IS', 'china': 'CN', 'hong kong': 'HK',
  'taiwan': 'TW', 'philippines': 'PH', 'united arab emirates': 'AE', 'uae': 'AE', 'saudi arabia': 'SA',
  'qatar': 'QA', 'kyrgyzstan': 'KG', 'kazakhstan': 'KZ', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'great britain': 'GB', 'britain': 'GB', 'u.s.': 'US', 'u.s.a.': 'US', 'u.s.a': 'US', 'usa': 'US',
  'united states': 'US', 'united states of america': 'US', 'trinidad and tobago': 'TT',
};

/** ISO alpha-2 code for a country name or code, or null. US state names and codes are not countries here. */
export function countryCode(token: string): string | null {
  const t = token.trim().replace(/\.$/, '');
  if (!t) return null;
  const lower = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (EXTRA_COUNTRIES[lower]) return EXTRA_COUNTRIES[lower]!;
  if (/^[A-Za-z]{2}$/.test(t)) {
    // Two letters are a country code only in upper case and only when they are not a US state code.
    if (t !== t.toUpperCase() || US_STATE_CODES.has(t)) return null;
    // PT, ET, CT and MT are left out on purpose: in job posts they are US time zones far more often than countries.
    const known = new Set(['GB', 'DE', 'FR', 'ES', 'NL', 'IE', 'PL', 'SE', 'NO', 'DK', 'FI', 'CH', 'AT', 'BE',
      'JP', 'SG', 'IL', 'BR', 'MX', 'AU', 'NZ', 'UK', 'US']);
    if (!known.has(t)) return null;
    return t === 'UK' ? 'GB' : t;
  }
  const c = countryFromCode(lower);
  return c.length === 1 ? c[0]! : null;
}

function isUsState(token: string): boolean {
  const t = token.trim();
  return US_STATE_CODES.has(t) || US_STATE_NAMES.has(t.toLowerCase());
}

/**
 * One place from a text such as "Austin, TX", "Austin, Austin, Texas, United States", "Mendip, United Kingdom" or
 * "Germany". Only what the text says is filled; the rest stays null. Returns null for work-model words ("Remote").
 */
export function placeFromText(text: string): Place | null {
  let t = text.replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
  if (!t) return null;
  if (/\b(remote|remoto|anywhere|worldwide)\b/i.test(t)) {
    // "Mexico City, Mexico - Remote" still names a place; "Remote - US" and "Remote (Europe)" do not.
    const rest = t.replace(/[\s,(\-–—]*\b(fully\s+)?(remote|remoto|anywhere|worldwide)\b[\s)\-–—]*/gi, ' ').trim().replace(/^[,\-–—\s]+|[,\-–—\s]+$/g, '');
    if (!rest.includes(',')) return null;
    t = rest;
  }
  if (/^(remote|remoto|anywhere|worldwide|global|flexible\s*\/\s*remote|hybrid|on-?site|in[- ]office|n\/a|tbd|various|multiple locations)$/i.test(t)) return null;
  const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
  const place: Place = { text: t, city: null, region: null, country: null, placeId: null };
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  const lastCountry = countryCode(last);
  if (parts.length === 1) {
    if (lastCountry) place.country = lastCountry;
    else if (isUsState(last)) { place.region = last; place.country = 'US'; }
    return place;
  }
  if (lastCountry) {
    place.country = lastCountry;
    const rest = parts.slice(0, -1);
    const dedup = rest.filter((p, i) => i === 0 || p.toLowerCase() !== rest[i - 1]!.toLowerCase());
    place.city = dedup[0] ?? null;
    if (dedup.length > 1) place.region = dedup[dedup.length - 1] ?? null;
    if (place.city && place.region && place.city.toLowerCase() === place.region.toLowerCase()) place.region = null;
    return place;
  }
  if (isUsState(last)) {
    place.region = last;
    place.country = 'US';
    place.city = parts[0] !== last ? parts[0]! : null;
    return place;
  }
  // "Toronto, ON" and other two-part texts we cannot place: keep the words, fill nothing.
  return place;
}

const SCOPE_WORDS: Array<[RegExp, string[]]> = [
  [/\b(world\s?wide|anywhere(?! in)|global(ly)?|all countries|international)\b/i, ['WORLDWIDE']],
  [/\bnorth america\b/i, ['NA']],
  [/\b(latin america|latam|south america)\b/i, ['LATAM']],
  [/\bamericas\b/i, ['NA', 'LATAM']],
  [/\b(europe|european union|eu)\b/i, ['EU']],
  [/\bemea\b/i, ['EMEA']],
  [/\b(apac|asia[- ]pacific|asia)\b/i, ['APAC']],
];
const US_WORDS = /\b(usa|u\.s\.a?\.?|united states( of america)?|anywhere in the us|us[- ]based)\b/i;
/** A standalone upper-case "US" (case-sensitive on purpose: "join us" is not a region). */
const US_TOKEN = /(?:^|[^A-Za-z])US(?:$|[^A-Za-z])/;

/**
 * Where a remote job accepts applicants, from the source's own words ("USA Only", "Europe only", "Worldwide",
 * "Remote (US or Canada)", "Remote in USA"). Regions are ISO alpha-2 codes or WORLDWIDE, EU, EMEA, APAC, LATAM, NA.
 * Regions stay empty when the words name none; `text` always keeps the words. null for an empty text.
 */
export function parseRemoteScope(text: string | null | undefined): RemoteScope | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Time zones ("PT/ET hours", "UTC+2", "US Pacific overlap") are working hours, not where applicants may live.
  const u = t.replace(/\b(PT|ET|CT|MT|PST|EST|CST|MST|PDT|EDT|CET|CEST|GMT|UTC|BST|IST)([+-]\d{1,2})?\b(\s*\/\s*\b(PT|ET|CT|MT|PST|EST|CST|MST|CET|GMT|UTC)\b)*/g, ' ')
    .replace(/\b\d+\s*h(ours?)?\s+overlap\s+with\s+[^,;)]*/gi, ' ')
    .replace(/\boverlap\s+with\s+[^,;)]*/gi, ' ');
  const regions: string[] = [];
  const add = (r: string) => { if (!regions.includes(r)) regions.push(r); };
  if (US_WORDS.test(u) || US_TOKEN.test(u)) add('US');
  for (const [re, rs] of SCOPE_WORDS) if (re.test(u)) rs.forEach(add);
  // Countries and US states named as separate words ("USA, Canada", "Remote - Texas", "Poland or Romania").
  const tokens = u
    .replace(/\b(remote|remoto|only|fully|full[- ]time|residents?|based|in|from|within|time ?zones?|hours?|preferred|required)\b/gi, ',')
    .split(/[,;/|()+&]|\bor\b|\band\b|\s-\s/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  for (const tok of tokens) {
    const c = countryCode(tok);
    if (c) add(c);
    else if (isUsState(tok)) add('US');
    else if (/^can(ada)?$/i.test(tok)) add('CA');
  }
  return { regions, text: t };
}

/** true = open to people in the US by the stated regions, false = stated regions exclude the US, null = not stated. */
export function scopeOpenToUs(scope: RemoteScope | null): boolean | null {
  if (!scope || scope.regions.length === 0) return null;
  return scope.regions.some((r) => r === 'US' || r === 'WORLDWIDE' || r === 'NA');
}

// ---------------------------------------------------------------------------------------------------------------
// Pay stated in a board field ("$60/hr", "$30 an hour", "€50k - €60k", "USD 90,000 - 110,000")

const CUR_MARK: Array<[RegExp, string]> = [
  [/\b(?:CA\$|C\$|CAD)/i, 'CAD'], [/\b(?:A\$|AU\$|AUD)/i, 'AUD'], [/\b(?:NZ\$|NZD)/i, 'NZD'], [/€|\bEUR\b|\beuros?\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'], [/\bCHF\b/i, 'CHF'], [/\bSEK\b/i, 'SEK'], [/\bINR\b|₹/i, 'INR'], [/\bUS\$|\bUSD\b|\$/i, 'USD'],
];
const PERIOD_MARK: Array<[RegExp, PayPeriod]> = [
  [/(\/\s*(hr|hour|h)\b|per\s+hour|an\s+hour|hourly|\/hora)/i, 'hour'],
  [/(\/\s*(day|d)\b|per\s+day|a\s+day|daily)/i, 'day'],
  [/(\/\s*(wk|week)\b|per\s+week|a\s+week|weekly)/i, 'week'],
  [/(\/\s*(mo|month)\b|per\s+month|a\s+month|monthly)/i, 'month'],
  [/(\/\s*(yr|year|annum)\b|per\s+(year|annum)|a\s+year|annual(ly)?|yearly|p\.?a\.?\b)/i, 'year'],
];

function num(raw: string, k: boolean): number {
  const n = parseFloat(raw.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

/**
 * Pay from a salary field. The currency must be written. The period must be written, except that an amount of
 * 10,000 or more with no period is read as a year (salary fields state yearly pay; the evidence keeps the words).
 * Returns null for anything unclear. `source` is always "board_field".
 */
export function payFromSalaryField(text: string | null | undefined): Pay | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 200) return null;
  // More than two money marks ("Junior SWE ($300k), SWE ($350k), Research ($300k-$400k)") is several roles' pay.
  if ((t.match(/[$€£₹]/g) ?? []).length > 2) return null;
  let currency: string | null = null;
  for (const [re, c] of CUR_MARK) if (re.test(t)) { currency = c; break; }
  if (!currency) return null;
  let period: PayPeriod | null = null;
  for (const [re, p] of PERIOD_MARK) if (re.test(t)) { period = p; break; }
  const amounts: number[] = [];
  const re = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kK])?\b/g;
  let m: RegExpExecArray | null;
  const kAll = /\d\s*[kK]\b/.test(t);
  while ((m = re.exec(t)) !== null) {
    // "2027", "30%" and similar are not pay amounts.
    const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (tail.startsWith('%')) continue;
    amounts.push(num(m[1]!, Boolean(m[2]) || kAll));
    if (amounts.length === 2) break;
  }
  if (amounts.length === 0) return null;
  const min = amounts[0]!;
  const max = amounts.length === 2 ? amounts[1]! : amounts[0]!;
  if (!(min > 0) || max < min) return null;
  if (!period) {
    if (max >= 10_000) period = 'year';
    else return null;
  }
  return makePay(min, max, currency, period, 'board_field');
}

export function makePay(min: number | null, max: number | null, currency: string, period: PayPeriod, source: 'board_field' | 'description'): Pay {
  return {
    min, max, currency: currency.toUpperCase(), period, source, ranges: 1,
    annualMin: period === 'year' ? min : annualize(min, period),
    annualMax: period === 'year' ? max : annualize(max, period),
  };
}

/** Pay parsed from a posting's free text (a range with a currency, conservative). */
export function payFromText(text: string): Pay | null {
  const p = parsePayFromText(text);
  if (!p) return null;
  return makePay(p.min, p.max, p.currency, p.period, 'description');
}

// ---------------------------------------------------------------------------------------------------------------
// Employment type

export function employmentTypeOf(text: string | null | undefined): EmploymentType | null {
  const t = (text ?? '').toLowerCase();
  if (!t) return null;
  if (/\bintern(ship)?\b|\bco-?op\b/.test(t)) return 'internship';
  if (/part[- _]?time/.test(t)) return 'part_time';
  if (/full[- _]?time/.test(t)) return 'full_time';
  if (/\bcontract|freelance|contractor/.test(t)) return 'contract';
  if (/temporary|seasonal|\btemp\b|intermittent/.test(t)) return 'temporary';
  return null;
}

/** RawJob.employmentType wants "" for unknown and "internship" etc. for known. */
export function rawEmploymentType(t: EmploymentType | null): string {
  return t ?? '';
}

/** Keeps at most `max` characters of evidence text. */
export function clip(s: string, max = 500): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 3) + '...';
}
