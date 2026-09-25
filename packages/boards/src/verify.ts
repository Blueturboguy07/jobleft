// Checks one board against its provider: does it exist, how many open jobs does it list, and what employer name
// does the board itself report. The job count comes from the same request the crawler makes (the adapter's own
// fetchBoard), so a paste and a refresh never disagree. The name comes from the board's own answer:
//   Greenhouse: company_name on each job, else GET /v1/boards/{token} -> { name }
//   Lever and Ashby: the API has no name; the board's public page title ("Acme", "Acme Jobs")
//   Workable: the widget answer's "name"; Recruitee: company_name on each offer
// A name request that fails never fails the check; the caller falls back to the directory, never to a guess.

import type { CrawlAtsId } from '@jobleft/contracts';
import {
  BlockedError, DeniedHostError, HostTrippedError, HttpError, NotFoundError, RobotsError, arr, obj, str,
} from '@jobleft/crawler';
import type { HttpClient, HttpGetter, SourceRegistry } from '@jobleft/crawler';
import { ForbiddenHostError, HostBusyError, OfflineError, networkCode } from './http.ts';
import { boardPageUrl } from './detect.ts';

export type CheckFailure = 'not_found' | 'blocked' | 'robots' | 'forbidden' | 'offline' | 'timeout' | 'network' | 'server' | 'bad_reply' | 'busy' | 'no_adapter';

export type VerifyResult =
  | { ok: true; openJobs: number; name: string | null; nameFrom: 'board' | 'page' | null }
  | { ok: false; failure: CheckFailure; status: number | null; message: string };

/** Classifies an error from the polite client into a plain failure. */
export function classifyError(e: unknown): { failure: CheckFailure; status: number | null; message: string } {
  if (e instanceof OfflineError) return { failure: 'offline', status: null, message: 'jobleft is offline (no request was sent).' };
  if (e instanceof ForbiddenHostError) return { failure: 'forbidden', status: null, message: `${e.provider} is not supported; nothing was sent to it.` };
  if (e instanceof DeniedHostError) return { failure: 'forbidden', status: null, message: 'The host is on the never-crawl list; nothing was sent to it.' };
  if (e instanceof HostBusyError) return { failure: 'busy', status: 429, message: `The host asked jobleft to wait until ${new Date(e.until).toISOString()}.` };
  if (e instanceof NotFoundError) return { failure: 'not_found', status: e.status, message: `The board answered "not found" (HTTP ${e.status}).` };
  if (e instanceof BlockedError) {
    return e.status === 429
      ? { failure: 'blocked', status: 429, message: 'The host asked jobleft to slow down (HTTP 429).' }
      : { failure: 'blocked', status: e.status, message: `The host refused the request (HTTP ${e.status}).` };
  }
  if (e instanceof HostTrippedError) return { failure: 'blocked', status: null, message: 'The host refused jobleft twice in a row; jobleft stopped asking it for this run.' };
  if (e instanceof RobotsError) return { failure: 'robots', status: null, message: "The host's robots.txt does not allow jobleft to read this address." };
  if (e instanceof HttpError) {
    if (e.status >= 500) return { failure: 'server', status: e.status, message: `The host's server failed (HTTP ${e.status}).` };
    if (e.status >= 300 && e.status < 400) return { failure: 'bad_reply', status: e.status, message: `The host answered with a redirect (HTTP ${e.status}) instead of the board.` };
    if (/invalid JSON/i.test(e.message)) return { failure: 'bad_reply', status: e.status, message: 'The host sent a reply that is not job data.' };
    if (/too large/i.test(e.message)) return { failure: 'bad_reply', status: e.status, message: 'The reply was too large to read.' };
    return { failure: 'server', status: e.status, message: `The host answered HTTP ${e.status}.` };
  }
  const code = networkCode(e);
  if (code === 'TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return { failure: 'timeout', status: null, message: 'The host did not answer in time.' };
  }
  if (code === 'ENETUNREACH' || code === 'ENETDOWN' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH') {
    return { failure: 'offline', status: null, message: 'jobleft could not reach the network.' };
  }
  if (code === 'ENOTFOUND') return { failure: 'network', status: null, message: 'The site name does not exist (DNS lookup failed), or the network is off.' };
  if (code === 'ECONNREFUSED') return { failure: 'network', status: null, message: 'The site refused the connection.' };
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return { failure: 'network', status: null, message: 'The connection broke before the reply was complete.' };
  return { failure: 'network', status: null, message: 'The request failed before any reply.' };
}

function cleanName(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120) return null;
  if (/^(jobs|careers|job board|ashby|lever|greenhouse|workable|recruitee|personio|not found|page not found|error)$/i.test(t)) return null;
  return t;
}

function titleOf(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1]!.replace(/\s+/g, ' ').trim() : null;
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
}

/** The name the board's own public page reports (Lever, Ashby), or null. */
async function nameFromPage(ats: CrawlAtsId, board: string, region: string | null, http: HttpClient): Promise<string | null> {
  if (ats !== 'lever' && ats !== 'ashby' && ats !== 'greenhouse') return null;
  if (ats === 'greenhouse') {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}`;
    try { return cleanName(str(obj(await http.getJson(url)).name)); } catch { return null; }
  }
  try {
    const html = await http.getText(boardPageUrl(ats, board, region), 'text/html');
    let t = titleOf(html);
    if (t && ats === 'ashby') t = t.replace(/\s+jobs$/i, '');
    if (t && ats === 'lever') t = t.replace(/\s+jobs$/i, '');
    return cleanName(t);
  } catch { return null; }
}

/** The name inside the board's own job-list answer, when the provider puts one there. */
function nameFromListing(ats: CrawlAtsId, raw: unknown): string | null {
  if (ats === 'greenhouse') {
    for (const j of arr(obj(raw).jobs)) { const n = cleanName(str(obj(j).company_name)); if (n) return n; }
  } else if (ats === 'workable') {
    return cleanName(str(obj(raw).name));
  } else if (ats === 'recruitee') {
    for (const o of arr(obj(raw).offers)) { const n = cleanName(str(obj(o).company_name)); if (n) return n; }
  }
  return null;
}

export interface VerifyOptions {
  /** Ask the board's page for its name when the listing has none (set false when the directory has the name). */
  wantName?: boolean;
  /** Give up on the name after this long (the check itself is not cut short). */
  nameDeadlineMs?: number;
}

/** One check of one board: exists, open jobs, reported name. */
export async function verifyBoard(
  ats: CrawlAtsId, board: string, region: string | null, http: HttpClient, sources: SourceRegistry, opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const source = sources[ats];
  if (!source) return { ok: false, failure: 'no_adapter', status: null, message: `jobleft cannot read ${ats} boards yet.` };
  let raw: unknown = null;
  const spy: HttpGetter = { getJson: async (u: string) => (raw = await http.getJson(u)) };
  let jobs;
  try {
    jobs = await source.fetchBoard({ ats, board, company: board, ...(region ? { region } : {}) }, spy);
  } catch (e) {
    const c = classifyError(e);
    return { ok: false, ...c };
  }
  const openJobs = jobs.filter((j) => !j.unreadable).length;
  let name = nameFromListing(ats, raw);
  let nameFrom: 'board' | 'page' | null = name ? 'board' : null;
  if (!name && (opts.wantName ?? true)) {
    name = await withDeadline(nameFromPage(ats, board, region, http), opts.nameDeadlineMs ?? 8000);
    if (name) nameFrom = ats === 'greenhouse' ? 'board' : 'page';
  }
  return { ok: true, openJobs, name, nameFrom };
}
