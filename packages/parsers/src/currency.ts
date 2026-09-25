// Currencies: markers in text, the currency a country uses, and a rough scale for plausibility checks only.
// The scale is never used to convert or to show a figure.

/** Rough units per US dollar, used only to judge whether an amount can be pay. */
export const CURRENCY_SCALE: Record<string, number> = {
  USD: 1, CAD: 1.35, AUD: 1.5, NZD: 1.65, SGD: 1.35, HKD: 7.8, EUR: 0.92, GBP: 0.79, CHF: 0.88, SEK: 10.5,
  NOK: 10.6, DKK: 6.9, PLN: 4, CZK: 23, HUF: 360, RON: 4.6, BGN: 1.8, JPY: 150, CNY: 7.2, KRW: 1350, INR: 83,
  BRL: 5.2, MXN: 18, ARS: 900, CLP: 930, COP: 4000, PEN: 3.8, UYU: 40, ZAR: 18, ILS: 3.7, AED: 3.67, SAR: 3.75,
  QAR: 3.64, TRY: 32, PHP: 56, THB: 35, IDR: 16000, MYR: 4.7, VND: 25000, UAH: 41, NGN: 1500, KES: 130, EGP: 48,
  PKR: 280, BDT: 110, LKR: 300, TWD: 32, GEL: 2.7, KZT: 470, MAD: 10, RSD: 108, ISK: 138,
};

/** Currency of each country (ISO alpha-2), for a bare "$" or a figure with no marker. */
export const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD', PR: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', GB: 'GBP', IE: 'EUR', DE: 'EUR',
  FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR',
  SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', HR: 'EUR', CY: 'EUR', MT: 'EUR', CH: 'CHF', SE: 'SEK',
  NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', JP: 'JPY', CN: 'CNY', KR: 'KRW',
  IN: 'INR', BR: 'BRL', MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', UY: 'UYU', ZA: 'ZAR', IL: 'ILS',
  AE: 'AED', SA: 'SAR', QA: 'QAR', TR: 'TRY', PH: 'PHP', TH: 'THB', ID: 'IDR', MY: 'MYR', VN: 'VND', UA: 'UAH',
  NG: 'NGN', KE: 'KES', EG: 'EGP', PK: 'PKR', BD: 'BDT', LK: 'LKR', TW: 'TWD', GE: 'GEL', KZ: 'KZT', MA: 'MAD',
  RS: 'RSD', IS: 'ISK',
};

/** Dollar-sign currencies: a bare "$" in a job placed in one of these countries is that country's currency. */
export const DOLLAR_SIGN_COUNTRY: Record<string, string> = {
  US: 'USD', PR: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', MX: 'MXN', AR: 'ARS', CL: 'CLP',
  CO: 'COP', UY: 'UYU', TW: 'TWD',
};

// Marker text (lower case, no spaces) to currency. "$" alone is resolved by the job's country (default USD).
const MARKERS: Record<string, string> = {
  'us$': 'USD', 'u.s.$': 'USD', 'usd': 'USD', 'usd$': 'USD', '$usd': 'USD', 'dollars': 'USD', 'dollar': 'USD',
  'c$': 'CAD', 'ca$': 'CAD', 'cad': 'CAD', 'cad$': 'CAD', 'can$': 'CAD',
  'a$': 'AUD', 'au$': 'AUD', 'aud': 'AUD', 'aud$': 'AUD', 'nz$': 'NZD', 'nzd': 'NZD', 'nzd$': 'NZD',
  's$': 'SGD', 'sgd': 'SGD', 'sgd$': 'SGD', 'hk$': 'HKD', 'hkd': 'HKD', 'hkd$': 'HKD',
  'r$': 'BRL', 'brl': 'BRL', 'reais': 'BRL', 'mx$': 'MXN', 'mxn': 'MXN', 'mxn$': 'MXN', 'pesos': 'MXN',
  '€': 'EUR', 'eur': 'EUR', 'euro': 'EUR', 'euros': 'EUR', '£': 'GBP', 'gbp': 'GBP', 'pounds': 'GBP',
  '¥': 'JPY', 'jpy': 'JPY', '円': 'JPY', '万円': 'JPY', 'cny': 'CNY', 'rmb': 'CNY', '元': 'CNY', '₹': 'INR', 'inr': 'INR',
  'rs': 'INR', 'rs.': 'INR', 'rupees': 'INR', 'chf': 'CHF', 'fr.': 'CHF', 'sek': 'SEK', 'nok': 'NOK', 'dkk': 'DKK',
  'kr': 'SEK', 'kr.': 'DKK', 'pln': 'PLN', 'zł': 'PLN', 'zl': 'PLN', '₩': 'KRW', 'krw': 'KRW', '원': 'KRW',
  '₪': 'ILS', 'ils': 'ILS', 'nis': 'ILS', 'aed': 'AED', 'sar': 'SAR', 'qar': 'QAR', 'zar': 'ZAR', 'try': 'TRY', '₺': 'TRY',
  'php': 'PHP', '₱': 'PHP', 'thb': 'THB', '฿': 'THB', 'idr': 'IDR', 'rp': 'IDR', 'rp.': 'IDR', 'myr': 'MYR', 'rm': 'MYR',
  'vnd': 'VND', '₫': 'VND', 'cop': 'COP', 'ars': 'ARS', 'clp': 'CLP', 'pen': 'PEN', 's/': 'PEN', 's/.': 'PEN',
  'czk': 'CZK', 'kč': 'CZK', 'huf': 'HUF', 'ft': 'HUF', 'ron': 'RON', 'lei': 'RON', 'bgn': 'BGN', 'uah': 'UAH',
  '₴': 'UAH', 'ngn': 'NGN', '₦': 'NGN', 'kes': 'KES', 'egp': 'EGP', 'pkr': 'PKR', 'twd': 'TWD', 'nt$': 'TWD',
  'gel': 'GEL', '₾': 'GEL', 'kzt': 'KZT', 'mad': 'MAD', 'rsd': 'RSD', 'isk': 'ISK', 'uyu': 'UYU',
};

