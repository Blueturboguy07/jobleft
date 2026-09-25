// detectBoard(): from a pasted link to the board(s) behind it, reading pages when the link itself does not name a
// board (an employer-hosted careers page, a gh_jid job link, a short link that redirects). It does not check the
// board with its provider; BoardService.resolve() does that (name and open jobs) on top of this walk.
//
// The walk: fetch the page with the polite client; a redirect is never followed blindly (its target is checked
// first: a forbidden host ends the walk, a board link is the answer); scan the HTML for embedded boards; follow a
// meta refresh or script redirect; from a home page with no board, try one same-site careers link. At most 6 pages.

import type { BoardResolveResponse, CrawlAtsId } from '@jobleft/contracts';
import { HttpError } from '@jobleft/crawler';
import type { HttpClient } from '@jobleft/crawler';
import { detectBoardFromUrl, type LinkBoard, type UrlDetection } from './detect.ts';
import { httpStateFor } from './http.ts';
import { scanPage, type PageBoard } from './page.ts';
import { classifyError } from './verify.ts';

type Reason = NonNullable<BoardResolveResponse['reason']>;

export type WalkResult =
  | { kind: 'boards'; boards: Array<LinkBoard | PageBoard>; pageUrl: string; note: string }
  /** retryable: the link may be fine; the network or the site failed (the link is kept to try again). */
  | { kind: 'cannot'; reason: Reason; message: string; offline?: boolean; retryable?: boolean }
  /** Nothing a plain request can see. `hints`: providers the page names without a readable board. */
  | { kind: 'nothing'; hints: CrawlAtsId[]; blocked: boolean };

export interface WalkOptions {
  /** Called when the shared client cached a failed robots.txt fetch (network trouble) for a host. */
  onRobotsNetworkFailure?: (host: string) => void;
  maxCandidates?: number;
}

type PageFetch = { html: string } | { redirect: string } | { fail: ReturnType<typeof classifyError>; robotsNet: boolean };

