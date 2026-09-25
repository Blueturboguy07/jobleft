// @jobleft/boards: which boards the laptop crawls and when.
//   * the board directory (shipped rows from @jobleft/static-data) and search in it ("stripe", "Stripe, Inc.")
//   * the user's boards and choices (added by link, follow, hide, disable) in `board_prefs` (owned here);
//     board health lives in the crawler's `boards` table
//   * resolve a careers or job link to a board (preview only; adding needs the person's confirmation)
//   * crawl planning and the scheduler: catch-up on launch, a regular refresh, dead boards backed off
// Status: interface stubs (foundation), except boardId. Bodies throw until the boards lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/boards".

import type { DatabaseSync } from 'node:sqlite';
import type {
  BoardEntry, BoardResolveResponse, CrawlAtsId, CrawlBoardReport, CrawlProgress, CrawlRunSummary,
} from '@jobleft/contracts';
import type { BoardRef, HttpClient, SourceRegistry, Store } from '@jobleft/crawler';
import type { DirectoryRow } from '@jobleft/static-data';

export const PACKAGE_NAME = '@jobleft/boards';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/boards)`);
}

/** "<ats>:<board>" or "<ats>:<region>:<board>", lower case (BoardEntry.id). */
export function boardId(ats: CrawlAtsId, board: string, region?: string | null): string {
  const b = board.trim().toLowerCase();
  return region ? `${ats}:${region.toLowerCase()}:${b}` : `${ats}:${b}`;
}

export class BoardDirectory {
  constructor(rows: DirectoryRow[]) { void rows; }
  get size(): number { return notImplemented('BoardDirectory.size'); }
  /** Case-, accent- and suffix-insensitive company search; the same entry comes first for "stripe" and "Stripe, Inc.". */
  search(q: string, limit?: number): DirectoryRow[] { return notImplemented('BoardDirectory.search'); }
  get(id: string): DirectoryRow | undefined { return notImplemented('BoardDirectory.get'); }
}

export interface BoardServiceOptions {
  db: DatabaseSync;
  directory: BoardDirectory;
  /** The polite client: every paste and every refresh shares its pacer (1 request per second per host). */
  http: HttpClient;
  sources: SourceRegistry;
  now?: () => number;
}

export class BoardService {
  constructor(opts: BoardServiceOptions) { void opts; }
  list(q: { q?: string; view?: 'all' | 'followed' | 'user' | 'hidden' | 'disabled' | 'failing'; cursor?: string; limit?: number }): { items: BoardEntry[]; total: number; nextCursor: string | null } {
    return notImplemented('BoardService.list');
  }
  /** What board is behind a link. Adds nothing. Never contacts a never-crawl host. */
  async resolve(url: string, opts?: { acceptPaidLookup?: boolean }): Promise<BoardResolveResponse> { return notImplemented('BoardService.resolve'); }
  /** Adds a confirmed board. Throws a conflict when it is already in the list. */
  add(input: { ats: CrawlAtsId; board: string; region?: string | null }): BoardEntry { return notImplemented('BoardService.add'); }
  update(id: string, patch: { followed?: boolean; hidden?: boolean; disabled?: boolean }): BoardEntry { return notImplemented('BoardService.update'); }
  /** NDJSON lines of the directory and the user boards (GET /api/v1/boards/export). */
  export(): Iterable<string> { return notImplemented('BoardService.export'); }
  /** The boards due for a crawl now (not hidden, not disabled, not in back-off), spread so they do not all start at once. */
  due(now: number, opts: { intervalHours: number; catchUp: boolean }): BoardRef[] { return notImplemented('BoardService.due'); }
}

export interface SchedulerOptions {
  boards: BoardService;
  crawlStore: Store;
  http: HttpClient;
  sources: SourceRegistry;
  intervalHours: () => number;
  now?: () => number;
  /** Called after each board and at the end, so new jobs are findable at once. */
  onProgress?: (p: CrawlProgress) => void;
}

/** Runs crawls: a catch-up on launch, then every intervalHours while the app or the tray runs. */
export class CrawlScheduler {
  constructor(opts: SchedulerOptions) { void opts; }
  start(opts: { catchUp: boolean }): void { notImplemented('CrawlScheduler.start'); }
  stop(): Promise<void> { return notImplemented('CrawlScheduler.stop'); }
  runNow(boardIds?: string[]): { started: boolean; message: string; nextAllowedAt: string | null } { return notImplemented('CrawlScheduler.runNow'); }
  progress(): CrawlProgress { return notImplemented('CrawlScheduler.progress'); }
  lastReport(): { run: CrawlRunSummary | null; boards: CrawlBoardReport[] } { return notImplemented('CrawlScheduler.lastReport'); }
}
