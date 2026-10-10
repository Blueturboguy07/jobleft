// Reads the job pages a web search found, in the background, so they show as job cards (Jobs > Web search). Each
// result is read once, through add by link's read (a board job from its board's feed or API, any other page once,
// robots.txt and the never-contact list obeyed), and saved as a job of the source "external:web". The address is
// remembered with what came of it, so a later search never reads it again.
//
// One request a second per host (one pacer for every read), one read at a time, and nothing while the boards are
// being refreshed: the crawl has its own pacer, and the two must never ask one host together.

import type { DatabaseSync } from 'node:sqlite';
import { HttpClient, Pacer, type Store } from '@jobleft/crawler';
import { nowIso, type WebReadStatus, type WebSearchResult } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { knownJobFor, otherBoardJobOf, readJobLink, storeExternal } from './external.ts';

/** What came of one address: a job (its id), closed, refused (robots.txt, never-contact) or failed (try later). */
type State = 'queued' | 'job' | 'closed' | 'refused' | 'failed' | 'not_job';

/** A failed read is tried again after this long; the other outcomes are final. */
const RETRY_FAILED_MS = 24 * 3600_000;
/** At most this many addresses wait at once; a search adds its own results to the end. */
const MAX_QUEUE = 300;
/**
 * A web job is read once, so nothing notices when it closes. One the person has not liked, applied to or added
 * leaves the list this long after it was found (a search that finds it again keeps it).
 */
export const WEB_JOB_DAYS = 30;

export interface WebReaderDeps {
  crawlStore: Store;
  hostMap: Record<string, string>;
  offline: () => boolean;
  /** true while the boards are being refreshed (the reader waits). */
  crawling: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export class WebReader {
  private readonly d: WebReaderDeps;
  private readonly db: DatabaseSync;
  private readonly pacer = new Pacer(1000);
  private running = false;
  private stopped = false;
  private stats = { read: 0, added: 0, closed: 0, failed: 0 };

  constructor(d: WebReaderDeps) {
    this.d = d;
    this.db = d.crawlStore.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS srv_web_results (
      url TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      job_id TEXT,
      message TEXT,
      query TEXT,
      found_at TEXT NOT NULL,
      read_at TEXT
    )`);
  }

  /**
   * Notes what is already known about each result (a job jobleft has, or one it found closed) and queues the job
   * pages it has not read. Returns the results with `jobId` filled in where known.
   */
  enqueue(results: WebSearchResult[], query: string): WebSearchResult[] {
    const now = nowIso();
    this.expire();
    const out: WebSearchResult[] = [];
    const get = this.db.prepare('SELECT state, job_id, message, read_at FROM srv_web_results WHERE url = ?');
    const put = this.db.prepare(`INSERT INTO srv_web_results (url, state, query, found_at) VALUES (?, 'queued', ?, ?)
      ON CONFLICT(url) DO UPDATE SET state = 'queued', query = excluded.query`);
    const queued = (this.db.prepare("SELECT count(*) AS n FROM srv_web_results WHERE state = 'queued'").get() as { n: number }).n;
    let room = MAX_QUEUE - queued;
    for (const r of results) {
      if (r.kind !== 'board_job' && r.kind !== 'page') { out.push(r); continue; }
      if (r.jobId) { out.push(r); continue; }
      const row = get.get(r.url) as { state: State; job_id: string | null; message: string | null; read_at: string | null } | undefined;
      if (row?.state === 'job' && row.job_id) {
        // Found again: still listed somewhere, so it stays (its time starts again).
        this.db.prepare("UPDATE jobs SET last_seen = ? WHERE ats = 'external' AND board = 'web' AND job_id = ? AND closed_at IS NULL").run(now, row.job_id.split(':').slice(2).join(':'));
        out.push({ ...r, jobId: row.job_id });
        continue;
      }
      if (row && row.state !== 'failed') { out.push({ ...r, note: row.state === 'queued' ? null : row.message }); continue; }
      if (row?.state === 'failed' && row.read_at && Date.parse(row.read_at) + RETRY_FAILED_MS > Date.now()) { out.push({ ...r, note: row.message }); continue; }
      if (room-- > 0) put.run(r.url, query.slice(0, 300), now);
      out.push(r);
    }
    void this.run();
    return out;
  }

  /** Closes the web jobs not found again for WEB_JOB_DAYS that the person did not act on. Returns how many. */
  expire(now = Date.now()): number {
    const before = new Date(now - WEB_JOB_DAYS * 86_400_000).toISOString();
    const r = this.db.prepare(`UPDATE jobs SET closed_at = ?, closed_reason = 'expired'
      WHERE ats = 'external' AND board = 'web' AND closed_at IS NULL AND last_seen < ?
        AND ('external:web:' || job_id) NOT IN (SELECT job_id FROM srv_tracker WHERE liked = 1 OR external = 1 OR status IS NOT NULL)`).run(new Date(now).toISOString(), before);
    return Number(r.changes);
  }

  status(): WebReadStatus {
    const n = (s: State) => (this.db.prepare('SELECT count(*) AS n FROM srv_web_results WHERE state = ?').get(s) as { n: number }).n;
    return { running: this.running, queued: n('queued'), ...this.stats, jobs: n('job') };
  }

  stop(): void { this.stopped = true; }

  private async run(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    try {
      for (;;) {
        if (this.stopped || this.d.offline()) break;
        if (this.d.crawling()) { await sleep(2000); continue; }
        const next = this.db.prepare("SELECT url, query FROM srv_web_results WHERE state = 'queued' ORDER BY found_at, rowid LIMIT 1").get() as { url: string; query: string } | undefined;
        if (!next) break;
        await this.readOne(next.url);
      }
    } finally { this.running = false; }
  }

  private async readOne(url: string): Promise<void> {
    const set = (state: State, jobId: string | null, message: string | null) => this.db.prepare('UPDATE srv_web_results SET state = ?, job_id = ?, message = ?, read_at = ? WHERE url = ?').run(state, jobId, message, nowIso(), url);
    let u: URL;
    try { u = new URL(url); } catch { set('refused', null, 'Not a web address.'); return; }
    this.stats.read++;
    const known = knownJobFor(this.d.crawlStore, u);
    if (known) { set('job', known, null); return; }
    // A paged feed (Teamtailor, Workable) can take several requests for one board.
    const http = new HttpClient({ hostMap: this.d.hostMap, pacer: this.pacer, timeoutMs: 10_000, retries: 0, maxRequests: otherBoardJobOf(u) ? 12 : 3 });
    try {
      const raw = await readJobLink(u, { crawlStore: this.d.crawlStore }, http, { needPosting: true });
      const id = storeExternal(this.d.crawlStore, raw, 'web');
      this.stats.added++;
      set('job', id, null);
    } catch (e) {
      const f = e instanceof ApiFailure ? e : null;
      if (f?.code === 'not_found') { this.stats.closed++; set('closed', null, f.message); return; }
      if (f?.code === 'forbidden_source') { set('refused', null, f.message); return; }
      if (f?.code === 'unsupported_source' && /does not look like a job posting|no job title/.test(f.message)) { set('not_job', null, f.message); return; }
      this.stats.failed++;
      set('failed', null, f?.message ?? 'The page could not be read.');
    }
  }
}
