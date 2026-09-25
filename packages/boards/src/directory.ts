// The board directory: the list of employer boards that ships with the app.
//
// File: packages/boards/data/board-directory.json (format "jobleft-board-directory/1"). Its header names every
// source with its licence and a public page; each row is { ats, slug, name, region, source, lastVerified, status }.
// Which directory is in use (first that exists):
//   1. JOBLEFT_BOARD_DIRECTORY=<file>   (tests and demos; "none" = an empty directory)
//   2. $JOBLEFT_HOME/datasets/board-directory.json   (a newer directory the person loaded; see `directory load`)
//   3. the bundled file in this package
// A directory never holds the person's boards or choices: those live in board_prefs, so a directory update can
// never remove, rename or re-enable them.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrawlAtsId } from '@jobleft/contracts';
import type { DirectoryRow } from '@jobleft/static-data';
import { boardId, isCrawlAts } from './ids.ts';
import { forbiddenProvider } from './hosts.ts';
import { boardApiHost } from './detect.ts';
import { unreadableRegion } from './sources.ts';

export const DIRECTORY_FORMAT = 'jobleft-board-directory/1';

export type DirectoryStatus = 'live' | 'unverified' | 'suspect';

/** One row as the directory file stores it. */
export interface DirectoryFileRow {
  ats: CrawlAtsId;
  slug: string;
  name: string;
  region: string | null;
  /** The id of an entry in the file's `sources`. */
  source: string;
  /** The date the build last checked this board against its provider (YYYY-MM-DD), or null (never checked). */
  lastVerified: string | null;
  /** live = answered at the last check; suspect = answered "not found" once (checked again before removal); unverified = not checked. */
  status: DirectoryStatus;
  /** Set on a suspect row: when the provider first answered "not found" (RFC 3339). */
  suspectSince?: string;
}

export interface DirectorySource {
  id: string;
  name: string;
  url: string;
  licence: string;
  licenceUrl: string | null;
  commit?: string | null;
  copyright?: string | null;
  /** The full licence text when the licence asks for it to travel with the data (MIT). */
  licenceText?: string | null;
  note?: string | null;
  rows: number;
}

export interface DirectoryFile {
  format: string;
  version: string;
  generatedAt: string;
  notice: string;
  sources: DirectorySource[];
  counts: Record<string, number>;
  rows: DirectoryFileRow[];
}

/** A DirectoryRow (the static-data shape) with the build's verification facts. */
export interface DirectoryEntry extends DirectoryRow {
  id: string;
  lastVerified: string | null;
  status: DirectoryStatus;
}