async function fetchPage(http: HttpClient, u: URL, opts: WalkOptions): Promise<PageFetch> {
  try {
    return { html: await http.getText(u.href, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5') };
  } catch (e) {
    if (e instanceof HttpError && e.status >= 300 && e.status < 400) {
      const loc = httpStateFor(http)?.redirects.get(e.url);
      if (loc) {
        try { return { redirect: new URL(loc, u).href }; } catch { /* a bad Location header */ }
      }
    }
    const c = classifyError(e);
    let robotsNet = false;
    if (c.failure === 'robots') {
      const url = (e as { url?: string }).url ?? u.href;
      const host = new URL(url).host;
      const r = httpStateFor(http)?.robots.get(host);
      if (r?.error) { robotsNet = true; opts.onRobotsNetworkFailure?.(host); }
      else if (r && r.status !== null && r.status >= 500) {
        return { fail: { failure: 'robots', status: r.status, message: `The site's robots.txt could not be read (HTTP ${r.status}), so jobleft did not read the page.` }, robotsNet };
      }
    }
    return { fail: c, robotsNet };
  }
}

const OFFLINE_MSG = 'jobleft could not reach the network, so it could not check this link. The link is kept in your pending links; try again when you are online. Nothing was added.';

/** Walks from a page link to the boards it embeds. */
export async function walkForBoards(first: Extract<UrlDetection, { kind: 'page' }>, http: HttpClient, opts: WalkOptions = {}): Promise<WalkResult> {
  const max = opts.maxCandidates ?? 8;
  let current = first.url;
  const visited = new Set<string>();
  let hops = 0;
  let careersHop = false;
  let blocked = false;
  const hints = new Set<CrawlAtsId>();
  if (first.hints.ghJid) hints.add('greenhouse');
  if (first.hints.ashbyJid) hints.add('ashby');

  const follow = (target: string, how: string): { next: URL } | WalkResult => {
    const d = detectBoardFromUrl(target);
    switch (d.kind) {
      case 'forbidden': return { kind: 'cannot', reason: 'forbidden_host', message: `The link ${how} ${d.provider} (${d.url.hostname}), which jobleft does not support. Nothing was sent there and nothing was added.` };
      case 'board': return { kind: 'boards', boards: [d.found], pageUrl: target, note: '' };
      case 'unsupported': return { kind: 'cannot', reason: 'unsupported_provider', message: `The link ${how} a ${d.provider} board, which jobleft does not support. Nothing was added.` };
      case 'job_site': return { kind: 'cannot', reason: 'unsupported_provider', message: `The link ${how} ${d.provider}, a job search site, not an employer's board. Nothing was added.` };
      case 'provider_home': return { kind: 'cannot', reason: 'no_board_found', message: `${d.why} Nothing was added.` };
      case 'not_a_link': return { kind: 'cannot', reason: 'broken_link', message: `The link ${how} an address jobleft cannot open. Nothing was added.` };
      default: return { next: d.url };
    }
  };

  for (;;) {
    if (visited.has(current.href) || hops > 5) {
      return { kind: 'cannot', reason: 'broken_link', message: 'The link keeps redirecting (a loop or too many steps), so jobleft stopped. Nothing was added.' };
    }
    visited.add(current.href);
    const r = await fetchPage(http, current, opts);
    if ('redirect' in r) {
      const f = follow(r.redirect, 'redirects to');
      if ('kind' in f) return f;
      current = f.next; hops++; continue;
    }
    if ('fail' in r) {
      const { fail } = r;
      if (careersHop) break; // the careers link from the home page failed: the home page itself has no board
      if (fail.failure === 'offline') return { kind: 'cannot', reason: 'offline', message: OFFLINE_MSG, offline: true };
      if (r.robotsNet) {
        return { kind: 'cannot', reason: 'broken_link', retryable: true, message: `jobleft could not reach ${current.hostname} (the site did not answer). Check the link, or check that you are online. The link is kept in your pending links. Nothing was added.` };
      }
      if (fail.failure === 'robots') return { kind: 'cannot', reason: 'blocked_by_robots', message: `${fail.message.replace(/this address\.$/, 'this page.')} Nothing was added.` };
      if (fail.failure === 'not_found') return { kind: 'cannot', reason: 'broken_link', message: `The page answered "not found" (HTTP ${fail.status}). Check the link. Nothing was added.` };
      if (fail.failure === 'forbidden') return { kind: 'cannot', reason: 'forbidden_host', message: `${fail.message} Nothing was added.` };
      if (fail.failure === 'blocked' && fail.status === 403) { blocked = true; break; }
      if (fail.failure === 'network' || fail.failure === 'timeout') {
        return { kind: 'cannot', reason: 'broken_link', retryable: true, message: `jobleft could not open ${current.hostname}: ${fail.message} Check the link, or check that you are online. The link is kept in your pending links. Nothing was added.` };
      }
      return { kind: 'cannot', reason: 'broken_link', retryable: fail.failure === 'server' || fail.failure === 'busy', message: `jobleft could not open the page: ${fail.message} Nothing was added.` };
    }
    const scan = scanPage(r.html, current);
    if (scan.boards.length) {
      const note = scan.boards.length > max ? `The page names ${scan.boards.length} boards; jobleft shows the first ${max}.` : '';
      return { kind: 'boards', boards: scan.boards.slice(0, max), pageUrl: current.href, note };
    }
    for (const h of scan.providerHints) hints.add(h);
    if (scan.forbiddenTarget) {
      return { kind: 'cannot', reason: 'forbidden_host', message: `This page sends people to ${scan.forbiddenTarget}, which jobleft does not support. Nothing was sent there and nothing was added.` };
    }
    if (scan.redirect) {
      const f = follow(scan.redirect, 'redirects to');
      if ('kind' in f) return f;
      current = f.next; hops++; continue;
    }
    if (!careersHop && scan.careersLinks.length) {
      careersHop = true;
      current = new URL(scan.careersLinks[0]!); hops++; continue;
    }
    break;
  }
  return { kind: 'nothing', hints: [...hints], blocked };
}

export type DetectBoardResult =
  | { ok: true; boards: Array<LinkBoard & { evidence?: string }>; via: 'link' | 'page'; pageUrl: string | null }
  | { ok: false; reason: Reason; message: string };

/**
 * Detects the provider and board behind a pasted link: a board link, a single-job link, an embed link, a regional
 * host, a gh_jid link on an employer's site, or an employer's careers page that embeds a board. Pages are read with
 * the polite client (never a forbidden host). The board is not checked with its provider here.
 */
export async function detectBoard(url: string, opts: { http: HttpClient; offline?: boolean }): Promise<DetectBoardResult> {
  const d = detectBoardFromUrl(url);
  switch (d.kind) {
    case 'not_a_link': return { ok: false, reason: 'not_a_link', message: 'That is not a web link.' };
    case 'forbidden': return { ok: false, reason: 'forbidden_host', message: `jobleft does not support ${d.provider}; nothing was sent to ${d.url.hostname}.` };
    case 'unsupported': return { ok: false, reason: 'unsupported_provider', message: `${d.provider} boards are not supported.` };
    case 'job_site': return { ok: false, reason: 'unsupported_provider', message: `${d.provider} is a job search site, not one employer's board.` };
    case 'provider_home': return { ok: false, reason: 'no_board_found', message: d.why };
    case 'board': return { ok: true, boards: [d.found], via: 'link', pageUrl: null };
    default: break;
  }
  if (opts.offline) return { ok: false, reason: 'offline', message: 'jobleft is offline; the page was not read.' };
  const w = await walkForBoards(d, opts.http);
  if (w.kind === 'boards') return { ok: true, boards: w.boards, via: 'page', pageUrl: w.pageUrl };
  if (w.kind === 'cannot') return { ok: false, reason: w.reason, message: w.message };
  return { ok: false, reason: 'no_board_found', message: w.hints.length ? `The page loads its ${w.hints.join('/')} board by a script jobleft cannot read.` : 'No job board found on the page.' };
}
