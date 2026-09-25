// @jobleft/boards: which boards the laptop crawls and when.
//   * the board directory (packages/boards/data/board-directory.json, built from JobSync's MIT lists and checked
//     against each provider) and search in it ("stripe", "Stripe, Inc.")
//   * the person's boards and choices (added by link, follow, hide, disable) in `board_prefs` (owned here);
//     what each check saw lives in `board_checks` (owned here); the crawler's `boards` table stays the crawler's
//   * resolve a careers or job link to a board (preview only; adding needs the person's confirmation), including
//     employer-hosted pages that embed a board and gh_jid links
//   * dead boards: two failed checks in a row make a board unreachable, with a stated next check date; it comes
//     back by itself when it answers again; a person's own boards are never deleted
//   * crawl planning and the scheduler: catch-up on launch, a regular refresh, dead boards backed off
// Interface: docs/INTERFACES.md, section "@jobleft/boards". CLI: src/cli.ts (jobleft-boards). Scripts: scripts/.

export const PACKAGE_NAME = '@jobleft/boards';

export { boardId, parseBoardId, isCrawlAts } from './ids.ts';
export {
  BoardDirectory, BUNDLED_DIRECTORY_PATH, DIRECTORY_FORMAT, PRUNED_DIRECTORY_PATH, installedDirectoryPath, loadActiveDirectory,
  nameKey, nameWords, parseDirectoryFile, readDirectoryFile, toFileRow,
} from './directory.ts';
export type { DirectoryEntry, DirectoryFile, DirectoryFileRow, DirectorySource, DirectoryStatus, LoadedDirectory } from './directory.ts';
export {
  PROVIDER_NAMES, boardApiHost, boardApiUrl, boardPageUrl, detectBoardFromUrl, parseLink,
} from './detect.ts';
export type { LinkBoard, UrlDetection } from './detect.ts';
export { scanPage } from './page.ts';
export type { Evidence, PageBoard, PageScan } from './page.ts';
export { forbiddenProvider, isForbiddenHost, jobSite, unsupportedProvider } from './hosts.ts';
export {
  BusyPacer, ForbiddenHostError, HostBusyError, OfflineError, RedirectLog, SqlitePacer, createBoardHttp, httpStateFor,
  networkCode, offlineFromEnv, redirectLogFor,
} from './http.ts';
export type { BoardHttpOptions, BoardHttpState } from './http.ts';
export { boardSources, unreadableRegion } from './sources.ts';
export { classifyError, verifyBoard } from './verify.ts';
export type { CheckFailure, VerifyResult } from './verify.ts';
export { migrateBoards, SCHEMA_VERSION } from './db.ts';
export { BoardError, BoardService, UNREACHABLE_AFTER, backoffMs, priceText } from './service.ts';
export type { BoardErrorCode, BoardServiceOptions, CheckOutcome, ListView, PaidPageFetcher } from './service.ts';
export { CrawlScheduler, DEFAULT_GRACE_MS, outcomeOf } from './scheduler.ts';
export type { SchedulerOptions } from './scheduler.ts';
export { detectBoard } from './discover.ts';
export type { DetectBoardResult } from './discover.ts';
