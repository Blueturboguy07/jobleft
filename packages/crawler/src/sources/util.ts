import type { PayPeriod, RawPay, WorkMode } from '../types.ts';

export function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
export function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
export function obj(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }

/** freehire `isRemote`: the location text says remote. */
export function isRemote(location: string): boolean { return /remote/i.test(location); }

/** freehire `workplaceTypeMode`. Unknown gives "". */
export function workplaceTypeMode(t: string): WorkMode {
  switch (t.toLowerCase().trim()) {
    case 'remote': return 'remote';
    case 'hybrid': return 'hybrid';
    case 'on-site': case 'onsite': case 'on site': case 'office': return 'onsite';
    default: return '';
  }
}

export function workModeFromRemote(remote: boolean): WorkMode { return remote ? 'remote' : ''; }

/** freehire `roundSalaryPart`: round; a non-positive value means "not set". */
export function roundSalaryPart(v: number | null): number | null {
  if (v === null || !(v > 0)) return null;
  return Math.round(v);
}

/** freehire employment-type mapping by keyword containment (Lever, Greenhouse metadata). */
export function employmentTypeFromText(v: string): string {
  const c = v.toLowerCase();
  if (c.includes('intern')) return 'internship';
  if (c.includes('part-time') || c.includes('part time')) return 'part_time';
  if (c.includes('full-time') || c.includes('full time')) return 'full_time';
  if (c.includes('contract') || c.includes('temporary') || c.includes('seasonal')) return 'contract';
  return '';
}

export function makePay(min: number | null, max: number | null, currency: string, period: PayPeriod | ''): RawPay | null {
  if (!period) return null;
  const a = roundSalaryPart(min), b = roundSalaryPart(max);
  if (a === null && b === null) return null;
  return { min: a, max: b, currency: currency.toUpperCase(), period };
}

const A3: Record<string, string> = {
  USA: 'US', GBR: 'GB', CAN: 'CA', AUS: 'AU', DEU: 'DE', FRA: 'FR', ESP: 'ES', ITA: 'IT', NLD: 'NL', IND: 'IN',
  IRL: 'IE', BRA: 'BR', MEX: 'MX', JPN: 'JP', SGP: 'SG', ISR: 'IL', POL: 'PL', PRT: 'PT', SWE: 'SE', NOR: 'NO',
  DNK: 'DK', FIN: 'FI', CHE: 'CH', AUT: 'AT', BEL: 'BE', NZL: 'NZ', ZAF: 'ZA', ARE: 'AE', CHN: 'CN', KOR: 'KR',
  PHL: 'PH', ARG: 'AR', COL: 'CO', CHL: 'CL', ROU: 'RO', UKR: 'UA', TUR: 'TR', NGA: 'NG', KEN: 'KE', EGY: 'EG',
};
const NAMES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'united kingdom': 'GB', 'uk': 'GB',
  'canada': 'CA', 'australia': 'AU', 'germany': 'DE', 'france': 'FR', 'spain': 'ES', 'italy': 'IT',
  'netherlands': 'NL', 'india': 'IN', 'ireland': 'IE', 'brazil': 'BR', 'mexico': 'MX', 'japan': 'JP',
  'singapore': 'SG', 'israel': 'IL', 'poland': 'PL', 'portugal': 'PT', 'sweden': 'SE', 'norway': 'NO',
  'denmark': 'DK', 'finland': 'FI', 'switzerland': 'CH', 'austria': 'AT', 'belgium': 'BE', 'new zealand': 'NZ',
};

/** freehire `countryFromCode`: alpha-2, alpha-3 or a name to alpha-2. Empty when unresolved. */
export function countryFromCode(code: string): string[] {
  const c = code.trim();
  if (!c) return [];
  if (/^[A-Za-z]{2}$/.test(c)) return [c.toUpperCase()];
  const a3 = A3[c.toUpperCase()];
  if (a3) return [a3];
  const n = NAMES[c.toLowerCase()];
  return n ? [n] : [];
}

/** Date to ISO, or null. Future dates beyond 48h are dropped (freehire NotFuture). */
export function isoDate(v: unknown, now = Date.now()): string | null {
  let t: number;
  if (typeof v === 'number') t = v;
  else if (typeof v === 'string' && v.trim()) t = Date.parse(v);
  else return null;
  if (!Number.isFinite(t) || t <= 0) return null;
  if (t > now + 48 * 3600 * 1000) return null;
  return new Date(t).toISOString();
}