export interface LoadedDirectory {
  entries: DirectoryEntry[];
  /** Where it came from. */
  origin: 'env' | 'installed' | 'bundled' | 'none';
  path: string | null;
  version: string | null;
  sources: DirectorySource[];
  notice: string | null;
  /** Rows refused while loading (bad provider, blank name, bad slug, forbidden host, duplicate), with reasons. */
  refused: Array<{ row: number; reason: string }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_DIRECTORY_PATH = join(HERE, '..', 'data', 'board-directory.json');
export const PRUNED_DIRECTORY_PATH = join(HERE, '..', 'data', 'board-directory-pruned.json');

const SLUG = /^[a-z0-9][a-z0-9._ -]{0,99}$/;

/** Checks and normalises a directory file. Bad rows are refused with a reason; duplicates keep the first row. */
export function parseDirectoryFile(json: unknown): { file: DirectoryFile; entries: DirectoryEntry[]; refused: Array<{ row: number; reason: string }> } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('This is not a board directory file (expected a JSON object).');
  const f = json as Partial<DirectoryFile>;
  if (f.format !== DIRECTORY_FORMAT) throw new Error(`This is not a board directory file (format is not "${DIRECTORY_FORMAT}").`);
  if (!Array.isArray(f.rows)) throw new Error('The board directory file has no rows list.');
  const sources = Array.isArray(f.sources) ? f.sources : [];
  const sourceIds = new Set(sources.map((s) => s.id));
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];
  const refused: Array<{ row: number; reason: string }> = [];
  f.rows.forEach((r, i) => {
    const row = r as Partial<DirectoryFileRow>;
    const ats = String(row.ats ?? '');
    if (!isCrawlAts(ats)) { refused.push({ row: i, reason: `unknown provider "${ats}"` }); return; }
    const slug = String(row.slug ?? '').trim().toLowerCase();
    if (!SLUG.test(slug)) { refused.push({ row: i, reason: `bad board name "${row.slug}"` }); return; }
    const name = String(row.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) { refused.push({ row: i, reason: 'blank employer name' }); return; }
    const region = row.region ? String(row.region).toLowerCase() : null;
    if (region !== null && region !== 'eu') { refused.push({ row: i, reason: `unknown region "${row.region}"` }); return; }
    if (unreadableRegion(ats, region)) { refused.push({ row: i, reason: `${ats} boards in region "${region}" have no public feed` }); return; }
    const host = boardApiHost(ats, slug, region);
    if (forbiddenProvider(host.split(':')[0]!)) { refused.push({ row: i, reason: `forbidden host ${host}` }); return; }
    const source = String(row.source ?? '');
    if (sourceIds.size > 0 && !sourceIds.has(source)) { refused.push({ row: i, reason: `source "${source}" is not named in the header` }); return; }
    const id = boardId(ats, slug, region);
    if (seen.has(id)) { refused.push({ row: i, reason: `duplicate board ${id}` }); return; }
    seen.add(id);
    const status: DirectoryStatus = row.status === 'live' || row.status === 'suspect' ? row.status : 'unverified';
    const lastVerified = typeof row.lastVerified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.lastVerified) ? row.lastVerified : null;
    entries.push({ id, ats, board: slug, region, company: name, source, lastVerified, status });
  });
  const file: DirectoryFile = {
    format: DIRECTORY_FORMAT,
    version: String(f.version ?? 'unknown'),
    generatedAt: String(f.generatedAt ?? ''),
    notice: String(f.notice ?? ''),
    sources,
    counts: f.counts ?? {},
    rows: f.rows as DirectoryFileRow[],
  };
  return { file, entries, refused };
}

export function readDirectoryFile(path: string): { file: DirectoryFile; entries: DirectoryEntry[]; refused: Array<{ row: number; reason: string }> } {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`Cannot read the board directory file ${path}.`); }
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`The board directory file ${path} is not valid JSON.`); }
  return parseDirectoryFile(json);
}

/** The installed copy of a newer directory inside the data folder. */
export function installedDirectoryPath(home: string): string { return join(home, 'datasets', 'board-directory.json'); }

/** The directory in use (see the order at the top of this file). A damaged installed copy falls back to the bundled one. */
export function loadActiveDirectory(opts: { home?: string | null; env?: Record<string, string | undefined> } = {}): LoadedDirectory {
  const env = opts.env ?? process.env;
  const pick = env.JOBLEFT_BOARD_DIRECTORY;
  const fromFile = (path: string, origin: LoadedDirectory['origin']): LoadedDirectory => {
    const { file, entries, refused } = readDirectoryFile(path);
    return { entries, origin, path, version: file.version, sources: file.sources, notice: file.notice, refused };
  };
  if (pick) {
    if (pick === 'none') return { entries: [], origin: 'none', path: null, version: null, sources: [], notice: null, refused: [] };
    return fromFile(pick, 'env');
  }
  if (opts.home) {
    const p = installedDirectoryPath(opts.home);
    if (existsSync(p)) {
      try { return fromFile(p, 'installed'); } catch { /* damaged: use the bundled copy */ }
    }
  }
  return fromFile(BUNDLED_DIRECTORY_PATH, 'bundled');
}