/**
 * Currency marker before a number (the text must END with it). Longest forms first.
 * Plain "$" is returned as "$" so the caller can resolve it by country.
 */
export const CUR_PRE = new RegExp(
  // Letter codes need a non-letter before them ("USD 5"); symbols may follow a word ("from$300,000").
  '(?:(?:^|[^A-Za-z])(?=[A-Z])|(?=[^A-Za-z]))(' + [
    'US\\s?\\$', 'U\\.S\\.\\s?\\$', 'USD\\s?\\$?', '\\$\\s?USD', 'CA\\$', 'CAN\\$', 'C\\$', 'CAD\\s?\\$?', 'AU\\$', 'A\\$', 'AUD\\s?\\$?',
    'NZ\\$', 'NZD\\s?\\$?', 'S\\$', 'SGD\\s?\\$?', 'HK\\$', 'HKD\\s?\\$?', 'R\\$', 'BRL', 'MX\\$', 'MXN\\s?\\$?', 'NT\\$',
    '\\$', '€', 'EUR', '£', 'GBP', '¥', 'JPY', 'CNY', 'RMB', '₹', 'INR', 'Rs\\.?', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN',
    '₩', 'KRW', '₪', 'ILS', 'NIS', 'AED', 'SAR', 'QAR', 'ZAR', 'TRY', '₺', 'PHP', '₱', 'THB', '฿', 'IDR', 'Rp\\.?', 'MYR', 'RM',
    'VND', 'COP', 'ARS', 'CLP', 'PEN', 'S\\/\\.?', 'CZK', 'HUF', 'RON', 'BGN', 'UAH', '₴', 'NGN', '₦', 'KES', 'EGP',
    'PKR', 'TWD', 'GEL', '₾', 'KZT', 'MAD', 'RSD', 'ISK', 'UYU',
  ].join('|') + ')\\s?$',
);

/** Currency marker after a number (the text must START with it). Codes are upper case only ("5 ft" is not HUF). */
const CUR_SUF_CODES = new RegExp(
  '^\\s?(' + [
    'USD', 'US\\$', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'EUR', '€', 'GBP', '£', 'CHF', 'SEK', 'NOK', 'DKK', 'kr\\.?',
    'PLN', 'zł', 'INR', 'JPY', '万円', '円', '¥', 'CNY', 'RMB', '元', 'KRW', '원', 'BRL', 'MXN', 'ARS', 'COP', 'CLP', 'PEN', 'ILS',
    '₪', 'NIS', 'AED', 'SAR', 'QAR', 'ZAR', 'TRY', '₺', 'PHP', 'THB', 'IDR', 'MYR', 'VND', '₫', 'CZK', 'Kč', 'HUF', 'Ft',
    'RON', 'lei', 'BGN', 'UAH', '₴', 'грн', 'NGN', 'KES', 'EGP', 'PKR', 'TWD', 'GEL', '₾', 'KZT', 'MAD', 'RSD', 'ISK', 'UYU',
  ].join('|') + ')(?![A-Za-z])',
);
const CUR_SUF_WORDS = /^\s?(dollars?|d[oó]lares|euros?|pounds?(?:\s+sterling)?|pesos(?:\s+mexicanos)?|reais|rupees)(?![A-Za-z])/i;

export const CUR_SUF = {
  exec(s: string): RegExpExecArray | null { return CUR_SUF_CODES.exec(s) ?? CUR_SUF_WORDS.exec(s); },
};

/**
 * Resolves a marker to an ISO 4217 code. A bare "$" (or "dollars") becomes the dollar currency of the job's
 * country when that country uses one, else USD.
 */
export function currencyOfMarker(marker: string, country: string | null | undefined): string | null {
  const m = marker.toLowerCase().replace(/\s+/g, '');
  if (m === '$' || m === 'dollars' || m === 'dollar' || m === 'dólares' || m === 'dolares') {
    return (country && DOLLAR_SIGN_COUNTRY[country]) || 'USD';
  }
  if (m === 'pesos') return (country && ['AR', 'CL', 'CO', 'UY', 'PH'].includes(country) ? COUNTRY_CURRENCY[country] : 'MXN');
  if (m === 'kr' || m === 'kr.') return (country && ['SE', 'NO', 'DK', 'IS'].includes(country) ? COUNTRY_CURRENCY[country] : m === 'kr' ? 'SEK' : 'DKK');
  if (m === 'pound' || m === 'poundssterling') return 'GBP';
  if (m === 'euro') return 'EUR';
  const direct = MARKERS[m];
  if (direct) return direct;
  const letters = m.replace(/[^a-z]/g, '');
  if (letters.length === 3 && MARKERS[letters]) return MARKERS[letters];
  return null;
}
