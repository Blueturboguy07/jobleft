// Crawler configuration: the crawler identity (User-Agent) and every limit that keeps a crawl polite and bounded.
// The identity comes from this config and nowhere else: never from a profile, the environment, git or the OS user.

import { readFileSync } from 'node:fs';

/**
 * The crawler identity, fixed in code (docs/INTERFACES.md: USER_AGENT). It is never read from the environment, a
 * profile, git, a config file or a flag: a config or flag that names another identity is refused.
 */
export const DEFAULT_USER_AGENT = 'jobleft/0.1.1 (+https://github.com/Blueturboguy07/jobleft; no personal data)';

export interface CrawlerConfig {
  /** Sent on every request. Must name jobleft and its version; never a browser identity, never a personal address. */
  userAgent: string;
  /** A board that answered well is read again after this many hours (the regular refresh). */
  refreshHours: number;
  /**
   * A posting that went missing from its board closes when a second complete reading, at least this many hours after
   * the first miss, still does not list it. The scheduler re-checks such a board after this gap.
   */
  confirmHours: number;
  /** A posting last seen this long ago closes on a confirmed miss inside one run (after a long break). */
  graceHours: number;
  /** Inside a run, a board that stopped listing postings is read a second time no sooner than this. */
  confirmDelaySeconds: number;
  /** Whole-request deadline (headers and body). */
  requestTimeoutSeconds: number;
  /** Deadline for reading a robots.txt file. */
  robotsTimeoutSeconds: number;
  /** One reply may not be larger than this (after decompression). */
  maxBodyMB: number;
  /** A board that lists more postings than this is refused as a whole (nothing stored, nothing closed). */
  maxJobsPerBoard: number;
  /** Request budget of one run (robots.txt included). Boards left over wait for the next run. */
  maxRequestsPerRun: number;
  /** Boards of one host that may be in flight at once. Requests to a host still start at most once a second. */
  perHostConcurrency: number;
  /** Boards in flight at once over all hosts. */
  globalConcurrency: number;
  /** Seconds between two requests to one host. Never below 1. robots.txt Crawl-delay can make it longer. */
  minHostIntervalSeconds: number;
  /** A host that asks to wait (429/503 Retry-After) up to this long is waited for; longer, and its boards wait for a later run. */
  maxRetryAfterSeconds: number;
  /** One board may not take longer than this in total. */
  boardDeadlineSeconds: number;
  /** Retries of one request after a server error or a dropped connection (never after 4xx, never after a timeout). */
  retries: number;
  /** Ask Greenhouse for its pay ranges (pay_input_ranges) on the list request. */
  greenhousePayTransparency: boolean;
}

export const DEFAULT_CONFIG: Readonly<CrawlerConfig> = Object.freeze({
  userAgent: DEFAULT_USER_AGENT,
  refreshHours: 24,
  confirmHours: 2,
  graceHours: 48,
  confirmDelaySeconds: 20,
  requestTimeoutSeconds: 60,
  robotsTimeoutSeconds: 15,
  maxBodyMB: 64,
  maxJobsPerBoard: 10_000,
  maxRequestsPerRun: 5_000,
  perHostConcurrency: 3,
  globalConcurrency: 8,
  minHostIntervalSeconds: 1,
  maxRetryAfterSeconds: 120,
  boardDeadlineSeconds: 300,
  retries: 2,
  greenhousePayTransparency: true,
});

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

const BROWSER_WORDS = /\b(mozilla|chrome|chromium|safari|applewebkit|gecko|firefox|edg|edge|msie|trident|opera|opr|webkit|khtml)\b/i;
const FREE_MAIL = /@([a-z0-9-]+\.)*(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho|fastmail|hey|tutanota|qq|163|126)\.[a-z.]+/i;

/**
 * Checks a crawler identity. Returns it trimmed, or throws ConfigError with a plain reason.
 * Rules: printable ASCII, at most 200 characters; starts with "jobleft/<version>" (or "jobleft-<word>/<version>");
 * never a browser word (Mozilla, Chrome, Safari...); never a personal e-mail address.
 */
