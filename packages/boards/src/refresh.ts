// The directory refresh: checks directory rows against their providers (1 request per second per host, robots.txt
// obeyed, the project User-Agent, a request budget), prunes dead tokens, and adds newly discovered boards that
// answer as live boards with a name the board itself reports.
//
// Dead-token rule: a board that answers "not found" is marked "suspect" (it stays). It is removed from the directory
// only when a second check, at least `recheckAfterHours` later, answers "not found" again; the removal is written to
// the pruned file with both dates. Timeouts, server errors and "slow down" answers change nothing. The person's own
// boards live in their database and are never touched by this command.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { CrawlAtsId } from '@jobleft/contracts';
import { NotFoundError, arr, obj, str } from '@jobleft/crawler';
import type { HttpClient } from '@jobleft/crawler';
import {
  DIRECTORY_FORMAT, parseDirectoryFile, toFileRow, type DirectoryEntry, type DirectoryFile, type DirectoryFileRow, type DirectorySource,
} from './directory.ts';
import { boardPageUrl } from './detect.ts';
import { boardId, isCrawlAts } from './ids.ts';
import { classifyError } from './verify.ts';

export interface PrunedRow extends DirectoryFileRow { firstNotFoundAt: string; secondNotFoundAt: string }
export interface PrunedFile { format: 'jobleft-board-directory-pruned/1'; note: string; rows: PrunedRow[] }

export interface DiscoveredSlug { ats: CrawlAtsId; slug: string; region: string | null; source: string }

export type ProbeResult = { state: 'live'; name: string | null } | { state: 'not_found' } | { state: 'unknown'; why: string };

function cleanName(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120 || /^(jobs|careers|job board|not found|page not found|error)$/i.test(t)) return null;
  return t;
}

/** One light request per board (Greenhouse: the board's own name; Lever: 1 posting; Ashby: the job board). */
export async function probeBoard(ats: CrawlAtsId, board: string, region: string | null, http: HttpClient, wantName: boolean): Promise<ProbeResult> {
  const b = encodeURIComponent(board);
  try {
    if (ats === 'greenhouse') {
      const j = obj(await http.getJson(`https://boards-api${region === 'eu' ? '.eu' : ''}.greenhouse.io/v1/boards/${b}`));
      return { state: 'live', name: cleanName(str(j.name)) };
    }
    if (ats === 'lever') {
      await http.getJson(`https://api${region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${b}?mode=json&limit=1`);
    } else if (ats === 'ashby') {
      await http.getJson(`https://api.ashbyhq.com/posting-api/job-board/${b}`);
    } else if (ats === 'workable') {
      const j = obj(await http.getJson(`https://apply.workable.com/api/v1/widget/accounts/${b}`));
      return { state: 'live', name: cleanName(str(j.name)) };
    } else if (ats === 'recruitee') {
      const j = obj(await http.getJson(`https://${b}.recruitee.com/api/offers/`));
      const first = arr(j.offers)[0];
      return { state: 'live', name: first ? cleanName(str(obj(first).company_name)) : null };
    } else {
      await http.getText(`https://${b}.jobs.personio.de/xml?language=en`, 'application/xml');
    }
    if (!wantName || (ats !== 'lever' && ats !== 'ashby')) return { state: 'live', name: null };
    try {
      const html = await http.getText(boardPageUrl(ats, board, region), 'text/html');
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      const t = m ? m[1]!.replace(/\s+jobs$/i, '') : null;
      return { state: 'live', name: cleanName(t) };
    } catch { return { state: 'live', name: null }; }
  } catch (e) {
    if (e instanceof NotFoundError) return { state: 'not_found' };
    return { state: 'unknown', why: classifyError(e).message };
  }
}

export interface RefreshOptions {
  /** The directory file to start from. */
  input: DirectoryFile;
  /** The pruned file so far (tokens removed earlier are never added back from discovery). */
  pruned: PrunedFile | null;
  http: HttpClient;
  /** Which rows to check: every row, a random sample, rows never checked, or these ids. */
  select: { kind: 'all' } | { kind: 'sample'; n: number; seed: number } | { kind: 'unverified' } | { kind: 'ids'; ids: string[] } | { kind: 'none' };
  ats?: CrawlAtsId[];
  /** Newly discovered slugs to check and add when live (with a board-reported name). */
  discovered?: DiscoveredSlug[];
  /** Sources the discovered slugs come from (added to the header). */
  discoveredSources?: DirectorySource[];
  maxChecks: number;
  recheckAfterHours: number;
  now: number;
  log?: (line: string) => void;
}

