// Client-side URL safety for every page the assistant reads or sends to a paid route (research 06, parts F.1 and F.2,
// and docs/INTERFACES.md section 10). The check runs BEFORE any request, on the first address and on every redirect.
//
// Refused: a scheme other than https (http only for the free direct read of a page the person pasted), a login in the
// address, a port other than the default one, any IP address written as a number in any form, this computer and the
// local network by name (localhost, single-label names, .local, .internal, .lan, .corp, .home.arpa), the never-crawl
// hosts (LinkedIn, Indeed, Glassdoor, SmartRecruiters, ZipRecruiter), the held-back families (Workday, iCIMS, Oracle,
// UKG, Taleo), login-walled social networks, search-result pages, and paths that point at a person's profile.
// The free reader also checks the address the name resolves to (see `safeGet` in fetchfree.ts).

import { isIP } from 'node:net';

export const MAX_URL_CHARS = 2048;

/** Hosts (and every subdomain) that jobleft never reads, free or paid. */
const BLOCKED: Array<{ re: RegExp; why: string }> = [
  { re: /(^|\.)(linkedin\.com|licdn\.com|lnkd\.in)$/i, why: 'LinkedIn does not allow it' },
  { re: /(^|\.)indeed\.[a-z.]+$/i, why: 'Indeed does not allow it' },
  { re: /(^|\.)glassdoor\.[a-z.]+$/i, why: 'Glassdoor does not allow it' },
  { re: /(^|\.)(smartrecruiters\.com|smrtr\.io)$/i, why: 'SmartRecruiters does not allow it' },
  { re: /(^|\.)ziprecruiter\.com$/i, why: 'ZipRecruiter does not allow it' },
  { re: /(^|\.)(facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com)$/i, why: 'that site needs a login' },
  { re: /(^|\.)(duckduckgo\.com|search\.yahoo\.com)$/i, why: 'search result pages are not read' },
  { re: /(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|oraclecloud\.com|taleo\.net|ultipro\.com|ukg\.com|ukg\.net)$/i, why: 'jobleft does not read that hiring system yet' },
];

const LOCAL_SUFFIX = /\.(local|localhost|internal|lan|corp|home|home\.arpa|intranet|private)$/i;

export type UrlCheck =
  | { ok: true; url: URL; host: string }
  | { ok: false; code: 'not_a_link' | 'scheme' | 'credentials' | 'port' | 'ip_address' | 'local_name' | 'blocked_host' | 'profile_page' | 'too_long'; message: string };

export interface UrlOptions {
  /** Allow plain http (the free read of a page the person pasted). Paid routes always need https. */
  allowHttp?: boolean;
}

/** True when the host is written as an IP address in any form (dotted, decimal, hex, octal, IPv6). */
export function looksLikeIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIP(h)) return true;
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  const parts = h.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) return true;
  if (h.includes(':')) return true;
  return false;
}

export function blockedReason(host: string): string | null {
  for (const b of BLOCKED) if (b.re.test(host)) return b.why;
  if (/(^|\.)google\.[a-z.]+$/i.test(host) || /(^|\.)bing\.com$/i.test(host)) return 'search result pages are not read';
  return null;
}

export function checkUrl(input: string, opts: UrlOptions = {}): UrlCheck {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, code: 'not_a_link', message: 'That is not a web link.' };
  if (input.length > MAX_URL_CHARS) return { ok: false, code: 'too_long', message: 'That link is too long.' };
  let url: URL;
  try { url = new URL(input.trim()); } catch { return { ok: false, code: 'not_a_link', message: 'That is not a web link.' }; }
  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'https' && !(scheme === 'http' && opts.allowHttp)) {
    return { ok: false, code: 'scheme', message: opts.allowHttp ? 'Only web links (http or https) can be read.' : 'Only secure web links (https) can be sent to the paid route.' };
  }
  if (url.username || url.password) return { ok: false, code: 'credentials', message: 'A link with a login inside it is not read.' };
  if (url.port && !((scheme === 'https' && url.port === '443') || (scheme === 'http' && url.port === '80'))) {
    return { ok: false, code: 'port', message: 'A link with a special port is not read.' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, code: 'not_a_link', message: 'That is not a web link.' };
  if (looksLikeIp(host)) return { ok: false, code: 'ip_address', message: 'A link that is an IP address is not read. That includes this computer and the local network.' };
  if (!host.includes('.') || LOCAL_SUFFIX.test(host)) return { ok: false, code: 'local_name', message: 'A link to this computer or the local network is not read.' };
  const why = blockedReason(host);
  if (why) return { ok: false, code: 'blocked_host', message: `jobleft does not read ${host}: ${why}.` };
  if (/^\/(in|pub|profile|people|talent)\//i.test(url.pathname)) return { ok: false, code: 'profile_page', message: 'jobleft does not read pages about a person.' };
  return { ok: true, url, host };
}

/** True for an address the free reader must never connect to (loopback, private, link-local, CGNAT, multicast, unspecified). */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').toLowerCase();
  const v = isIP(a);
  if (v === 4) return privateV4(a);
  if (v === 6) {
    if (a === '::1' || a === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return privateV4(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16); const lo = parseInt(mappedHex[2]!, 16);
      return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (/^f[cd]/.test(a)) return true; // fc00::/7
    if (/^fe[89ab]/.test(a)) return true; // fe80::/10
    if (/^ff/.test(a)) return true; // multicast
    return false;
  }
  return true; // not an address: refuse
}

function privateV4(a: string): boolean {
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [o1, o2] = p as [number, number, number, number];
  if (o1 === 0 || o1 === 10 || o1 === 127) return true;
  if (o1 === 169 && o2 === 254) return true;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
  if (o1 >= 224) return true;
  return false;
}
