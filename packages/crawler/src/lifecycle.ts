// Close-vanished logic, ported from freehire internal/ingest/pipeline/board_scope.go and cooldown.go,
// and from cmd/ingest/main.go (sweepableProviders, shouldSweep, DefaultSweepGrace).
// Pure functions, so the guard is unit-tested without a network or a database.
//
// The rule in one line: a posting may be closed for being absent only when this run PROVED it read the
// whole board. A board that failed, returned nothing, or could not read what it listed proves nothing.

import type { BoardStats } from './types.ts';

/** Unseen for this long, and the board was proven covered, then the posting is closed (freehire DefaultSweepGrace). */
export const DEFAULT_SWEEP_GRACE_MS = 48 * 3600 * 1000;
/** More than this share of listed postings unreadable and the crawl is not evidence of what is on the board. */
export const MAX_UNREADABLE_PERCENT = 5;

export const COOLDOWN_THRESHOLD = 3;
export const COOLDOWN_BASE_MS = 6 * 3600 * 1000;
export const COOLDOWN_MAX_MS = 24 * 3600 * 1000;

/** Exponential backoff after repeated board failures: none below 3, then 6h * 2^(f-3), capped at 24h. Never permanent. */
export function cooldownFor(consecutiveFailures: number): number | null {
  if (consecutiveFailures < COOLDOWN_THRESHOLD) return null;
  const shift = consecutiveFailures - COOLDOWN_THRESHOLD;
  const d = shift >= 30 ? COOLDOWN_MAX_MS : COOLDOWN_BASE_MS * 2 ** shift;
  return Math.min(d, COOLDOWN_MAX_MS);
}

export function emptyStats(): BoardStats {
  return { ingested: 0, inserted: 0, updated: 0, unchanged: 0, dupUrl: 0, dupRole: 0, skipped: 0, rejected: 0, unreadable: 0, failed: 0 };
}

/**
 * The crawl reached at least one posting and something downstream decided what to do with it.
 * `skipped` is deliberately excluded: it means listed-then-failed-to-persist, and counting it would let a
 * board whose every save fails prove itself with its own failures. A posting dropped as a duplicate URL
 * counts (freehire counts ATSCovered the same way).
 */
export function boardReachedPostings(st: BoardStats): boolean {
  return st.ingested + st.rejected + st.dupUrl > 0;
}

/**
 * The LISTING named at least one posting, whatever became of it. This stamps `last_yield_at`, and it is the
 * generous reading on purpose: false accumulates into "this feed is empty" and eventually closes jobs.
 */
export function boardListedAnyPosting(st: BoardStats): boolean {
  return st.ingested + st.rejected + st.dupUrl + st.skipped + st.unreadable > 0;
}

/** The crawl actually READ the postings it listed, within MAX_UNREADABLE_PERCENT. */
export function boardReadWhatItListed(st: BoardStats): boolean {
  const listed = st.ingested + st.rejected + st.dupUrl + st.skipped + st.unreadable;
  return st.unreadable * 100 <= listed * MAX_UNREADABLE_PERCENT;
}

/**
 * A run structurally PROVED it covered a board. All three conditions read this board's own stats:
 *  1. zero failures
 *  2. it reached at least one posting (an empty answer is indistinguishable from a silently broken crawl)
 *  3. it read what it listed (at most 5% unreadable)
 * A board with an empty name never qualifies.
 */
export function boardQualifies(board: string, st: BoardStats): boolean {
  return board !== '' && st.failed === 0 && boardReachedPostings(st) && boardReadWhatItListed(st);
}

/** A provider that ingested nothing proves only that its crawl failed, so it must not sweep at all. */
export function shouldSweep(providerIngested: number): boolean {
  return providerIngested > 0;
}

export interface SweepCandidate { ats: string; board: string; stats: BoardStats; fullBoardListing: boolean }

/**
 * Which boards may close by absence this run. Requires: the provider ingested something, the adapter is a
 * `fullBoardListing` source, and the board qualifies. A board name that appears under two regions is
 * ambiguous and never qualifies (its close pattern cannot tell which region proved coverage).
 */
export function sweepableBoards(cands: SweepCandidate[]): SweepCandidate[] {
  const providerIngested = new Map<string, number>();
  const regionsPerBoard = new Map<string, number>();
  for (const c of cands) {
    providerIngested.set(c.ats, (providerIngested.get(c.ats) ?? 0) + c.stats.ingested);
    const k = `${c.ats}\u0000${c.board}`;
    regionsPerBoard.set(k, (regionsPerBoard.get(k) ?? 0) + 1);
  }
  return cands.filter((c) =>
    c.fullBoardListing &&
    shouldSweep(providerIngested.get(c.ats) ?? 0) &&
    (regionsPerBoard.get(`${c.ats}\u0000${c.board}`) ?? 0) === 1 &&
    boardQualifies(c.board, c.stats));
}

/**
 * The empty-feed net. A board that answers cleanly with ZERO postings never qualifies above (an empty answer
 * proves nothing), so its old postings would stay open forever. Once the board has listed nothing for the whole
 * window (freehire ListEmptyFeedBoards) close them. `lastYieldAt` is the last time its listing named any posting.
 * Local addition: also require `minStreak` consecutive clean-but-empty crawls. A laptop that was asleep for a
 * week and then gets one empty answer (an API glitch) must not close a whole board.
 */
export const EMPTY_FEED_MIN_STREAK = 3;
export function emptyFeedShouldClose(
  lastYieldAt: string | null, nowMs: number, emptyFeedMs: number, emptyStreak: number, minStreak = EMPTY_FEED_MIN_STREAK,
): boolean {
  if (!lastYieldAt || emptyStreak < minStreak) return false;
  const t = Date.parse(lastYieldAt);
  return Number.isFinite(t) && nowMs - t >= emptyFeedMs;
}

/** Local addition, not in freehire: never close more than this share of a board's open jobs in one sweep. */
export const MAX_CLOSE_SHARE = 0.5;
export function closeTooBroad(openBefore: number, wouldClose: number, minOpen = 10): boolean {
  return openBefore >= minOpen && wouldClose / openBefore > MAX_CLOSE_SHARE;
}
