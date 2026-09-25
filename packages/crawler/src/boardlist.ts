// Board lists: the JSON file a person (or a test) gives the crawler. Each entry is either a board
// ({ "ats": "greenhouse", "board": "acme", "company": "Acme" }) or a link ({ "url": "https://jobs.lever.co/acme" }).
// Links are recognised from the text only: nothing is fetched to find out what they are. Entries that jobleft will not
// crawl are returned with a plain reason, never silently dropped.

import { CRAWL_ATS_IDS } from '@jobleft/contracts';
import { forbiddenHostOf, forbiddenReason, loopbackOrigin } from './hosts.ts';
import type { Ats, BoardRef } from './types.ts';

export interface SkippedEntry { entry: string; reason: string }
export interface BoardList { boards: BoardRef[]; skipped: SkippedEntry[]; duplicates: number }

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const NEVER_FAMILIES: Record<string, string> = { linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', smartrecruiters: 'SmartRecruiters' };
const HELD_FAMILIES: Record<string, string> = { workday: 'Workday', icims: 'iCIMS', oracle: 'Oracle Recruiting', ukg: 'UKG', taleo: 'Taleo' };

/** What board a link names (Greenhouse, Lever or Ashby), or why it names none. Sends nothing. */
export function boardFromUrl(link: string): { ats: Ats; board: string; region?: string } | { reason: string } {
  let u: URL;
  try { u = new URL(link.trim()); } catch { return { reason: 'not a web link' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { reason: `only web links (http or https) are read, not ${u.protocol}` };
  const forbidden = forbiddenHostOf(u.hostname);
  if (forbidden) return { reason: `${forbiddenReason(forbidden)}; nothing was sent` };
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const pick = (ats: Ats, board: string | undefined, region?: string) => {
    if (!board || !TOKEN.test(board)) return { reason: `the link does not name a ${ats} board` };
    return region ? { ats, board, region } : { ats, board };
  };
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (parts[0] === 'embed') return pick('greenhouse', u.searchParams.get('for') ?? undefined);
    return pick('greenhouse', parts[0]);
  }
  if (host === 'boards-api.greenhouse.io' && parts[0] === 'v1' && parts[1] === 'boards') return pick('greenhouse', parts[2]);
  if (host === 'jobs.lever.co') return pick('lever', parts[0]);
  if (host === 'jobs.eu.lever.co') return pick('lever', parts[0], 'eu');
  if ((host === 'api.lever.co' || host === 'api.eu.lever.co') && parts[0] === 'v0' && parts[1] === 'postings') {
    return pick('lever', parts[2], host === 'api.eu.lever.co' ? 'eu' : undefined);
  }
  if (host === 'jobs.ashbyhq.com') return pick('ashby', parts[0]);
  if (host === 'api.ashbyhq.com' && parts[0] === 'posting-api' && parts[1] === 'job-board') return pick('ashby', parts[2]);
  if (u.searchParams.has('gh_jid')) {
    return { reason: 'a company careers page that shows a Greenhouse job; add the Greenhouse board name instead (nothing was sent)' };
  }
  return { reason: `${host} is not a Greenhouse, Lever or Ashby board link; jobleft does not open other links, short links included (nothing was sent)` };
}

function show(e: unknown): string {
  const s = JSON.stringify(e);
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

/**
 * Reads a board list: a JSON array of entries, or { "boards": [...] }. Entries with an ATS that has no adapter in
 * `adapters` are kept when the ATS is a crawlable family (the crawl then reports "no adapter"), and skipped with a
 * reason when it is a never-crawl or held-back family. The same board listed twice is kept once.
 */
export function parseBoardList(text: string): BoardList {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`the board list is not valid JSON: ${(e as Error).message}`); }
  const entries = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { boards?: unknown }).boards))
    ? (parsed as { boards: unknown[] }).boards : null;
  if (!entries) throw new Error('the board list must be a JSON array of boards, or an object with a "boards" array');
  const out: BoardList = { boards: [], skipped: [], duplicates: 0 };
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { out.skipped.push({ entry: show(raw), reason: 'an entry must be an object' }); continue; }
    const e = raw as Record<string, unknown>;
    const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
    let ats = str('ats').toLowerCase();
    let board = str('board');
    let region = str('region').toLowerCase();
    const company = str('company');
    const origin = str('origin');
    if (str('url')) {
      const r = boardFromUrl(str('url'));
      if ('reason' in r) { out.skipped.push({ entry: str('url'), reason: r.reason }); continue; }
      ats = r.ats; board = r.board; region = r.region ?? region;
    }
    if (!ats) { out.skipped.push({ entry: show(raw), reason: 'the entry names no ATS ("ats") and no link ("url")' }); continue; }
    if (NEVER_FAMILIES[ats]) { out.skipped.push({ entry: show(raw), reason: `jobleft never contacts ${NEVER_FAMILIES[ats]}; nothing was sent` }); continue; }
    if (HELD_FAMILIES[ats]) { out.skipped.push({ entry: show(raw), reason: `${HELD_FAMILIES[ats]} sources are off until the owner turns them on; nothing was sent` }); continue; }
    if (!(CRAWL_ATS_IDS as readonly string[]).includes(ats)) { out.skipped.push({ entry: show(raw), reason: `jobleft cannot crawl boards of type "${ats}"; nothing was sent` }); continue; }
    if (!board || !TOKEN.test(board)) { out.skipped.push({ entry: show(raw), reason: 'the board name ("board") is missing or has characters a board name cannot have' }); continue; }
    if (origin && !loopbackOrigin(origin)) {
      out.skipped.push({ entry: show(raw), reason: `"origin" must be a mock server on this computer (http://127.0.0.1:<port>); ${origin} is not, and nothing was sent` });
      continue;
    }
    if (region && region !== 'eu') { out.skipped.push({ entry: show(raw), reason: `unknown region "${region}" (only "eu" for Lever)` }); continue; }
    const key = `${ats}\u0000${board.toLowerCase()}\u0000${region}`;
    if (seen.has(key)) { out.duplicates++; continue; }
    seen.add(key);
    // No company given: the board's own data names it (Greenhouse company_name), else the board name is shown.
    const ref: BoardRef = { ats: ats as Ats, board, company };
    if (region) ref.region = region;
    if (origin) ref.origin = loopbackOrigin(origin)!;
    out.boards.push(ref);
  }
  return out;
}
