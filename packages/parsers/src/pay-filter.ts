// The pay rule that filters and sorts use, so they agree with the cards (parsers O12). One rule, stated in words.
import type { Pay } from '@jobleft/contracts';
import { annualize } from './pay.ts';

/** The rule in plain words, for the filter's help text. */
export const PAY_FILTER_RULE =
  'A job passes a minimum-pay filter when the top of its stated range (or its only figure) is at least the minimum, ' +
  'counted per year: hourly pay x 2,080 hours, daily x 260 days, weekly x 52 weeks, monthly x 12 months. ' +
  'Only pay in the filter\'s currency is compared; other currencies count as unknown. ' +
  'Jobs with unknown pay are hidden unless "include jobs with unknown pay" is on.';

/** Yearly figures of a pay (converted when it is not yearly), or null. */
export function yearlyPay(pay: Pay | null): { min: number | null; max: number | null; converted: boolean } | null {
  if (!pay) return null;
  return { min: pay.annualMin ?? annualize(pay.min, pay.period), max: pay.annualMax ?? annualize(pay.max, pay.period), converted: pay.period !== 'year' };
}

/**
 * true = passes, false = fails, null = unknown (no pay, or pay in another currency).
 * The filter checks the top of the range, or the only figure given ("from $20/hour" checks $20).
 */
export function payMeetsMinimum(pay: Pay | null, minYearly: number, currency = 'USD'): boolean | null {
  if (!pay || pay.currency !== currency) return null;
  const y = yearlyPay(pay);
  const top = y?.max ?? y?.min ?? null;
  if (top === null) return null;
  return top >= minYearly;
}

/** The key "sort by pay" uses: the yearly top of the range in the given currency, or null (sorted last). */
export function paySortKey(pay: Pay | null, currency = 'USD'): number | null {
  if (!pay || pay.currency !== currency) return null;
  const y = yearlyPay(pay);
  return y?.max ?? y?.min ?? null;
}

/** Short card text: "$25/hr - $32/hr", "Up to $150K/yr", "From $20/hr", "$85K/yr". Never "$0" and never "$ - $". */
export function formatPay(pay: Pay | null): string | null {
  if (!pay || (pay.min === null && pay.max === null)) return null;
  const sym: Record<string, string> = { USD: '$', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', MXN: 'MX$', BRL: 'R$', SGD: 'S$', HKD: 'HK$', CHF: 'CHF ' };
  const s = sym[pay.currency] ?? `${pay.currency} `;
  const unit: Record<Pay['period'], string> = { hour: '/hr', day: '/day', week: '/wk', month: '/mo', year: '/yr' };
  const fmt = (v: number) => {
    if (pay.period === 'year' && v >= 1000) { const k = v / 1000; return `${s}${Number.isInteger(k) ? k : k.toFixed(1)}K`; }
    return `${s}${v % 1 === 0 ? v.toLocaleString('en-US') : v.toFixed(2)}`;
  };
  const u = unit[pay.period];
  if (pay.min !== null && pay.max !== null) return pay.min === pay.max ? `${fmt(pay.min)}${u}` : `${fmt(pay.min)}${u} - ${fmt(pay.max)}${u}`;
  if (pay.max !== null) return `Up to ${fmt(pay.max)}${u}`;
  return `From ${fmt(pay.min!)}${u}`;
}
