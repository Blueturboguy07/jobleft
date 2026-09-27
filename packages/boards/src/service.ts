// BoardService: the person's board list (directory boards plus the boards they added), their choices, resolving a
// pasted link to a board, and the health facts of each board. It owns the tables in src/db.ts.
//
// Rules this file keeps:
//   * resolve() adds nothing; add() needs the person's confirmation (the server calls it after the person confirms)
//   * the employer name comes from the board itself or from the directory, never from the link text or a guess
//   * every request goes through the shared polite client; forbidden hosts get nothing, not even a redirect hop
//   * a directory update never removes, renames or re-enables a person's boards or choices (board_prefs is theirs)
//   * a board is marked unreachable only after two failed checks in a row, and is asked again on a stated date

import type { DatabaseSync } from 'node:sqlite';
import type { BoardEntry, BoardResolveResponse, BoardState, CrawlAtsId } from '@jobleft/contracts';
import { formatDollars, nowMs } from '@jobleft/contracts';
import type { BoardRef, HttpClient, SourceRegistry } from '@jobleft/crawler';
import { inTransaction, migrateBoards } from './db.ts';
import { BoardDirectory, nameWords } from './directory.ts';
import { PROVIDER_NAMES, boardApiUrl, boardPageUrl, detectBoardFromUrl, type LinkBoard, type UrlDetection } from './detect.ts';
import { httpStateFor } from './http.ts';
import { boardId, isCrawlAts, parseBoardId } from './ids.ts';
import { scanPage, type PageBoard } from './page.ts';
import { walkForBoards } from './discover.ts';
import { unreadableRegion } from './sources.ts';
import { verifyBoard, type CheckFailure, type VerifyResult } from './verify.ts';

/** A paid page fetch (the metered route). Structurally the same as MeteredFetchClient in @jobleft/sources-other. */
export interface PaidPageFetcher {
  readonly enabled: boolean;
  prices(): { page: number; jsPage: number };
  fetchPage(url: string, opts: { js: boolean; maxPriceMicros: number; signal?: AbortSignal }): Promise<{ url: string; html: string; costMicros: number }>;
}

export type BoardErrorCode = 'conflict' | 'not_found' | 'bad_request' | 'unsupported_source' | 'forbidden_source';

/** A refusal with a local API error code and one plain sentence. */
export class BoardError extends Error {
  readonly code: BoardErrorCode;
  constructor(code: BoardErrorCode, message: string) { super(message); this.name = 'BoardError'; this.code = code; }
}

export interface BoardServiceOptions {
  db: DatabaseSync;
  directory: BoardDirectory;
  /** The polite client: every paste and every refresh shares its pacer (1 request per second per host). */
  http: HttpClient;
  sources: SourceRegistry;
  now?: () => number;
  /** Makes a fresh polite client (same pacer) when the shared one cached a failed robots.txt fetch. Optional. */
  newHttp?: () => HttpClient;
  /** The paid page fetch. null or disabled = never offered. */
  paid?: PaidPageFetcher | null;
  /** true = no request at all (JOBLEFT_OFFLINE). */
  offline?: () => boolean;
  /** A resolve answers within this time (default 25 s; 60 s when a paid lookup was accepted). */
  resolveDeadlineMs?: number;
  /**
   * Whether the person already has this board (additive). A host app that keeps the person's board list in its own
   * table (apps/server) answers here; without it, a board the person added through board_prefs counts.
   */
  isAdded?: (boardId: string) => boolean;
}

interface PrefRow {
  id: string; ats: string; board: string; region: string | null; company: string; added_by_user: number;
  followed: number; hidden: number; disabled: number; added_at: string | null; updated_at: string; source_url: string | null;
}
interface CheckRow {
  id: string; state: string; consecutive_failures: number; last_check_at: string | null; last_success_at: string | null;
  next_check_at: string | null; open_jobs: number | null; last_error: string | null; last_outcome: string | null;
}

export type ListView = 'all' | 'followed' | 'user' | 'hidden' | 'disabled' | 'failing';

type Answer = BoardResolveResponse;
/** Answers whose link may be fine (network or site trouble): the link is kept in the pending list. */
const RETRY = new WeakSet<Answer>();

/** What one check of a board (a refresh or a confirmed paste) saw. */
export type CheckOutcome =
  | { ok: true; listed: number }
  | { ok: false; failure: CheckFailure; message: string; retryAfterMs?: number | null; httpStatus?: number | null;
      /** Every board of the host failed in the same refresh: shown as a warning, never escalated to unreachable. */
      hostOutage?: boolean };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Failed checks in a row before a board counts as unreachable. One failure never does. */
