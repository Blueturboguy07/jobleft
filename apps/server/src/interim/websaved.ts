// Saved web searches (Jobs > Web jobs > Save search): each one runs by itself every 12 or 24 hours while jobleft
// runs, asks SearXNG for the past week, and hands the job pages it finds to the web reader like any search. Once
// those pages are read, the jobs that came from this run are counted and, if there are any, the person gets one
// alert ("3 new web jobs for ..."), through the same notifications as saved-filter alerts.
//
// A run starts only when nothing else is busy: no crawl, no reading, no other web search. At most one run a tick,
// so at most 10 searches of 4 SearXNG requests twice a day.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WebSavedSearch, WebSavedSearchInput } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import type { WebReader } from './webreader.ts';

export const MAX_SAVED = 10;
const EVERY = new Set([0, 12, 24]);

interface Row { id: string; q: string; place: string | null; every_hours: number; created_at: string; last_run_at: string | null; last_new: number | null; last_error: string | null; counting: number }

export interface WebSavedDeps {
  db: DatabaseSync;
  reader: WebReader;
  /** Runs one search (the route's own work: SearXNG, sorting, queueing for the reader). Throws on failure. */
  search: (req: { q: string; place?: string; timeRange: 'week' }, tag: string) => Promise<void>;
  ready: () => boolean;
  alertsOn: () => boolean;
  notify: (title: string, body: string, dedupeKey: string) => void;
  now?: () => number;
}

export class WebSavedSearches {
  private readonly d: WebSavedDeps;
  private busy = false;

  constructor(d: WebSavedDeps) {
    this.d = d;
    d.db.exec(`CREATE TABLE IF NOT EXISTS srv_web_saved (
      id TEXT PRIMARY KEY,
      q TEXT NOT NULL,
      place TEXT,
      every_hours INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_run_at TEXT,
      last_new INTEGER,
      last_error TEXT,
      counting INTEGER NOT NULL DEFAULT 0
    )`);
  }

  private view(r: Row): WebSavedSearch {
    return { id: r.id, q: r.q, place: r.place, everyHours: r.every_hours, createdAt: r.created_at, lastRunAt: r.last_run_at, lastNew: r.last_new, lastError: r.last_error };
  }

  list(): WebSavedSearch[] {
    return (this.d.db.prepare('SELECT * FROM srv_web_saved ORDER BY created_at').all() as unknown as Row[]).map((r) => this.view(r));
  }

  private row(id: string): Row {
    const r = this.d.db.prepare('SELECT * FROM srv_web_saved WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ApiFailure('not_found', 'That saved web search does not exist.');
    return r;
  }

  /**
   * Saves a search. Its first run is everyHours from now: the person has just seen its results, so only jobs found
   * after that are new.
   */
  add(input: WebSavedSearchInput): WebSavedSearch {
    const every = input.everyHours ?? 24;
    if (!EVERY.has(every)) throw new ApiFailure('bad_request', 'A saved web search runs every 12 or 24 hours, or only by hand (0).');
    const q = input.q.replace(/\s+/g, ' ').trim();
    const place = (input.place ?? '').replace(/\s+/g, ' ').trim() || null;
    const same = this.d.db.prepare('SELECT id FROM srv_web_saved WHERE lower(q) = lower(?) AND lower(coalesce(place, \'\')) = lower(?)').get(q, place ?? '');
    if (same) throw new ApiFailure('conflict', 'This search is saved already.');
    if ((this.d.db.prepare('SELECT count(*) AS n FROM srv_web_saved').get() as { n: number }).n >= MAX_SAVED) {
      throw new ApiFailure('conflict', `You can save up to ${MAX_SAVED} web searches. Delete one first.`);
    }
    const id = randomUUID();
    const now = new Date((this.d.now ?? Date.now)()).toISOString();
    this.d.db.prepare('INSERT INTO srv_web_saved (id, q, place, every_hours, created_at, last_run_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, q, place, every, now, now);
    return this.view(this.row(id));
  }

  update(id: string, everyHours: number): WebSavedSearch {
    if (!EVERY.has(everyHours)) throw new ApiFailure('bad_request', 'A saved web search runs every 12 or 24 hours, or only by hand (0).');
    this.row(id);
    this.d.db.prepare('UPDATE srv_web_saved SET every_hours = ? WHERE id = ?').run(everyHours, id);
    return this.view(this.row(id));
  }

  remove(id: string): void {
    this.row(id);
    this.d.db.prepare('DELETE FROM srv_web_saved WHERE id = ?').run(id);
  }

  /** The tag the reader keeps with the addresses a saved search's run queued. */
  static tag(id: string): string { return `saved:${id}`; }

  /**
   * One step: counts a finished run's new jobs (once the reader is idle), else starts the most overdue search.
   * Called every few minutes; does nothing while anything else is busy.
   */
  async tick(): Promise<void> {
    if (this.busy || !this.d.ready()) return;
    this.busy = true;
    try {
      const st = this.d.reader.status();
      const counting = this.d.db.prepare('SELECT * FROM srv_web_saved WHERE counting = 1').all() as unknown as Row[];
      if (counting.length) {
        if (st.running || st.queued > 0) return;
        for (const r of counting) this.count(r);
        return;
      }
      if (st.running || st.queued > 0) return;
      const now = (this.d.now ?? Date.now)();
      const due = (this.d.db.prepare('SELECT * FROM srv_web_saved WHERE every_hours > 0').all() as unknown as Row[])
        .filter((r) => !r.last_run_at || Date.parse(r.last_run_at) + r.every_hours * 3600_000 <= now)
        .sort((a, b) => (a.last_run_at ?? '').localeCompare(b.last_run_at ?? ''))[0];
      if (!due) return;
      const at = new Date(now).toISOString();
      this.d.db.prepare('UPDATE srv_web_saved SET last_run_at = ?, last_error = NULL WHERE id = ?').run(at, due.id);
      try {
        await this.d.search({ q: due.q, ...(due.place ? { place: due.place } : {}), timeRange: 'week' }, WebSavedSearches.tag(due.id));
        this.d.db.prepare('UPDATE srv_web_saved SET counting = 1 WHERE id = ?').run(due.id);
      } catch (e) {
        this.d.db.prepare('UPDATE srv_web_saved SET last_error = ? WHERE id = ?').run(e instanceof Error ? e.message.slice(0, 300) : 'The search failed.', due.id);
      }
    } finally { this.busy = false; }
  }

  /** The jobs this run added (its addresses, read since it started), and the alert when there are any. */
  private count(r: Row): void {
    const n = (this.d.db.prepare("SELECT count(*) AS n FROM srv_web_results WHERE query = ? AND state = 'job' AND read_at >= ?")
      .get(WebSavedSearches.tag(r.id), r.last_run_at ?? '') as { n: number }).n;
    this.d.db.prepare('UPDATE srv_web_saved SET counting = 0, last_new = ? WHERE id = ?').run(n, r.id);
    if (n > 0 && this.d.alertsOn()) {
      const what = r.place ? `${r.q}, ${r.place}` : r.q;
      this.d.notify(`${n} new web job${n === 1 ? '' : 's'} for "${what}"`, 'Open Jobs > Web jobs to see them.', `websaved:${r.id}:${r.last_run_at}`);
    }
  }
}