export function checkUserAgent(ua: string): string {
  const s = String(ua ?? '').trim();
  if (!s) throw new ConfigError('the crawler identity (userAgent) is empty');
  if (s.length > 200) throw new ConfigError('the crawler identity (userAgent) is longer than 200 characters');
  if (!/^[\x20-\x7e]+$/.test(s)) throw new ConfigError('the crawler identity (userAgent) may hold only printable ASCII characters');
  if (!/^jobleft(-[a-z0-9]+)*\/\d+(\.\d+)*(\s|$)/i.test(s)) {
    throw new ConfigError('the crawler identity (userAgent) must start with "jobleft/<version>", for example "jobleft/0.1 (contact: https://example.org/bot)"');
  }
  if (BROWSER_WORDS.test(s)) throw new ConfigError('the crawler identity (userAgent) may not name a web browser: jobleft never poses as a browser');
  if (FREE_MAIL.test(s)) throw new ConfigError('the crawler identity (userAgent) may not hold a personal e-mail address; use a project address');
  return s;
}

/** The robots.txt product token of an identity: the part before the first "/", lower case ("jobleft"). */
export function productTokenOf(ua: string): string {
  return ua.trim().split('/')[0]!.toLowerCase();
}

/** The identity is fixed: the only accepted value is DEFAULT_USER_AGENT itself. */
function fixedUserAgent(v: unknown): string {
  const s = String(v ?? '').trim();
  if (s !== DEFAULT_USER_AGENT) {
    throw new ConfigError(`the crawler identity is fixed in code ("${DEFAULT_USER_AGENT}") and cannot be changed`);
  }
  return s;
}

function num(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ConfigError(`${name} must be a number`);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

/**
 * Merges a partial config over the defaults and checks every value. Unknown keys are refused, so a typo is not
 * silently ignored.
 */
export function makeConfig(partial: Partial<Record<keyof CrawlerConfig, unknown>> = {}): CrawlerConfig {
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const k of Object.keys(partial)) if (!known.has(k)) throw new ConfigError(`unknown crawler setting "${k}"`);
  const m = { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)) } as Record<string, unknown>;
  return {
    userAgent: fixedUserAgent(m.userAgent),
    // Below one hour only for mock boards; the scheduler checks that (see Scheduler).
    refreshHours: num(m.refreshHours, 'refreshHours', 1 / 60, 24 * 30),
    confirmHours: num(m.confirmHours, 'confirmHours', 1 / 60, 72),
    graceHours: num(m.graceHours, 'graceHours', 1, 24 * 30),
    confirmDelaySeconds: num(m.confirmDelaySeconds, 'confirmDelaySeconds', 0, 3600),
    requestTimeoutSeconds: num(m.requestTimeoutSeconds, 'requestTimeoutSeconds', 1, 600),
    robotsTimeoutSeconds: num(m.robotsTimeoutSeconds, 'robotsTimeoutSeconds', 1, 120),
    maxBodyMB: num(m.maxBodyMB, 'maxBodyMB', 1, 512),
    maxJobsPerBoard: Math.floor(num(m.maxJobsPerBoard, 'maxJobsPerBoard', 1, 200_000)),
    maxRequestsPerRun: Math.floor(num(m.maxRequestsPerRun, 'maxRequestsPerRun', 1, 1_000_000)),
    perHostConcurrency: Math.floor(num(m.perHostConcurrency, 'perHostConcurrency', 1, 8)),
    globalConcurrency: Math.floor(num(m.globalConcurrency, 'globalConcurrency', 1, 64)),
    minHostIntervalSeconds: num(m.minHostIntervalSeconds, 'minHostIntervalSeconds', 1, 600),
    maxRetryAfterSeconds: num(m.maxRetryAfterSeconds, 'maxRetryAfterSeconds', 0, 3600),
    boardDeadlineSeconds: num(m.boardDeadlineSeconds, 'boardDeadlineSeconds', 5, 3600),
    retries: Math.floor(num(m.retries, 'retries', 0, 5)),
    greenhousePayTransparency: m.greenhousePayTransparency === true || m.greenhousePayTransparency === 'true',
  };
}

/** Reads a JSON config file (keys of CrawlerConfig) and merges it over the defaults. */
export function loadConfigFile(path: string, overrides: Partial<Record<keyof CrawlerConfig, unknown>> = {}): CrawlerConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    throw new ConfigError(`cannot read the crawler config ${path}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError(`the crawler config ${path} must be a JSON object`);
  return makeConfig({ ...(parsed as Record<string, unknown>), ...overrides } as Partial<Record<keyof CrawlerConfig, unknown>>);
}