export const UNREACHABLE_AFTER = 2;
/** Back-off of an unreachable board: 1 day after the 2nd failure, doubling, at most 30 days. */
export function backoffMs(consecutiveFailures: number): number {
  const n = Math.max(0, consecutiveFailures - UNREACHABLE_AFTER);
  return Math.min(DAY * 2 ** Math.min(n, 10), 30 * DAY);
}

const ATS_ORDER: Readonly<Record<string, number>> = { greenhouse: 0, lever: 1, ashby: 2, workable: 3, recruitee: 4, personio: 5 };
const VERIFY_CACHE_MS = 15 * 60_000;
const RESOLVE_CACHE_MS = 10 * 60_000;
const MAX_CANDIDATES = 8;

function iso(ms: number): string { return new Date(ms).toISOString(); }

/** Dollars for a price that can be under a cent ("$0.004"). */
export function priceText(micros: number): string {
  if (micros >= 10_000) return formatDollars(micros);
  const d = micros / 1_000_000;
  return `$${d.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00')}`;
}

function encodeCursor(k: Array<string | number>): string { return Buffer.from(JSON.stringify(k)).toString('base64url'); }
function decodeCursor(c: string): Array<string | number> | null {
  try { const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); return Array.isArray(v) ? v : null; } catch { return null; }
}
function cmpKey(a: Array<string | number>, b: Array<string | number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export class BoardService {
  readonly db: DatabaseSync;
  readonly directory: BoardDirectory;
  readonly sources: SourceRegistry;
  private http: HttpClient;
  private newHttp: (() => HttpClient) | null;
  private now: () => number;
  private paid: PaidPageFetcher | null;
  private offline: () => boolean;
  private deadlineMs: number;
  private isAddedHook: ((boardId: string) => boolean) | null;
  private verified = new Map<string, { at: number; openJobs: number; name: string | null }>();
  private resolveCache = new Map<string, { at: number; answer: BoardResolveResponse }>();

  constructor(opts: BoardServiceOptions) {
    this.db = opts.db;
    this.directory = opts.directory;
    this.http = opts.http;
    this.newHttp = opts.newHttp ?? null;
    this.sources = opts.sources;
    this.now = opts.now ?? (() => nowMs());
    this.paid = opts.paid ?? null;
    this.offline = opts.offline ?? (() => false);
    this.deadlineMs = opts.resolveDeadlineMs ?? 25_000;
    this.isAddedHook = opts.isAdded ?? null;
    migrateBoards(this.db);
  }

  // ------------------------------------------------------------------ reading

  private prefs(): Map<string, PrefRow> {
    const m = new Map<string, PrefRow>();
    for (const r of this.db.prepare('SELECT * FROM board_prefs').all() as unknown as PrefRow[]) m.set(r.id, r);
    return m;
  }
  private checks(): Map<string, CheckRow> {
    const m = new Map<string, CheckRow>();
    for (const r of this.db.prepare('SELECT * FROM board_checks').all() as unknown as CheckRow[]) m.set(r.id, r);
    return m;
  }
  private pref(id: string): PrefRow | undefined {
    return this.db.prepare('SELECT * FROM board_prefs WHERE id = ?').get(id) as unknown as PrefRow | undefined;
  }
  private check(id: string): CheckRow | undefined {
    return this.db.prepare('SELECT * FROM board_checks WHERE id = ?').get(id) as unknown as CheckRow | undefined;
  }

  private build(id: string, pref: PrefRow | undefined, check: CheckRow | undefined): BoardEntry | null {
    const dir = this.directory.get(id);
    const parts = pref ? { ats: pref.ats as CrawlAtsId, board: pref.board, region: pref.region } : dir ? { ats: dir.ats, board: dir.board.toLowerCase(), region: dir.region } : parseBoardId(id);
    if (!parts) return null;
    const company = pref?.company ?? dir?.company ?? parts.board;
    const state = (check?.state ?? 'not_checked') as BoardState;
    return {
      id, ats: parts.ats, board: parts.board, region: parts.region ?? null, company,
      origin: pref?.added_by_user ? 'user' : 'directory',
      followed: !!pref?.followed, hidden: !!pref?.hidden, disabled: !!pref?.disabled,
      state,
      lastCheckAt: check?.last_check_at ?? null,
      lastSuccessAt: check?.last_success_at ?? null,
      nextCheckAt: check?.next_check_at ?? null,
      openJobs: check && check.last_success_at ? check.open_jobs ?? null : null,
      lastError: check?.last_error ?? null,
    };
  }

  /** Every board in the person's list: directory boards plus the boards they added. */
  entries(): BoardEntry[] {
    const prefs = this.prefs();
    const checks = this.checks();
    const out: BoardEntry[] = [];
    const seen = new Set<string>();
    for (const id of this.directory.ids()) {
      const e = this.build(id, prefs.get(id), checks.get(id));
      if (e) { out.push(e); seen.add(id); }
    }
    for (const [id, p] of prefs) {
      if (seen.has(id)) continue;
      // A choice on a directory board that a newer directory dropped is kept (the person made it).
      const e = this.build(id, p, checks.get(id));
      if (e) out.push(e);
    }
    return out;
  }

  get(id: string): BoardEntry | null {
    const key = id.trim().toLowerCase();
    if (!this.directory.has(key) && !this.pref(key)) return null;
    return this.build(key, this.pref(key), this.check(key));
  }

  list(q: { q?: string; view?: ListView; cursor?: string; limit?: number }): { items: BoardEntry[]; total: number; nextCursor: string | null } {
    const view = q.view ?? 'all';
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 50)));
    let items = this.entries();
    switch (view) {
      case 'followed': items = items.filter((e) => e.followed); break;
      case 'user': items = items.filter((e) => e.origin === 'user'); break;
      case 'hidden': items = items.filter((e) => e.hidden); break;
      case 'disabled': items = items.filter((e) => e.disabled); break;
      case 'failing': items = items.filter((e) => e.state === 'failing' || e.state === 'unreachable' || e.state === 'blocked' || e.state === 'cooldown'); break;
      default: break;
    }
    const words = q.q ? nameWords(q.q) : [];
    const query = { key: words.join(''), words };
    let keyed: Array<{ e: BoardEntry; k: Array<string | number> }>;
    if (q.q && query.key) {
      keyed = [];
      for (const e of items) {
        const w = nameWords(e.company);
        const rank = BoardDirectory.rank(query, { key: w.join(''), words: w, slug: e.board.replace(/[^a-z0-9]/g, '') });
        if (rank !== null) keyed.push({ e, k: [rank, w.join('').length, ATS_ORDER[e.ats] ?? 9, e.id] });
      }
    } else if (q.q) {
      keyed = [];
    } else {
      keyed = items.map((e) => ({ e, k: [nameWords(e.company).join(''), e.id] }));
    }
    keyed.sort((a, b) => cmpKey(a.k, b.k));
    const total = keyed.length;
    let start = 0;
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (!c) throw new BoardError('bad_request', 'The list cursor is not valid.');
      start = keyed.findIndex((x) => cmpKey(x.k, c) > 0);
      if (start < 0) start = total;
    }
    const page = keyed.slice(start, start + limit);
    const more = start + limit < total;
    return { items: page.map((x) => x.e), total, nextCursor: more && page.length ? encodeCursor(page[page.length - 1]!.k) : null };
  }

  /** NDJSON lines of the directory and the person's boards (GET /api/v1/boards/export). Adds source and addresses. */
  *export(): Iterable<string> {
    for (const e of this.entries().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const dir = this.directory.get(e.id) as (ReturnType<BoardDirectory['get']> & { source?: string }) | undefined;
      yield JSON.stringify({
        ...e,
        source: e.origin === 'user' ? 'user' : dir?.source ?? null,
        boardUrl: boardPageUrl(e.ats, e.board, e.region),
        apiUrl: boardApiUrl(e.ats, e.board, e.region),
      }) + '\n';
    }
  }

  /** Boards whose jobs the feed hides (the store lane joins on these). */
  hiddenBoards(): Array<{ ats: string; board: string }> {
    return (this.db.prepare('SELECT ats, board FROM board_prefs WHERE hidden = 1').all() as Array<{ ats: string; board: string }>).map((r) => ({ ats: r.ats, board: r.board }));
  }

  counts(): { total: number; directory: number; user: number; followed: number; hidden: number; disabled: number; byProvider: Record<string, number>; byState: Record<string, number> } {
    const es = this.entries();
    const c = { total: es.length, directory: 0, user: 0, followed: 0, hidden: 0, disabled: 0, byProvider: {} as Record<string, number>, byState: {} as Record<string, number> };
    for (const e of es) {
      if (e.origin === 'user') c.user++; else c.directory++;
      if (e.followed) c.followed++;
      if (e.hidden) c.hidden++;
      if (e.disabled) c.disabled++;
      c.byProvider[e.ats] = (c.byProvider[e.ats] ?? 0) + 1;
      c.byState[e.state] = (c.byState[e.state] ?? 0) + 1;
    }
    return c;
  }

  // ------------------------------------------------------------------ the person's choices

  /** Adds a confirmed board. Throws a conflict when the person already added it. */
  add(input: { ats: CrawlAtsId; board: string; region?: string | null; sourceUrl?: string | null }): BoardEntry {
    if (!isCrawlAts(input.ats)) throw new BoardError('unsupported_source', `jobleft does not read ${String(input.ats)} boards.`);
    if (!this.sources[input.ats]) throw new BoardError('unsupported_source', `jobleft recognises ${PROVIDER_NAMES[input.ats]} boards but cannot read them yet.`);
    const board = String(input.board ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._ -]{0,99}$/.test(board)) throw new BoardError('bad_request', 'That is not a valid board name.');
    const region = input.region ? String(input.region).toLowerCase() : null;
    if (region !== null && region !== 'eu') throw new BoardError('bad_request', 'The only region jobleft knows is "eu".');
    const blocked = unreadableRegion(input.ats, region);
    if (blocked) throw new BoardError('unsupported_source', blocked);
    const id = boardId(input.ats, board, region);
    const now = this.now();
    return inTransaction(this.db, () => {
      const existing = this.pref(id);
      if (existing?.added_by_user) throw new BoardError('conflict', `This board is already in your list (${existing.company}).`);
      const v = this.verified.get(id);
      const fresh = v && Date.now() - v.at < VERIFY_CACHE_MS ? v : undefined;
      const company = fresh?.name ?? existing?.company ?? this.directory.get(id)?.company ?? board;
      const sourceUrl = input.sourceUrl ? String(input.sourceUrl).slice(0, 2048) : null;
      if (existing) {
        this.db.prepare(`UPDATE board_prefs SET added_by_user = 1, followed = 1, hidden = 0, disabled = 0, company = ?,
          added_at = ?, updated_at = ?, source_url = coalesce(?, source_url) WHERE id = ?`).run(company, iso(now), iso(now), sourceUrl, id);
      } else {
        this.db.prepare(`INSERT INTO board_prefs (id, ats, board, region, company, added_by_user, followed, hidden, disabled, added_at, updated_at, source_url)
          VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0, ?, ?, ?)`).run(id, input.ats, board, region, company, iso(now), iso(now), sourceUrl);
      }
      // The paste already checked the board: keep that as its first observed check (true, and dated).
      if (fresh && !this.check(id)) this.writeCheck(id, { ok: true, listed: fresh.openJobs }, now, 0);
      return this.build(id, this.pref(id), this.check(id))!;
    });
  }

  update(id: string, patch: { followed?: boolean; hidden?: boolean; disabled?: boolean }): BoardEntry {
    const key = id.trim().toLowerCase();
    const now = iso(this.now());
    return inTransaction(this.db, () => {
      let p = this.pref(key);
      if (!p) {
        const dir = this.directory.get(key);
        if (!dir) throw new BoardError('not_found', 'There is no board with that id in your list or the directory.');
        this.db.prepare(`INSERT INTO board_prefs (id, ats, board, region, company, added_by_user, followed, hidden, disabled, added_at, updated_at, source_url)
          VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, NULL)`).run(key, dir.ats, dir.board.toLowerCase(), dir.region, dir.company, now);
        p = this.pref(key)!;
      }
      const f = patch.followed === undefined ? p.followed : patch.followed ? 1 : 0;
      const h = patch.hidden === undefined ? p.hidden : patch.hidden ? 1 : 0;
      const d = patch.disabled === undefined ? p.disabled : patch.disabled ? 1 : 0;
      this.db.prepare('UPDATE board_prefs SET followed = ?, hidden = ?, disabled = ?, updated_at = ? WHERE id = ?').run(f, h, d, now, key);
      return this.build(key, this.pref(key), this.check(key))!;
    });
  }

  // ------------------------------------------------------------------ board health

  private writeCheck(id: string, o: CheckOutcome, now: number, storeOpenJobs: number): void {
    const prev = this.check(id);
    const at = iso(now);
    if (o.ok) {
      const hadJobs = (prev?.open_jobs ?? 0) > 0 || storeOpenJobs > 0;
      if (o.listed === 0 && hadJobs) {
        const before = prev?.open_jobs ?? storeOpenJobs;
        this.db.prepare(`INSERT INTO board_checks (id, state, consecutive_failures, last_check_at, last_success_at, next_check_at, open_jobs, last_error, last_outcome)
          VALUES (?, 'failing', ?, ?, ?, NULL, ?, ?, 'empty')
          ON CONFLICT(id) DO UPDATE SET state = 'failing', last_check_at = excluded.last_check_at, next_check_at = NULL,
            last_error = excluded.last_error, last_outcome = 'empty'`)
          .run(id, prev?.consecutive_failures ?? 0, at, prev?.last_success_at ?? null, prev?.open_jobs ?? null,
            `The board listed 0 jobs after listing ${before}. jobleft keeps its jobs until the board confirms they closed.`);
        return;
      }
      this.db.prepare(`INSERT INTO board_checks (id, state, consecutive_failures, last_check_at, last_success_at, next_check_at, open_jobs, last_error, last_outcome)
        VALUES (?, 'live', 0, ?, ?, NULL, ?, NULL, 'ok')
        ON CONFLICT(id) DO UPDATE SET state = 'live', consecutive_failures = 0, last_check_at = excluded.last_check_at,
          last_success_at = excluded.last_success_at, next_check_at = NULL, open_jobs = excluded.open_jobs, last_error = NULL, last_outcome = 'ok'`)
        .run(id, at, at, o.listed);
      return;
    }
    const f = o.hostOutage ? Math.max(1, Math.min(prev?.consecutive_failures ?? 0, UNREACHABLE_AFTER - 1)) : (prev?.consecutive_failures ?? 0) + 1;
    let state: BoardState;
    let next: number | null = null;
    if (o.hostOutage) state = 'failing';
    else if (o.failure === 'robots') { state = 'blocked'; next = now + DAY; }
    else if (o.failure === 'busy' || (o.failure === 'blocked' && o.httpStatus === 429)) {
      // "Slow down": wait at least the time the host asked for (Retry-After), and never less than 15 minutes.
      state = 'blocked';
      next = now + Math.max(o.retryAfterMs ?? 0, 15 * 60_000);
    } else if (o.failure === 'blocked') {
      // "Forbidden": ask again after 6 hours, doubling, at most 7 days.
      state = 'blocked';
      next = now + Math.min(6 * HOUR * 2 ** Math.max(0, f - 1), 7 * DAY);
    } else if (f >= UNREACHABLE_AFTER) { state = 'unreachable'; next = now + backoffMs(f); }
    else state = 'failing';
    this.db.prepare(`INSERT INTO board_checks (id, state, consecutive_failures, last_check_at, last_success_at, next_check_at, open_jobs, last_error, last_outcome)
      VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures,
        last_check_at = excluded.last_check_at, next_check_at = excluded.next_check_at, last_error = excluded.last_error,
        last_outcome = excluded.last_outcome`)
      .run(id, state, f, at, next === null ? null : iso(next), o.message, o.failure);
  }

  /** Records one check (the scheduler calls this after each board). `storeOpenJobs`: open jobs the store keeps for it. */
  recordCheck(id: string, outcome: CheckOutcome, opts: { now?: number; storeOpenJobs?: number } = {}): BoardEntry | null {
    const key = id.trim().toLowerCase();
    this.writeCheck(key, outcome, opts.now ?? this.now(), opts.storeOpenJobs ?? 0);
    return this.get(key);
  }

  /**
   * The boards due for a crawl now: not hidden, not disabled, not in back-off, and (when intervalHours > 0) not
   * checked within the interval. The person's own and followed boards come first, then never-checked boards,
   * then the longest-unchecked, so every board gets its turn and they do not all start at once.
   */
  due(now: number, opts: { intervalHours: number; catchUp: boolean }): BoardRef[] {
    const interval = Math.max(0, opts.intervalHours) * HOUR;
    const rows = this.entries().filter((e) => !e.hidden && !e.disabled && this.sources[e.ats] && !unreadableRegion(e.ats, e.region));
    const picked: Array<{ e: BoardEntry; k: Array<string | number> }> = [];
    for (const e of rows) {
      if (e.nextCheckAt && Date.parse(e.nextCheckAt) > now) continue;
      if (interval > 0 && e.lastCheckAt && !e.nextCheckAt && Date.parse(e.lastCheckAt) + interval > now) continue;
      const mine = e.origin === 'user' || e.followed ? 0 : 1;
      picked.push({ e, k: [mine, e.lastCheckAt ? 1 : 0, e.lastCheckAt ?? '', e.id] });
    }
    picked.sort((a, b) => cmpKey(a.k, b.k));
    return picked.map(({ e }) => ({ ats: e.ats, board: e.board, company: e.company, ...(e.region ? { region: e.region } : {}) }));
  }

  // ------------------------------------------------------------------ pending links (pasted while offline)

  addPending(url: string, reason: string): void {
    this.db.prepare('INSERT OR REPLACE INTO board_pending_links (url, reason, created_at) VALUES (?, ?, ?)').run(url.slice(0, 4096), reason, iso(this.now()));
  }
  listPending(): Array<{ url: string; reason: string; createdAt: string }> {
    return (this.db.prepare('SELECT url, reason, created_at FROM board_pending_links ORDER BY created_at').all() as Array<{ url: string; reason: string; created_at: string }>)
      .map((r) => ({ url: r.url, reason: r.reason, createdAt: r.created_at }));
  }
  removePending(url: string): void { this.db.prepare('DELETE FROM board_pending_links WHERE url = ?').run(url); }

  // ------------------------------------------------------------------ resolve

  private reply(candidates: BoardResolveResponse['candidates'], reason: BoardResolveResponse['reason'], message: string, paid: number | null = null, retryable = false): Answer {
    const a: Answer = { candidates, reason: candidates.length ? null : reason, message, paidLookup: paid === null ? null : { priceMicros: paid } };
    if (retryable) RETRY.add(a);
    return a;
  }

  /** What board is behind a link. Adds nothing. Never contacts a forbidden host. Answers within the deadline. */
  async resolve(url: string, opts: { acceptPaidLookup?: boolean } = {}): Promise<BoardResolveResponse> {
    const accept = !!opts.acceptPaidLookup;
    const deadline = accept ? Math.max(this.deadlineMs, 60_000) : this.deadlineMs;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<BoardResolveResponse>((r) => {
      timer = setTimeout(() => r(this.reply([], 'broken_link',
        `The site did not answer within ${Math.round(deadline / 1000)} seconds. Nothing was added; try again later.`)), deadline);
    });
    try {
      return await Promise.race([this.resolveInner(String(url ?? ''), accept), late]);
    } catch (e) {
      return this.reply([], 'broken_link', `jobleft could not check this link (${(e as Error).message.slice(0, 160)}). Nothing was added.`);
    } finally { clearTimeout(timer); }
  }

  private async resolveInner(input: string, acceptPaid: boolean): Promise<BoardResolveResponse> {
    const d = detectBoardFromUrl(input);
    if (d.kind === 'not_a_link') {
      return this.reply([], 'not_a_link', 'That is not a web link. Paste the address of a careers page or a job page (it starts with https://).');
    }
    if (d.kind === 'forbidden') {
      return this.reply([], 'forbidden_host', `jobleft does not support ${d.provider}. Nothing was sent to ${d.url.hostname}. Paste the employer's own careers page instead.`);
    }
    if (d.kind === 'unsupported') {
      return this.reply([], 'unsupported_provider', `${d.provider} boards are not supported. jobleft reads ${this.supportedList()} boards. Nothing was added.`);
    }
    if (d.kind === 'job_site') {
      return this.reply([], 'unsupported_provider', `${d.provider} is a job search site, not one employer's board. Paste the employer's own careers page instead. Nothing was added.`);
    }
    if (d.kind === 'provider_home') return this.reply([], 'no_board_found', `${d.why} Nothing was added.`);
    if (this.offline()) {
      this.addPending(d.url.href, 'offline');
      return this.reply([], 'offline', 'jobleft is offline, so it could not check this link. The link is kept in your pending links; try again when you are online. Nothing was added.');
    }
    const cacheKey = `${acceptPaid ? 'paid|' : ''}${d.kind === 'board' ? `board|${boardId(d.found.ats, d.found.board, d.found.region)}` : d.url.href}`;
    const hit = this.resolveCache.get(cacheKey);
    if (hit && Date.now() - hit.at < RESOLVE_CACHE_MS) return this.refreshAlreadyAdded(hit.answer);
    const answer = d.kind === 'board' ? await this.answerFor([d.found], d.url.href) : await this.resolvePage(d, acceptPaid);
    if (answer.candidates.length || answer.reason === 'no_board_found' || answer.reason === 'unsupported_provider') {
      if (!answer.paidLookup) this.resolveCache.set(cacheKey, { at: Date.now(), answer });
      if (this.resolveCache.size > 300) this.resolveCache.delete(this.resolveCache.keys().next().value!);
    }
    if (answer.reason === 'offline' || RETRY.has(answer)) this.addPending(d.url.href, answer.reason ?? 'network');
    else this.removePending(d.url.href);
    return answer;
  }

  private refreshAlreadyAdded(a: BoardResolveResponse): BoardResolveResponse {
    return { ...a, candidates: a.candidates.map((c) => ({ ...c, alreadyAdded: this.added(c.boardId) })) };
  }

  /** Whether the person already has this board. */
  private added(id: string): boolean {
    return this.isAddedHook ? this.isAddedHook(id) : !!this.pref(id)?.added_by_user;
  }

  private supportedList(): string {
    const names = (Object.keys(this.sources) as CrawlAtsId[]).filter((a) => this.sources[a]).map((a) => PROVIDER_NAMES[a]);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
  }

  private clientBornAt = Date.now();
  /** The shared polite client. Renewed every 10 minutes when a factory is given, so robots.txt is read again and a
   *  host that refused twice (and was skipped) is asked again later. */
  private client(): HttpClient {
    if (this.newHttp && Date.now() - this.clientBornAt > 10 * 60_000) { this.http = this.newHttp(); this.clientBornAt = Date.now(); }
    return this.http;
  }

  /** Replaces the shared client when it cached a robots.txt fetch that failed for network reasons. */
  private healClient(host: string): void {
    const st = httpStateFor(this.http);
    const r = st?.robots.get(host);
    if (r && r.error && this.newHttp) this.http = this.newHttp();
  }

  /** Verifies candidates and builds the answer. */
  private async answerFor(found: Array<LinkBoard | PageBoard>, from: string, note = ''): Promise<BoardResolveResponse> {
    const uniq = new Map<string, LinkBoard>();
    for (const f of found) {
      const id = boardId(f.ats, f.board, f.region);
      if (!uniq.has(id)) uniq.set(id, f);
    }
    const all = [...uniq.values()].slice(0, MAX_CANDIDATES);
    const regionBlocked = all.filter((f) => unreadableRegion(f.ats, f.region));
    const list = all.filter((f) => !unreadableRegion(f.ats, f.region));
    if (list.length === 0 && regionBlocked.length) {
      return this.reply([], 'unsupported_provider', `${unreadableRegion(regionBlocked[0]!.ats, regionBlocked[0]!.region)} Nothing was sent to it and nothing was added.`);
    }
    const unsupported = list.filter((f) => !this.sources[f.ats]);
    const readable = list.filter((f) => this.sources[f.ats]);
    if (readable.length === 0) {
      const p = PROVIDER_NAMES[unsupported[0]!.ats];
      return this.reply([], 'unsupported_provider', `jobleft recognises this ${p} board but cannot read ${p} boards yet. It reads ${this.supportedList()} boards. Nothing was added.`);
    }
    const results = await Promise.all(readable.map((f) => this.checkCandidate(f)));
    const candidates: BoardResolveResponse['candidates'] = [];
    const missing: string[] = [];
    const problems: string[] = [];
    let robots = false;
    let offline = false;
    // No answer at all from the provider (network down, name lookup failed, connection refused, time-out): nothing
    // proves the board exists, so it is not offered, unless another board of the same link was verified.
    const anyOk = results.some(({ r }) => r.ok);
    const unreached: string[] = [];
    for (const { f, r, region } of results) {
      const id = boardId(f.ats, f.board, region);
      if (!r.ok) {
        if (r.failure === 'not_found') { missing.push(`${PROVIDER_NAMES[f.ats]} board "${f.board}"`); continue; }
        if (r.failure === 'robots') { robots = true; continue; }
        if (r.failure === 'forbidden') continue;
        if (r.failure === 'offline') { offline = true; continue; }
        if ((r.failure === 'network' || r.failure === 'timeout') && !anyOk) { if (!unreached.includes(r.message)) unreached.push(r.message); continue; }
        if (r.failure === 'bad_reply') { missing.push(`${PROVIDER_NAMES[f.ats]} board "${f.board}" (the provider did not answer with job data)`); continue; }
        problems.push(`${PROVIDER_NAMES[f.ats]} board "${f.board}": ${r.message}`);
      }
      const dir = this.directory.get(id);
      const pref = this.pref(id);
      const company = (r.ok ? r.name : null) ?? dir?.company ?? pref?.company ?? f.board;
      candidates.push({ boardId: id, ats: f.ats, board: f.board, region, company, openJobs: r.ok ? r.openJobs : null, alreadyAdded: this.added(id) });
    }
    if (candidates.length === 0) {
      if (offline) return this.reply([], 'offline', 'jobleft could not reach the network, so it could not check this link. The link is kept in your pending links; try again when you are online. Nothing was added.', null, true);
      if (unreached.length) return this.reply([], 'offline', `jobleft could not check this link. ${unreached.join(' ')} The link is kept in your pending links; try again when you are online. Nothing was added.`, null, true);
      if (robots) return this.reply([], 'blocked_by_robots', "The provider's robots.txt does not allow jobleft to read this board, so jobleft did not read it. Nothing was added.");
      if (missing.length) {
        return this.reply([], 'no_board_found', `The link names the ${missing.join(' and the ')}, but the provider answered that it does not exist. Nothing was added.`);
      }
      return this.reply([], 'broken_link', `jobleft could not check the board: ${problems.join(' ')} Nothing was added.`, null, true);
    }
    const parts: string[] = [];
    if (candidates.length === 1) {
      const c = candidates[0]!;
      const jobs = c.openJobs === null ? 'open jobs not known yet' : `${c.openJobs} open job${c.openJobs === 1 ? '' : 's'}`;
      parts.push(`${PROVIDER_NAMES[c.ats]} board "${c.board}"${c.region ? ` (${c.region.toUpperCase()})` : ''}: ${c.company}, ${jobs}.`);
      if (c.alreadyAdded) parts.push('It is already in your boards; nothing new was added.');
      else if (this.directory.has(c.boardId)) parts.push('It is in the jobleft directory. Confirm to add it to your boards.');
      else parts.push('Confirm to add it.');
    } else {
      parts.push(`This page holds ${candidates.length} job boards. Choose the one to add; nothing is added until you confirm.`);
    }
    if (problems.length) parts.push(`jobleft could not check every board right now (${problems.join(' ')}).`);
    if (missing.length) parts.push(`(${missing.join(', ')} named on the page does not exist.)`);
    if (note) parts.push(note);
    void from;
    return this.reply(candidates, null, parts.join(' '));
  }

  /** Checks one candidate; a Lever board that is not on the US host is looked up on the EU host. */
  private async checkCandidate(f: LinkBoard): Promise<{ f: LinkBoard; r: VerifyResult; region: string | null }> {
    const inDir = this.directory.has(boardId(f.ats, f.board, f.region));
    let r = await verifyBoard(f.ats, f.board, f.region, this.client(), this.sources, { wantName: !inDir });
    let region = f.region;
    if (!r.ok && r.failure === 'not_found' && f.ats === 'lever' && f.region === null) {
      const eu = await verifyBoard('lever', f.board, 'eu', this.client(), this.sources, { wantName: !this.directory.has(boardId('lever', f.board, 'eu')) });
      if (eu.ok) { r = eu; region = 'eu'; }
    }
    if (r.ok) this.verified.set(boardId(f.ats, f.board, region), { at: Date.now(), openJobs: r.openJobs, name: r.name });
    // A robots.txt that did not load (network trouble) stays cached in the client: use a fresh client next time.
    else if (r.robotsHost) this.healClient(r.robotsHost);
    return { f, r, region };
  }

  private async resolvePage(first: Extract<UrlDetection, { kind: 'page' }>, acceptPaid: boolean): Promise<BoardResolveResponse> {
    const w = await walkForBoards(first, this.client(), { onRobotsNetworkFailure: (h) => this.healClient(h), maxCandidates: MAX_CANDIDATES });
    if (w.kind === 'boards') return this.answerFor(w.boards, w.pageUrl, w.note);
    if (w.kind === 'cannot') return this.reply([], w.reason, w.message, null, !!w.retryable);
    const hints = new Set(w.hints);
    const blocked = w.blocked;
    // Nothing a plain request can see.
    const hintText = hints.size
      ? `The page uses ${[...hints].map((h) => PROVIDER_NAMES[h]).join(' and ')}, but loads the board by a script that jobleft cannot read without a browser.`
      : blocked ? 'The site refused jobleft\'s plain request (HTTP 403).' : 'jobleft found no job board on this page.';
    const paid = this.paid && this.paid.enabled ? this.paid : null;
    if (paid && acceptPaid) {
      const price = paid.prices().jsPage;
      let res: { url: string; html: string; costMicros: number };
      try {
        res = await paid.fetchPage(first.url.href, { js: true, maxPriceMicros: price });
      } catch (e) {
        return this.reply([], 'no_board_found', `${hintText} The paid page fetch did not return the page (${(e as Error).message.slice(0, 120)}). Nothing was added.`);
      }
      const scan = scanPage(res.html, first.url);
      const spent = `The paid page fetch cost ${priceText(res.costMicros)} from your balance.`;
      if (scan.boards.length) return this.answerFor(scan.boards, first.url.href, spent);
      return this.reply([], 'no_board_found', `The page, read in a browser, holds no job board either. ${spent} Nothing was added.`);
    }
    if (paid) {
      const price = paid.prices().jsPage;
      return this.reply([], 'no_board_found',
        `${hintText} jobleft can open the page in a browser through the paid page fetch for ${priceText(price)} from your publik balance. Nothing is charged unless you accept. Nothing was added.`, price);
    }
    return this.reply([], 'no_board_found', `${hintText} Paste the board's own link (for example a Greenhouse, Lever or Ashby job page) instead. Nothing was added.`);
  }
}
