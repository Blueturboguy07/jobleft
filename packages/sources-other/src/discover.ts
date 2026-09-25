// ATS board discovery from the links that other sources carry (GitHub lists, HN posts). Pure string work: nothing
// is sent. Boards on crawlable families become candidates for the board list (the boards lane adds them after the
// person confirms); links on never-crawl families are counted and never contacted.

import type { DatabaseSync } from 'node:sqlite';
import type { AtsId, CrawlAtsId } from '@jobleft/contracts';

export interface AtsLink {
  ats: AtsId;
  /** The board token, when the link names one. */
  board: string | null;
  region: string | null;
  jobId: string | null;
  /** true only for families jobleft crawls (greenhouse, lever, ashby, workable, recruitee, personio). */
  crawlable: boolean;
}

const RESERVED = new Set(['embed', 'jobs', 'job', 'api', 'v1', 'boards', 'careers', 'www', 'j', 'o', 'apply']);

function token(s: string | undefined): string | null {
  const t = (s ?? '').trim().toLowerCase();
  if (!t || RESERVED.has(t) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(t)) return null;
  return t;
}

/** What a posting link says about the ATS behind it, or null for other hosts. */
export function atsBoardFromUrl(url: string | null | undefined): AtsLink | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const crawl = (ats: CrawlAtsId, board: string | null, region: string | null, jobId: string | null): AtsLink | null =>
    board ? { ats, board, region, jobId, crawlable: true } : null;
  if (/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (parts[0] === 'embed') return crawl('greenhouse', token(u.searchParams.get('for') ?? undefined), null, u.searchParams.get('token'));
    const i = parts.indexOf('jobs');
    return crawl('greenhouse', token(parts[0]), host.includes('.eu.') ? 'eu' : null, i >= 0 ? parts[i + 1] ?? null : u.searchParams.get('gh_jid'));
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') return crawl('lever', token(parts[0]), host === 'jobs.eu.lever.co' ? 'eu' : null, parts[1] ?? null);
  if (host === 'jobs.ashbyhq.com') return crawl('ashby', token(decodeURIComponent(parts[0] ?? '')), null, parts[1] ?? null);
  if (host === 'apply.workable.com') return crawl('workable', token(parts[0]), null, parts[1] === 'j' ? parts[2] ?? null : null);
  let m = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (m) return crawl('recruitee', token(m[1]), null, parts[0] === 'o' ? parts[1] ?? null : null);
  m = /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/.exec(host);
  if (m) return crawl('personio', token(m[1]), null, parts[0] === 'job' ? parts[1] ?? null : null);
  const other = (ats: AtsId): AtsLink => ({ ats, board: null, region: null, jobId: null, crawlable: false });
  if (/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/.test(host)) return other('workday');
  if (/(^|\.)icims\.com$/.test(host)) return other('icims');
  if (/(^|\.)smartrecruiters\.com$/.test(host)) return other('smartrecruiters');
  if (/(^|\.)oraclecloud\.com$/.test(host)) return other('oracle');
  if (/(^|\.)taleo\.net$/.test(host)) return other('taleo');
  if (/(^|\.)(ultipro|ukg)\.(com|net)$/.test(host)) return other('ukg');
  if (/(^|\.)jobvite\.com$/.test(host)) return other('jobvite');
  if (/(^|\.)bamboohr\.com$/.test(host)) return other('bamboohr');
  if (/(^|\.)teamtailor\.com$/.test(host)) return other('teamtailor');
  if (/(^|\.)breezy\.hr$/.test(host)) return other('breezy');
  return null;
}

export interface BoardCandidate {
  ats: CrawlAtsId;
  board: string;
  region: string | null;
  /** The employer name the listing gives (the most frequent one). */
  company: string;
  /** Open postings that link to this board. */
  postings: number;
  sources: string[];
  exampleUrl: string;
}

export interface DiscoveryReport {
  candidates: BoardCandidate[];
  /** Postings on families jobleft never contacts, by family (counted only). */
  notCrawled: Record<string, number>;
  /** Postings on other hosts (company career sites). */
  otherHosts: number;
}

/** Boards behind the links of open postings from other sources. */
export function discoverBoards(db: DatabaseSync, opts: { sourceIds?: string[] } = {}): DiscoveryReport {
  const rows = db.prepare(`SELECT source_id, company, url, apply_url FROM feed_postings WHERE status = 'open'`).all() as Array<{ source_id: string; company: string; url: string; apply_url: string | null }>;
  const byBoard = new Map<string, BoardCandidate & { names: Map<string, number> }>();
  const notCrawled: Record<string, number> = {};
  let otherHosts = 0;
  for (const r of rows) {
    if (opts.sourceIds && !opts.sourceIds.includes(r.source_id)) continue;
    const link = atsBoardFromUrl(r.apply_url) ?? atsBoardFromUrl(r.url);
    if (!link) { otherHosts++; continue; }
    if (!link.crawlable || !link.board) { notCrawled[link.ats] = (notCrawled[link.ats] ?? 0) + 1; continue; }
    const key = `${link.ats}:${link.region ?? ''}:${link.board}`;
    let c = byBoard.get(key);
    if (!c) {
      c = { ats: link.ats as CrawlAtsId, board: link.board, region: link.region, company: r.company, postings: 0, sources: [], exampleUrl: r.apply_url ?? r.url, names: new Map() };
      byBoard.set(key, c);
    }
    c.postings++;
    if (!c.sources.includes(r.source_id)) c.sources.push(r.source_id);
    c.names.set(r.company, (c.names.get(r.company) ?? 0) + 1);
  }
  const candidates = [...byBoard.values()].map(({ names, ...c }) => {
    const best = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return { ...c, company: best ? best[0] : c.company };
  }).sort((a, b) => b.postings - a.postings || a.board.localeCompare(b.board));
  return { candidates, notCrawled, otherHosts };
}