export interface RefreshSummary {
  checked: number; live: number; suspect: number; pruned: number; unknown: number; renamed: number; added: number;
  discoveredChecked: number; discoveredSkippedNoName: number; stoppedAtBudget: boolean;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Runs the refresh and returns the new directory file, the new pruned file and a summary. */
export async function refreshDirectory(o: RefreshOptions): Promise<{ file: DirectoryFile; pruned: PrunedFile; summary: RefreshSummary }> {
  const log = o.log ?? (() => {});
  const { entries } = parseDirectoryFile(o.input);
  const today = new Date(o.now).toISOString().slice(0, 10);
  const nowIso = new Date(o.now).toISOString();
  const rows = new Map<string, DirectoryEntry & { suspectSince?: string }>();
  const suspectSince = new Map<string, string>();
  for (const r of o.input.rows as Array<DirectoryFileRow & { suspectSince?: string }>) {
    if (r.suspectSince) suspectSince.set(boardId(r.ats, String(r.slug).toLowerCase(), r.region), r.suspectSince);
  }
  for (const e of entries) rows.set(e.id, { ...e, ...(suspectSince.has(e.id) ? { suspectSince: suspectSince.get(e.id)! } : {}) });
  const pruned: PrunedFile = o.pruned ?? { format: 'jobleft-board-directory-pruned/1', note: '', rows: [] };
  pruned.note = 'Boards removed from the directory after two "not found" answers from their provider, at least the stated time apart. A person\'s own boards are never removed.';
  const prunedIds = new Set(pruned.rows.map((r) => boardId(r.ats, r.slug, r.region)));
  const s: RefreshSummary = { checked: 0, live: 0, suspect: 0, pruned: 0, unknown: 0, renamed: 0, added: 0, discoveredChecked: 0, discoveredSkippedNoName: 0, stoppedAtBudget: false };

  // Which rows: suspects that are due for their second check always come first.
  const atsOk = (a: string) => !o.ats || o.ats.includes(a as CrawlAtsId);
  const recheckMs = o.recheckAfterHours * 3_600_000;
  const due: string[] = [];
  for (const [id, e] of rows) {
    if (!atsOk(e.ats)) continue;
    if (e.status === 'suspect' && e.suspectSince && o.now - Date.parse(e.suspectSince) >= recheckMs) due.push(id);
  }
  const rest = [...rows.values()].filter((e) => atsOk(e.ats) && !due.includes(e.id));
  let pick: string[] = [];
  if (o.select.kind === 'all') pick = rest.map((e) => e.id);
  else if (o.select.kind === 'unverified') pick = rest.filter((e) => e.status === 'unverified').map((e) => e.id);
  else if (o.select.kind === 'ids') { const want = new Set(o.select.ids.map((x) => x.toLowerCase())); pick = rest.filter((e) => want.has(e.id)).map((e) => e.id); }
  else if (o.select.kind === 'sample') {
    const r = rng(o.select.seed);
    const pool = rest.map((e) => e.id);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
    pick = pool.slice(0, o.select.n);
  }
  const queue = [...due, ...pick];

  // One queue per host family, run in parallel; the shared pacer spaces each host to 1 request per second.
  let budget = o.maxChecks;
  const take = (): boolean => { if (budget <= 0) { s.stoppedAtBudget = true; return false; } budget--; return true; };
  const byAts = new Map<string, string[]>();
  for (const id of queue) { const a = rows.get(id)!.ats; (byAts.get(a) ?? byAts.set(a, []).get(a)!).push(id); }
  await Promise.all([...byAts.values()].map(async (ids) => {
    for (const id of ids) {
      const e = rows.get(id)!;
      if (!take()) return;
      const r = await probeBoard(e.ats, e.board, e.region, o.http, false);
      s.checked++;
      if (r.state === 'live') {
        s.live++;
        const name = e.ats === 'greenhouse' ? r.name : null;
        if (name && name !== e.company) { s.renamed++; log(`name   ${id}: "${e.company}" -> "${name}" (the board's own name)`); e.company = name; }
        e.status = 'live'; e.lastVerified = today; delete e.suspectSince;
      } else if (r.state === 'not_found') {
        if (e.status === 'suspect' && e.suspectSince && o.now - Date.parse(e.suspectSince) >= recheckMs) {
          rows.delete(id);
          pruned.rows.push({ ...toFileRow(e), firstNotFoundAt: e.suspectSince, secondNotFoundAt: nowIso });
          prunedIds.add(id);
          s.pruned++;
          log(`pruned ${id} (not found at ${e.suspectSince} and ${nowIso})`);
        } else {
          if (e.status !== 'suspect' || !e.suspectSince) e.suspectSince = nowIso;
          e.status = 'suspect'; e.lastVerified = today;
          s.suspect++;
          log(`suspect ${id} (not found; checked again after ${o.recheckAfterHours} h before removal)`);
        }
      } else {
        s.unknown++;
        log(`unknown ${id}: ${r.why}`);
      }
    }
  }));

  // Newly discovered boards: added only when live and the board reports its own name.
  const disc = (o.discovered ?? []).filter((d) => isCrawlAts(d.ats) && atsOk(d.ats));
  const discByAts = new Map<string, DiscoveredSlug[]>();
  for (const d of disc) {
    const id = boardId(d.ats, d.slug, d.region);
    if (rows.has(id) || prunedIds.has(id)) continue;
    (discByAts.get(d.ats) ?? discByAts.set(d.ats, []).get(d.ats)!).push(d);
  }
  await Promise.all([...discByAts.values()].map(async (list) => {
    for (const d of list) {
      if (!take()) return;
      const r = await probeBoard(d.ats, d.slug, d.region, o.http, true);
      s.discoveredChecked++;
      if (r.state !== 'live') continue;
      if (!r.name) { s.discoveredSkippedNoName++; continue; }
      const id = boardId(d.ats, d.slug, d.region);
      rows.set(id, { id, ats: d.ats, board: d.slug.toLowerCase(), region: d.region, company: r.name, source: d.source, lastVerified: today, status: 'live' });
      s.added++;
      log(`added  ${id} "${r.name}" (${d.source})`);
    }
  }));

  const sources = [...(o.input.sources ?? [])];
  for (const src of o.discoveredSources ?? []) if (!sources.some((x) => x.id === src.id)) sources.push(src);
  const outRows = [...rows.values()]
    .sort((a, b) => (a.ats < b.ats ? -1 : a.ats > b.ats ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({ ...toFileRow(e), ...(e.suspectSince ? { suspectSince: e.suspectSince } : {}) }));
  const usedSources = sources.map((src) => ({ ...src, rows: outRows.filter((r) => r.source === src.id).length })).filter((src) => src.rows > 0);
  const counts: Record<string, number> = { total: outRows.length };
  for (const r of outRows) {
    counts[r.ats] = (counts[r.ats] ?? 0) + 1;
    counts[`status_${r.status}`] = (counts[`status_${r.status}`] ?? 0) + 1;
  }
  const file: DirectoryFile = {
    format: DIRECTORY_FORMAT,
    version: `${today}.${Math.floor((o.now % 86_400_000) / 1000)}`,
    generatedAt: nowIso,
    notice: o.input.notice,
    sources: usedSources,
    counts,
    rows: outRows,
  };
  return { file, pruned, summary: s };
}

/** Writes JSON atomically (a temp file, then a rename), so a crash never leaves half a file. */
export function writeJsonAtomic(path: string, value: unknown, pretty = false): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const text = pretty ? JSON.stringify(value, null, 1) : directoryJson(value);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** A directory file with one row per line: small, and a diff shows the rows that changed. */
export function directoryJson(value: unknown): string {
  const v = value as { rows?: unknown[] };
  if (!v || !Array.isArray(v.rows)) return JSON.stringify(value, null, 1) + '\n';
  const { rows, ...head } = v as Record<string, unknown> & { rows: unknown[] };
  const headText = JSON.stringify(head, null, 1).replace(/\n}$/, '');
  return `${headText},\n "rows": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`;
}

export function readPruned(path: string): PrunedFile | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as PrunedFile; } catch { return null; }
}
