// Pay written in European number style inside a description: "€45.000 – €55.000 brutto jährlich",
// "45.000 € bis 55.000 €", "CHF 85'000 - 95'000 pro Jahr", "€2.500,50 - €3.100 monatlich".
// The crawler's text reader knows only the English style (commas for thousands), so it reads "45.000" as 45 and then
// invents an hourly rate. This reader handles the European style; it only answers when at least one amount is written
// that way, and it leaves every English-style range to the crawler. Conservative on purpose: a range needs a currency
// mark, and a period either stated next to it or implied by a pay word nearby and the size of the amount.

import type { RawPay, PayPeriod } from '@jobleft/crawler';

const CUR = '(?:€|EUR|Euro|£|GBP|CHF|SEK|NOK|DKK|PLN|USD|\\$)';
// 45.000 | 45'000 | 45’000 | 1.234.567 | 2.500,50 | 45000,5 | 2500,50 : at least one dot/apostrophe group or a decimal comma.
const EU_NUM = '(?:\\d{1,3}(?:[.\'’]\\d{3})+(?:,\\d{1,2})?|\\d+,\\d{1,2})';
const ANY_NUM = `(?:${EU_NUM}|\\d+)`;
const DASH = '(?:-|–|—|bis|to|und|and)';
// A number never starts inside another number and never stops before a "," or "." that a digit follows ("45,000" is
// English style: it is not read here).
const NUM_START = "(?<![\\d.,'’])";
const NUM_END = '(?![\\d]|[.,]\\d)';
// [currency] amount [currency] dash [currency] amount [currency]
const RANGE = new RegExp(
  `(${CUR})?\\s?${NUM_START}(${ANY_NUM})${NUM_END}\\s?(${CUR})?\\s*${DASH}\\s*(${CUR})?\\s?${NUM_START}(${ANY_NUM})${NUM_END}\\s?(${CUR})?`, 'gi');

const PERIODS: Array<[RegExp, PayPeriod]> = [
  [/^[\s,;.(]*(?:brutto\s+|netto\s+|gross\s+)?(?:j[aä]hrlich|pro\s+jahr|im\s+jahr|p\.\s?a\.|per\s+(?:year|annum)|a\s+year|annually|yearly|\/\s?(?:jahr|year|yr|an)\b|par\s+an|per\s+anno|al\s+anno)/i, 'year'],
  [/^[\s,;.(]*(?:brutto\s+|netto\s+|gross\s+)?(?:monatlich|pro\s+monat|im\s+monat|per\s+month|a\s+month|monthly|\/\s?(?:monat|month|mo)\b|par\s+mois|al\s+mese)/i, 'month'],
  [/^[\s,;.(]*(?:brutto\s+|netto\s+|gross\s+)?(?:w[oö]chentlich|pro\s+woche|per\s+week|weekly|\/\s?(?:woche|week)\b)/i, 'week'],
  [/^[\s,;.(]*(?:brutto\s+|netto\s+|gross\s+)?(?:t[aä]glich|pro\s+tag|per\s+day|daily|\/\s?(?:tag|day)\b)/i, 'day'],
  [/^[\s,;.(]*(?:brutto\s+|netto\s+|gross\s+)?(?:st[uü]ndlich|pro\s+stunde|je\s+stunde|die\s+stunde|per\s+hour|an\s+hour|hourly|\/\s?(?:h|std|stunde|hour|hr)\b|par\s+heure|l'ora)/i, 'hour'],
];
const PAY_CUE = /gehalt|verg[uü]tung|salary|compensation|verdienst|lohn|pay|brutto|gross|bruttogehalt|jahresgehalt|salaire|stipendio|wage|rate|range|bandbreite|spanne/i;
const NOT_PAY_TAIL = /^\s*(?:mio|million|millionen|mrd|milliarden|billion|%|prozent|percent|jahre|years?|mitarbeiter|employees|kunden|customers|nutzer|users|m\b|mm\b|bn\b)/i;

const CURRENCY_CODE: Record<string, string> = {
  '€': 'EUR', eur: 'EUR', euro: 'EUR', '£': 'GBP', gbp: 'GBP', chf: 'CHF', sek: 'SEK', nok: 'NOK', dkk: 'DKK', pln: 'PLN', usd: 'USD', $: 'USD',
};

function isEuStyle(raw: string): boolean {
  return /[.'’]\d{3}(?!\d)/.test(raw) || /,\d{1,2}$/.test(raw);
}

function euNumber(raw: string): number {
  // Dots and apostrophes separate thousands; the comma is the decimal mark.
  return parseFloat(raw.replace(/[.'’]/g, '').replace(',', '.'));
}

function plausible(min: number, max: number, period: PayPeriod): boolean {
  if (!(min > 0) || max < min || max / min > 5) return false;
  switch (period) {
    case 'year': return min >= 12_000 && max <= 2_000_000;
    case 'month': return min >= 1_000 && max <= 200_000;
    case 'week': return min >= 250 && max <= 40_000;
    case 'day': return min >= 60 && max <= 8_000;
    case 'hour': return min >= 7 && max <= 700;
  }
}

/**
 * The first pay range written in European number style, or null. Ranges written in English style are not read here
 * (the crawler reads them). Never invents a period: with none stated, the amount and a nearby pay word must agree.
 */
export function parseEuropeanPay(text: string): RawPay | null {
  if (!text) return null;
  const re = new RegExp(RANGE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [whole, c1, a1, c2, c3, a2, c4] = m;
    if (!isEuStyle(a1) && !isEuStyle(a2)) continue;
    // Amounts of both sides must be numbers in the same style, or plain whole numbers (45.000 - 55000).
    const cur = (c1 ?? c2 ?? c3 ?? c4 ?? '').toLowerCase();
    if (!cur) continue; // a range with no currency mark is not read
    const code = CURRENCY_CODE[cur];
    if (!code) continue;
    const other = [c1, c2, c3, c4].filter(Boolean).map((c) => (c as string).toLowerCase());
    if (other.some((c) => CURRENCY_CODE[c] !== code)) continue;
    const min = a1.includes(',') || /[.'’]\d{3}/.test(a1) ? euNumber(a1) : parseFloat(a1);
    const max = a2.includes(',') || /[.'’]\d{3}/.test(a2) ? euNumber(a2) : parseFloat(a2);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const end = m.index + whole.length;
    const tail = text.slice(end, end + 60);
    if (NOT_PAY_TAIL.test(tail)) continue;
    let period: PayPeriod | null = null;
    for (const [pr, p] of PERIODS) if (pr.test(tail)) { period = p; break; }
    if (!period) {
      const before = text.slice(Math.max(0, m.index - 120), m.index);
      if (!PAY_CUE.test(before)) continue;
      if (max >= 12_000) period = 'year';
      else continue; // a small amount with no stated period could be a month, a day or an hour: not read
    }
    if (!plausible(min, max, period)) continue;
    return { min, max, currency: code, period };
  }
  return null;
}