/** Converts file rows to entries (used by the build scripts). */
export function toFileRow(e: DirectoryEntry): DirectoryFileRow {
  return { ats: e.ats, slug: e.board, name: e.company, region: e.region, source: e.source, lastVerified: e.lastVerified, status: e.status };
}

// ------------------------------------------------------------------ search

const LEGAL = new Set(['inc', 'incorporated', 'llc', 'corp', 'corporation', 'co', 'ltd', 'limited', 'llp', 'plc', 'pbc', 'gmbh', 'ag', 'sa', 'bv', 'oy', 'ab', 'pty', 'srl', 'sas', 'spa']);

/** Words of a company name for search: accents, case, punctuation and legal suffixes do not count. */
export function nameWords(s: string): string[] {
  const words = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bl\.\s?l\.\s?([cp])\b\.?/g, 'll$1').replace(/[&+]/g, ' and ').replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  // Drop the legal tail ("Inc.", "L.L.C."), then a leading "the".
  while (words.length > 1 && LEGAL.has(words[words.length - 1]!)) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words;
}

/** The search key of a name: "Stripe, Inc." -> "stripe". */
export function nameKey(s: string): string { return nameWords(s).join(''); }

const ATS_ORDER: Readonly<Record<string, number>> = { greenhouse: 0, lever: 1, ashby: 2, workable: 3, recruitee: 4, personio: 5 };

interface Indexed { e: DirectoryRow & { id?: string }; id: string; key: string; words: string[]; slug: string }

/** The shipped directory in memory, with search. */
export class BoardDirectory {
  private rows: Indexed[];
  private byId = new Map<string, Indexed>();
  constructor(rows: DirectoryRow[]) {
    this.rows = [];
    for (const r of rows) {
      const id = boardId(r.ats, r.board, r.region);
      if (this.byId.has(id)) continue;
      const words = nameWords(r.company);
      const ix: Indexed = { e: r, id, key: words.join(''), words, slug: r.board.toLowerCase().replace(/[^a-z0-9]/g, '') };
      this.rows.push(ix);
      this.byId.set(id, ix);
    }
  }
  get size(): number { return this.rows.length; }
  get(id: string): DirectoryRow | undefined { return this.byId.get(id.trim().toLowerCase())?.e; }
  has(id: string): boolean { return this.byId.has(id.trim().toLowerCase()); }
  all(): DirectoryRow[] { return this.rows.map((r) => r.e); }
  ids(): string[] { return this.rows.map((r) => r.id); }

  /** Rank of a row for a query (lower is better), or null when it does not match. */
  static rank(q: { key: string; words: string[] }, r: { key: string; words: string[]; slug: string }): number | null {
    if (!q.key) return null;
    if (r.key === q.key) return 0;
    if (r.slug === q.key) return 1;
    if (r.key.startsWith(q.key)) return 2;
    if (q.words.length > 0 && q.words.every((w) => r.words.some((x) => x.startsWith(w)))) return 3;
    if (r.slug.startsWith(q.key)) return 4;
    if (q.key.length >= 3 && (r.key.includes(q.key) || r.slug.includes(q.key))) return 5;
    return null;
  }

  /** Case-, accent- and suffix-insensitive company search; the same entry comes first for "stripe" and "Stripe, Inc.". */
  search(q: string, limit = 20): DirectoryRow[] {
    const words = nameWords(q);
    const query = { key: words.join(''), words };
    const hits: Array<{ r: Indexed; rank: number }> = [];
    for (const r of this.rows) {
      const rank = BoardDirectory.rank(query, r);
      if (rank !== null) hits.push({ r, rank });
    }
    hits.sort((a, b) => a.rank - b.rank || a.r.key.length - b.r.key.length ||
      (ATS_ORDER[a.r.e.ats] ?? 9) - (ATS_ORDER[b.r.e.ats] ?? 9) || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
    return hits.slice(0, Math.max(0, limit)).map((h) => h.r.e);
  }
}
