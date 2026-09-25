import type { PayPeriod } from './types.ts';

export interface ParsedPay {
  min: number | null;
  max: number | null;
  currency: string;
  period: PayPeriod;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD', 'us$': 'USD', 'usd': 'USD', 'c$': 'CAD', 'ca$': 'CAD', 'cad': 'CAD', 'a$': 'AUD', 'au$': 'AUD',
  'aud': 'AUD', '€': 'EUR', 'eur': 'EUR', '£': 'GBP', 'gbp': 'GBP', 'chf': 'CHF', 'sek': 'SEK', 'nzd': 'NZD',
  'nz$': 'NZD',
};

// One money amount: currency marker, number with commas or decimals, optional k suffix.
const CUR = '(?:(?:USD|CAD|AUD|NZD)\\s?\\$|US\\$|CA\\$|C\\$|AU\\$|A\\$|NZ\\$|USD|CAD|AUD|EUR|GBP|CHF|SEK|NZD|\\$|€|£)';
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const K = '(\\s?[kK]\\b)?';
// currency amount [k] (dash | to | and | through) [currency] amount [k]
// An optional period may sit between the two numbers: "$28/hour to $47/hour".
const MID_PERIOD = '(?:\\s*(?:\\/|per\\s+|an?\\s+)\\s*(?:hour|hr|year|yr|annum|month|week|day))?';
const RANGE_SRC = `(${CUR})\\s?${NUM}${K}${MID_PERIOD}\\s*(?:-|–|—|to|and|through)\\s*(${CUR})?\\s?${NUM}${K}`;

const PERIOD_AFTER: Array<[RegExp, PayPeriod]> = [
  [/^\s*(?:\/|per\s+|an?\s+|each\s+)\s*(?:hour|hr)\b|^\s*\/\s*h\b|^\s*hourly/i, 'hour'],
  [/^\s*(?:\/|per\s+|an?\s+)\s*(?:year|yr|annum)\b|^\s*(?:annual|yearly|annually|per annum)/i, 'year'],
  [/^\s*(?:\/|per\s+|an?\s+)\s*month\b|^\s*monthly/i, 'month'],
  [/^\s*(?:\/|per\s+|an?\s+)\s*week\b|^\s*weekly/i, 'week'],
  [/^\s*(?:\/|per\s+|an?\s+)\s*day\b|^\s*daily/i, 'day'],
];

// Text right after a number that shows it is not pay ("$10 to 15 million", "3 - 5 years").
const TAIL_REJECT =
  /^\s*(?:million|billion|thousand|mm\b|m\b|bn\b|%|percent|years?\b|yrs?\b|months?\b|users\b|customers\b|employees\b|people\b|seats\b)/i;

const PAY_CUE = /pay|salary|compensation|wage|hourly|rate|range|base|earn|offer/;
const HOURS_PER_YEAR = 2080;

export function annualize(v: number | null, period: PayPeriod): number | null {
  if (v === null) return null;
  switch (period) {
    case 'year': return v;
    case 'month': return Math.round(v * 12);
    case 'week': return Math.round(v * 52);
    case 'day': return Math.round(v * 260);
    case 'hour': return Math.round(v * HOURS_PER_YEAR);
  }
}

function plausible(min: number, max: number, period: PayPeriod): boolean {
  if (!(min > 0) || max < min) return false;
  // A range wider than 5x is almost never a pay range.
  if (max / min > 5) return false;
  switch (period) {
    case 'year': return min >= 12_000 && max <= 2_000_000;
    case 'month': return min >= 1_000 && max <= 200_000;
    case 'week': return min >= 250 && max <= 40_000;
    case 'day': return min >= 60 && max <= 8_000;
    case 'hour': return min >= 7 && max <= 700;
  }
}

function amount(raw: string, k: string | undefined): number {
  const n = parseFloat(raw.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

function currencyOf(marker: string | undefined): string | null {
  if (!marker) return null;
  const m = marker.toLowerCase().replace(/\s+/g, '');
  const direct = CURRENCY_SYMBOLS[m];
  if (direct) return direct;
  const letters = m.replace(/[^a-z]/g, ''); // "usd$" -> "usd"
  return letters.length === 3 ? (CURRENCY_SYMBOLS[letters] ?? null) : null;
}

/**
 * Parse the first plausible pay range from a description. Returns null when nothing is convincing.
 * Conservative on purpose: a wrong pay figure is worse than a missing one.
 * A period must be stated right after the range, or a pay cue word must sit just before it.
 */
export function parsePayFromText(text: string): ParsedPay | null {
  if (!text) return null;
  const re = new RegExp(RANGE_SRC, 'gi');
  const found: Array<{ pay: ParsedPay; cued: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cur1 = currencyOf(m[1]);
    const cur2 = currencyOf(m[4]);
    if (!cur1) continue;
    // A bare "$" on the second amount fits any dollar currency ("CAD $70,000 to $85,000").
    const bareDollar = (m[4] ?? '').trim() === '$' && ['USD', 'CAD', 'AUD', 'NZD'].includes(cur1);
    if (cur2 && cur2 !== cur1 && !bareDollar) continue;
    // "$150K - 200K": a k on either side applies to both.
    const k1 = m[3], k2 = m[6];
    const anyK = k1 || k2 ? '1' : undefined;
    const min = amount(m[2], anyK);
    const max = amount(m[5], anyK);
    if (min > max) continue;
    const end = m.index + m[0].length;
    const tail = text.slice(end, end + 40);
    if (TAIL_REJECT.test(tail)) continue;
    const before = text.slice(Math.max(0, m.index - 120), m.index).toLowerCase();
    const cued = PAY_CUE.test(before);
    let period: PayPeriod | null = null;
    let explicit = false;
    for (const [pr, p] of PERIOD_AFTER) if (pr.test(tail)) { period = p; explicit = true; break; }
    if (!period) {
      if (/hourly|per hour|an hour/.test(before) && !/annual|yearly/.test(before)) period = 'hour';
      else if (max >= 12_000) period = 'year';
      else if (max >= 7 && max <= 300) period = 'hour';
    }
    if (!period) continue;
    // Without an explicit period, require a pay cue word nearby. Bare "$20 to $30" is too risky.
    if (!explicit && !cued) continue;
    if (!plausible(min, max, period)) continue;
    found.push({ pay: { min, max, currency: cur1, period }, cued });
  }
  if (found.length === 0) return null;
  return (found.find((f) => f.cued) ?? found[0]).pay;
}
