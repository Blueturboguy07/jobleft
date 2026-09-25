// Which job is this page? The extension sends only the page address. The match uses the page key (apps/extension
// `pageKey`): tracking parameters are ignored, a job id in the path or in a query parameter is kept, so the same
// title at two companies stays two jobs and one job opened from two links stays one.
//
// The answer is a job id, or null. When two different jobs claim the same page key the answer is null: the panel says
// "unknown" rather than name the wrong company. An open job wins over a closed one with the same key.
//
// The index is built from the crawler's `jobs` table (owner: crawler) and rebuilt when a row is added. Building it for
// 60,000 rows takes well under a second; a lookup is a map read.

import type { DatabaseSync } from 'node:sqlite';
import { pageKey } from '@jobleft/extension';
import { makeJobId } from '@jobleft/store';

interface Row { ats: string; board: string; job_id: string; closed_at: string | null; [url: string]: unknown }

export class PageMatcher {
  private readonly db: DatabaseSync;
  private stamp = '';
  private index = new Map<string, Array<{ id: string; open: boolean }>>();
  private urlColumns: string[] | null = null;

  constructor(db: DatabaseSync) { this.db = db; }

  private columns(): string[] {
    if (this.urlColumns) return this.urlColumns;
    const have = new Set((this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((c) => c.name));
    this.urlColumns = ['canonical_url', 'apply_url', 'page_url', 'apply_link'].filter((c) => have.has(c));
    return this.urlColumns;
  }

  private refresh(): void {
    const cols = this.columns();
    if (cols.length === 0) { this.index = new Map(); return; }
    const head = this.db.prepare('SELECT count(*) AS n, coalesce(max(id), 0) AS m, count(closed_at) AS c FROM jobs').get() as { n: number; m: number; c: number };
    const stamp = `${head.n}:${head.m}:${head.c}`;
    if (stamp === this.stamp) return;
    const next = new Map<string, Array<{ id: string; open: boolean }>>();
    const rows = this.db.prepare(`SELECT ats, board, job_id, closed_at, ${cols.join(', ')} FROM jobs`).all() as unknown as Row[];
    for (const r of rows) {
      const id = makeJobId(r.ats, r.board, r.job_id);
      const keys = new Set<string>();
      for (const c of cols) {
        const u = r[c];
        if (typeof u === 'string' && u) { const k = pageKey(u); if (k) keys.add(k); }
      }
      for (const k of keys) {
        const list = next.get(k) ?? [];
        list.push({ id, open: r.closed_at === null });
        next.set(k, list);
      }
    }
    this.index = next;
    this.stamp = stamp;
  }

  /** The job id of a page address, or null (no job, or more than one job claims the page). */
  find(pageUrl: string): string | null {
    const key = pageKey(pageUrl);
    if (!key) return null;
    this.refresh();
    const hits = this.index.get(key);
    if (!hits || hits.length === 0) return null;
    const open = hits.filter((h) => h.open);
    const pool = open.length > 0 ? open : hits;
    const ids = new Set(pool.map((h) => h.id));
    return ids.size === 1 ? [...ids][0]! : null;
  }
}
