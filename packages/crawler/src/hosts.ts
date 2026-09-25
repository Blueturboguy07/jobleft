// Which hosts the crawler may contact. Pure string and address checks: nothing here sends a request.
//
//   never       LinkedIn, Indeed, Glassdoor, SmartRecruiters: no request ever, whatever the setting
//   held_back   Workday, iCIMS, Oracle Recruiting, UKG, Taleo: no request unless the owner turns that family on
//   private     this computer or the local network (except a loopback mock server named by a host map or a board origin)

import { isIP } from 'node:net';

export type ForbiddenKind = 'never' | 'held_back';
export interface ForbiddenHost { kind: ForbiddenKind; family: string; host: string }

const NEVER: Array<[RegExp, string]> = [
  [/(^|\.)(linkedin\.com|licdn\.com|lnkd\.in)$/i, 'LinkedIn'],
  [/(^|\.)indeed\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i, 'Indeed'],
  [/(^|\.)glassdoor\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i, 'Glassdoor'],
  [/(^|\.)(smartrecruiters\.com|smrtr\.io)$/i, 'SmartRecruiters'],
];

/** Families held back until the owner approves them. The key is the family id used by `allowHeldBack`. */
export const HELD_BACK_FAMILIES: Readonly<Record<string, { name: string; re: RegExp }>> = Object.freeze({
  workday: { name: 'Workday', re: /(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|workday\.com|workdayjobs\.com)$/i },
  icims: { name: 'iCIMS', re: /(^|\.)icims\.com$/i },
  oracle: { name: 'Oracle Recruiting', re: /(^|\.)(oraclecloud\.com|taleo\.net)$/i },
  ukg: { name: 'UKG', re: /(^|\.)(ultipro\.com|ukg\.com|ukg\.net|ultipro\.ca)$/i },
  taleo: { name: 'Taleo', re: /(^|\.)taleo\.net$/i },
});

function cleanHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

/** The rule that forbids a host, or null when the host may be contacted. `allowHeldBack` lists family ids the owner turned on. */
export function forbiddenHostOf(host: string, allowHeldBack: readonly string[] = []): ForbiddenHost | null {
  const h = cleanHost(host);
  for (const [re, family] of NEVER) if (re.test(h)) return { kind: 'never', family, host: h };
  for (const [id, fam] of Object.entries(HELD_BACK_FAMILIES)) {
    if (fam.re.test(h) && !allowHeldBack.includes(id)) return { kind: 'held_back', family: fam.name, host: h };
  }
  return null;
}

/** A plain sentence for a forbidden host. */
export function forbiddenReason(f: ForbiddenHost): string {
  return f.kind === 'never'
    ? `${f.host} is a ${f.family} site; jobleft never contacts ${f.family}`
    : `${f.host} is a ${f.family} site; ${f.family} sources are off until the owner turns them on`;
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, p) => (a << 8) + (Number(p) & 255), 0) >>> 0;
}
function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast, unspecified and similar addresses. */
export function isPrivateAddress(address: string): boolean {
  const a = cleanHost(address);
  const kind = isIP(a);
  if (kind === 4) {
    return [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]
      .some(([b, n]) => inV4(a, b as string, n as number));
  }
  if (kind === 6) {
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return false;
}

/** Host names that always mean this computer or the local network. */
export function isLocalName(host: string): boolean {
  const h = cleanHost(host);
  return h === 'localhost' || /\.(localhost|local|internal|lan|home|intranet|corp)$/i.test(h) || !h.includes('.');
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

/** A loopback http(s) origin (a mock server on this computer), normalised; null when it is not one. */
export function loopbackOrigin(target: string): string | null {
  let u: URL;
  try { u = new URL(target); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!LOOPBACK_HOST.test(u.hostname)) return null;
  return u.origin;
}
