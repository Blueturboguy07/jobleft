// @jobleft/store: the one SQLite database of the app ($JOBLEFT_HOME/data/jobleft.db, node:sqlite, WAL).
//   * opens the file (16 KB pages on a new file, WAL, foreign keys) and runs every migration in order
//   * maps crawl rows (tables owned by @jobleft/crawler) to contract Jobs
//   * job search: FTS5 words + filters + three sorts, true totals, stable cursors (spike S2 method)
//   * fit indexing: float16 vectors per job content hash, filter first, brute-force cosine in RAM
//   * the user's records: tracker, saved filters, profile, chats, notifications, app settings
// Status: interface stubs (foundation), except openDatabase and makeJobId. Bodies throw until the store lane
// implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/store".

import { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings, ChatThread, Embedder, FitIndexStatus, Job, JobSearchRequest, JobSearchResponse, Notification, Profile,
  ProfileInput, SavedFilter, StorageInfo, TrackerEntry, TrackerList, TrackerPatch, TrackerStatus, TrackerView,
} from '@jobleft/contracts';
import type { H1bIndex, PlaceIndex } from '@jobleft/static-data';

export const PACKAGE_NAME = '@jobleft/store';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/store)`);
}

/**
 * Opens (or creates) the database. A new file gets `page_size = 16384` before any table (spike S2), then WAL,
 * `synchronous = NORMAL` and `foreign_keys = ON`. Migrations are the store lane's (see migrate()).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const fresh = (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number }).n === 0;
  if (fresh) db.exec('PRAGMA page_size = 16384');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * Runs the store's migrations (forward only, one transaction each, recorded in `schema_migrations`).
 * A newer file than this build knows is refused with a plain error and left untouched (server O12).
 */
export function migrate(db: DatabaseSync): { from: number; to: number } { return notImplemented('migrate'); }

/** The contract job id of a crawled posting: "<ats>:<board>:<externalId>", lower-case ATS and board. */
export function makeJobId(ats: string, board: string, externalId: string): string {
  return `${ats.toLowerCase()}:${board.toLowerCase()}:${externalId}`;
}

export interface SearchContext {
  /** The profile vector for Top Matched; null = no profile (the answer says fit needs a profile). */
  profileVector: Float32Array | null;
  h1b: H1bIndex;
  places: PlaceIndex;
  now: number;
}

/** Reads jobs (crawler tables + the store's side tables) as contract Jobs. */
export class JobStore {
  constructor(db: DatabaseSync) { void db; }
  get(id: string): Job | null { return notImplemented('JobStore.get'); }
  /** Search with words, filters and a sort. Closed, hidden and duplicate jobs never appear or count. */
  search(req: JobSearchRequest, ctx: SearchContext): JobSearchResponse { return notImplemented('JobStore.search'); }
  /** Saves a job added by URL or text (External tab). Returns the stored job. */
  saveExternal(job: Job): Job { return notImplemented('JobStore.saveExternal'); }
  /** NDJSON lines of saved jobs with their source credits (GET /api/v1/export/jobs). */
  exportSaved(): Iterable<string> { return notImplemented('JobStore.exportSaved'); }
  storage(dbPath: string, dataDir: string): StorageInfo { return notImplemented('JobStore.storage'); }
}

export class TrackerStore {
  constructor(db: DatabaseSync) { void db; }
  get(jobId: string): TrackerEntry | null { return notImplemented('TrackerStore.get'); }
  list(view: TrackerView, status?: TrackerStatus): TrackerList { return notImplemented('TrackerStore.list'); }
  /** Applies a patch in one transaction (status and its history entry together). */
  patch(jobId: string, patch: TrackerPatch, now: number): TrackerEntry { return notImplemented('TrackerStore.patch'); }
}

export class FilterStore {
  constructor(db: DatabaseSync) { void db; }
  list(): SavedFilter[] { return notImplemented('FilterStore.list'); }
  create(input: Pick<SavedFilter, 'name' | 'filter' | 'sort'> & { alert?: boolean }, now: number): SavedFilter { return notImplemented('FilterStore.create'); }
  update(id: string, input: Pick<SavedFilter, 'name' | 'filter' | 'sort'> & { alert?: boolean }, now: number): SavedFilter { return notImplemented('FilterStore.update'); }
  delete(id: string): boolean { return notImplemented('FilterStore.delete'); }
}

export class ProfileStore {
  constructor(db: DatabaseSync) { void db; }
  /** The one profile (an empty one on a fresh install). */
  get(): Profile { return notImplemented('ProfileStore.get'); }
  /** Replaces the editable part; the store sets version and updatedAt. */
  put(input: ProfileInput, version: string, now: number): Profile { return notImplemented('ProfileStore.put'); }
}

export class ChatStore {
  constructor(db: DatabaseSync) { void db; }
  list(): Array<Pick<ChatThread, 'id' | 'title' | 'jobId' | 'updatedAt'>> { return notImplemented('ChatStore.list'); }
  get(id: string): ChatThread | null { return notImplemented('ChatStore.get'); }
  append(id: string | null, message: ChatThread['messages'][number], meta: { jobId: string | null; now: number }): ChatThread { return notImplemented('ChatStore.append'); }
  delete(id: string): boolean { return notImplemented('ChatStore.delete'); }
}

export class NotificationStore {
  constructor(db: DatabaseSync) { void db; }
  add(n: Omit<Notification, 'id' | 'createdAt'>, now: number): Notification { return notImplemented('NotificationStore.add'); }
  pending(): Notification[] { return notImplemented('NotificationStore.pending'); }
  ack(id: string): boolean { return notImplemented('NotificationStore.ack'); }
}

export class SettingsStore {
  constructor(db: DatabaseSync) { void db; }
  get(): AppSettings { return notImplemented('SettingsStore.get'); }
  put(s: AppSettings): AppSettings { return notImplemented('SettingsStore.put'); }
  /** Key-value rows for other packages' small settings (for example the key-free AI settings). */
  getJson<T>(key: string): T | null { return notImplemented('SettingsStore.getJson'); }
  setJson(key: string, value: unknown): void { notImplemented('SettingsStore.setJson'); }
}

/** Fit indexing: vectors per (job content hash, model). Never repeats work on an unchanged job (store O10). */
export class FitIndex {
  constructor(db: DatabaseSync, embedder: Embedder | null) { void db; void embedder; }
  status(): FitIndexStatus { return notImplemented('FitIndex.status'); }
  /** Embeds up to `limit` waiting jobs (newest first, those that pass the user's hard filters first). */
  async runOnce(limit?: number, signal?: AbortSignal): Promise<{ indexed: number }> { return notImplemented('FitIndex.runOnce'); }
  /** Embeds the profile text for Top Matched. */
  async profileVector(text: string): Promise<Float32Array> { return notImplemented('FitIndex.profileVector'); }
}
