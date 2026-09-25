// Writes: upsert postings (with dedupe), close postings, refresh one board's complete listing, company facts.
// Every write runs in a transaction and stamps its rows with a new change number (rev).
//
// Dedupe rules (store O6):
//  * the same job id, the same canonical link (tracking parameters removed, job-id parameters such as gh_jid kept),
//    or the same ATS posting id (Greenhouse, Lever and Ashby ids are global) = the same posting;
//  * the same company key, title, places and description = the same posting seen through another source, unless
//    the two carry different posting ids of one family, or both links are different pages of one site;
//  * a second copy never becomes a second row: its id becomes an alias of the first row and its source is added.

import type { DatabaseSync } from 'node:sqlite';
import type { Job, SourceAttribution } from '@jobleft/contracts';
import { canonicalizeUrl } from '@jobleft/crawler';
import { decodeRecord, encodeRecord } from './codec.ts';
import { nextRev, tx, q } from './db.ts';
import {
  boardScopeOf, companyKeyOf, contentHashOf, embedHashOf, embedTextOf, extraTextOf, facetsOf, keysOf, packFacets,
  precedenceOf,
} from './record.ts';
import { indexText, localCompanyKey } from './text.ts';

export interface UpsertStats {
  inserted: number;
  updated: number;
  unchanged: number;
  merged: number;
  reopened: number;
  closed: number;
  /** Closed rows removed because nobody tracks them (liked, applied, noted or hidden rows are kept). */
  purged: number;
}

export function emptyStats(): UpsertStats {
  return { inserted: 0, updated: 0, unchanged: 0, merged: 0, reopened: 0, closed: 0, purged: 0 };
}

export interface CompanyInput {
  name?: string;
  key?: string;
  industries?: string[];
  stage?: 'early' | 'growth' | 'late' | 'public' | null;
  isStaffingAgency?: boolean | null;
  h1b?: 'likely' | 'some_history' | null;
}

/** Rows per transaction in bulk writes: a crash loses at most one chunk, and readers are never blocked for long. */
export const CHUNK = 2_000;

interface ExistingRow {
  rid: number;
  id: string;
  status: number;
  content_hash: string;
  precedence: number;
  first_seen: string;
  doc: Uint8Array;
}

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function mergeSources(a: SourceAttribution[], b: SourceAttribution[]): SourceAttribution[] {
  const out = a.map((s) => ({ ...s }));
  for (const s of b) {
    const same = out.find((x) => x.sourceId === s.sourceId && canonicalizeUrl(x.url) === canonicalizeUrl(s.url));
    if (same) {
      if (s.lastSeenAt > same.lastSeenAt) same.lastSeenAt = s.lastSeenAt;
      if (s.firstSeenAt < same.firstSeenAt) same.firstSeenAt = s.firstSeenAt;
    } else out.push({ ...s });
  }
  return out;
}

export class JobWriter {
  private readonly tagCache = new Map<string, number>();

  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  /** The id of an interned tag, creating it when new. Ids never change. */
  tagId(tag: string): number {
    const hit = this.tagCache.get(tag);
    if (hit !== undefined) return hit;
    let r = q(this.db, 'INSERT INTO facet_tags (tag) VALUES (?) ON CONFLICT (tag) DO NOTHING RETURNING id').get(tag) as { id: number } | undefined;
    if (!r) r = q(this.db, 'SELECT id FROM facet_tags WHERE tag = ?').get(tag) as { id: number };
    const id = Number(r.id);
    this.tagCache.set(tag, id);
    return id;
  }

  private ridForKey(key: string): number | null {
    const r = q(this.db, 'SELECT rid FROM job_keys WHERE key = ?').get(key) as { rid: number } | undefined;
    return r ? Number(r.rid) : null;
  }

  private addKey(key: string, rid: number): void {
    q(this.db, 'INSERT OR IGNORE INTO job_keys (key, rid) VALUES (?, ?)').run(key, rid);
  }

  /** May a content match merge the incoming job into row `rid`? */
  private contentMergeAllowed(rid: number, j: Job, postingIds: string[]): boolean {
    const keys = (q(this.db, "SELECT key FROM job_keys WHERE rid = ? AND (key LIKE 'post:%' OR key LIKE 'url:%')").all(rid) as Array<{ key: string }>).map((r) => r.key);
    const family = (k: string) => k.split(':').slice(0, 2).join(':');
    const theirs = keys.filter((k) => k.startsWith('post:'));
    for (const mine of postingIds) {
      for (const other of theirs) if (family(mine) === family(other) && mine !== other) return false;
    }
    const myUrl = canonicalizeUrl(j.canonicalUrl) || j.canonicalUrl;
    const myHost = hostOf(myUrl);
    for (const k of keys) {
      if (!k.startsWith('url:')) continue;
      const u = k.slice(4);
      if (hostOf(u) === myHost && u !== myUrl) return false;
    }
    return true;
  }

  private resolve(j: Job): { rid: number | null; keys: ReturnType<typeof keysOf> } {
    const keys = keysOf(j);
    const byId = this.ridForKey(`id:${j.id}`);
    if (byId !== null) return { rid: byId, keys };
    for (const k of keys.strong) {
      const r = this.ridForKey(k);
      if (r !== null) return { rid: r, keys };
    }
    const c = this.ridForKey(keys.content);
    if (c !== null && this.contentMergeAllowed(c, j, keys.postingIds)) return { rid: c, keys };
    return { rid: null, keys };
  }

  private existing(rid: number): ExistingRow | null {
    const r = q(this.db, 'SELECT rid, id, status, content_hash, precedence, first_seen, doc FROM store_jobs WHERE rid = ?').get(rid) as ExistingRow | undefined;
    return r ?? null;
  }

  private writeFts(rid: number, j: Job, replace: boolean): void {
    if (replace) {
      q(this.db, 'DELETE FROM job_head_fts WHERE rowid = ?').run(rid);
      q(this.db, 'DELETE FROM job_body_fts WHERE rowid = ?').run(rid);
      q(this.db, 'DELETE FROM job_title_fts WHERE rowid = ?').run(rid);
    }
    q(this.db, 'INSERT INTO job_title_fts (rowid, title) VALUES (?, ?)').run(rid, indexText(j.title));
    q(this.db, 'INSERT INTO job_head_fts (rowid, title, company, extra) VALUES (?, ?, ?, ?)')
      .run(rid, indexText(j.title), indexText(j.company), indexText(extraTextOf(j)));
    q(this.db, 'INSERT INTO job_body_fts (rowid, body) VALUES (?, ?)').run(rid, indexText(j.description));
  }

  private packed(j: Job): Uint8Array {
    const f = facetsOf(j);
    const ids = f.tags.map((t) => this.tagId(t));
    return packFacets(f, ids, this.tagId(`co:${j.companyKey || localCompanyKey(j.company)}`));
  }

  private insertRow(j: Job, rev: number): number {
    const facets = this.packed(j);
    const r = q(this.db, `INSERT INTO store_jobs (id, status, closed_at, closed_reason, dup_of, company_key, board_scope,
      posted_at, first_seen, last_seen, updated_at, content_hash, embed_hash, precedence, facets, doc, rev)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      j.id, j.status === 'open' ? 1 : 0, j.closedAt, j.closedReason, j.companyKey, boardScopeOf(j), j.postedAt,
      j.firstSeenAt, j.lastSeenAt, j.updatedAt, j.contentHash, embedHashOf(embedTextOf(j)), precedenceOf(j), facets,
      encodeRecord(j), rev,
    );
    const rid = Number(r.lastInsertRowid);
    this.writeFts(rid, j, false);
    return rid;
  }

  private rewriteRow(rid: number, j: Job, rev: number, textChanged: boolean): void {
    q(this.db, `UPDATE store_jobs SET id = ?, status = ?, closed_at = ?, closed_reason = ?, company_key = ?, board_scope = ?,
      posted_at = ?, first_seen = ?, last_seen = ?, updated_at = ?, content_hash = ?, embed_hash = ?, precedence = ?, facets = ?,
      doc = ?, rev = ? WHERE rid = ?`).run(
      j.id, j.status === 'open' ? 1 : 0, j.closedAt, j.closedReason, j.companyKey, boardScopeOf(j), j.postedAt,
      j.firstSeenAt, j.lastSeenAt, j.updatedAt, j.contentHash, embedHashOf(embedTextOf(j)), precedenceOf(j),
      this.packed(j), encodeRecord(j), rev, rid,
    );
    if (textChanged) this.writeFts(rid, j, true);
  }

  private upsertOne(input: Job, rev: number, nowIso: string, stats: UpsertStats): number {
    const j: Job = { ...input, companyKey: input.companyKey || companyKeyOf(input.company), updatedAt: nowIso };
    j.contentHash = contentHashOf(j);
    const { rid, keys } = this.resolve(j);
    if (rid === null) {
      const newRid = this.insertRow(j, rev);
      for (const k of keys.strong) this.addKey(k, newRid);
      this.addKey(keys.content, newRid);
      stats.inserted++;
      return newRid;
    }
    const ex = this.existing(rid);
    if (!ex) {
      // A key without its row (should not happen): drop the stale keys and insert fresh.
      q(this.db, 'DELETE FROM job_keys WHERE rid = ?').run(rid);
      return this.upsertOne(input, rev, nowIso, stats);
    }
    const wasOpen = Number(ex.status) === 1;
    const sameIdentity = ex.id === j.id;
    if (sameIdentity && ex.content_hash === j.contentHash && wasOpen === (j.status === 'open')) {
      q(this.db, 'UPDATE store_jobs SET last_seen = max(last_seen, ?) WHERE rid = ?').run(j.lastSeenAt > nowIso ? j.lastSeenAt : nowIso, rid);
      stats.unchanged++;
      return rid;
    }
    const old = decodeRecord<Job>(ex.doc);
    for (const k of keys.strong) this.addKey(k, rid);
    this.addKey(keys.content, rid);
    let next: Job;
    if (sameIdentity || precedenceOf(j) > Number(ex.precedence)) {
      next = { ...j, id: ex.id, firstSeenAt: old.firstSeenAt < j.firstSeenAt ? old.firstSeenAt : j.firstSeenAt };
      next.sources = sameIdentity ? mergeSources(j.sources, old.sources.filter((s) => !j.sources.some((x) => x.sourceId === s.sourceId))) : mergeSources(j.sources, old.sources);
    } else {
      next = { ...old, sources: mergeSources(old.sources, j.sources), lastSeenAt: j.lastSeenAt > old.lastSeenAt ? j.lastSeenAt : old.lastSeenAt, updatedAt: nowIso };
      if (j.status === 'open' && old.status === 'closed') { next.status = 'open'; next.closedAt = null; next.closedReason = null; }
    }
    if (next.status === 'open') { next.closedAt = null; next.closedReason = null; }
    next.contentHash = contentHashOf(next);
    const sourcesChanged = JSON.stringify(next.sources.map((s) => [s.sourceId, s.url])) !== JSON.stringify(old.sources.map((s) => [s.sourceId, s.url]));
    const statusChanged = (next.status === 'open') !== wasOpen;
    if (next.contentHash === ex.content_hash && !sourcesChanged && !statusChanged) {
      q(this.db, 'UPDATE store_jobs SET last_seen = ? WHERE rid = ?').run(next.lastSeenAt > nowIso ? next.lastSeenAt : nowIso, rid);
      stats.unchanged++;
      return rid;
    }
    const textChanged = old.title !== next.title || old.company !== next.company || old.description !== next.description
      || extraTextOf(old) !== extraTextOf(next);
    this.rewriteRow(rid, next, rev, textChanged);
    if (statusChanged && next.status === 'open') stats.reopened++;
    else if (statusChanged) stats.closed++;
    else if (!sameIdentity) stats.merged++;
    else stats.updated++;
    return rid;
  }

  /** Saves postings. Returns what happened. Bulk inputs are written in chunks of CHUNK rows per transaction. */
  upsert(jobs: Job[], nowIso: string): UpsertStats & { rids: number[] } {
    const stats = emptyStats();
    const rids: number[] = [];
    for (let i = 0; i < jobs.length; i += CHUNK) {
      const part = jobs.slice(i, i + CHUNK);
      tx(this.db, () => {
        const rev = nextRev(this.db);
        for (const j of part) rids.push(this.upsertOne(j, rev, nowIso, stats));
        stats.purged += this.purgeClosedUntracked(rev);
      });
    }
    return { ...stats, rids };
  }

  private closeRid(rid: number, reason: NonNullable<Job['closedReason']>, nowIso: string, rev: number): boolean {
    const ex = this.existing(rid);
    if (!ex || Number(ex.status) !== 1) return false;
    const old = decodeRecord<Job>(ex.doc);
    const next: Job = { ...old, status: 'closed', closedAt: nowIso, closedReason: reason, updatedAt: nowIso };
    this.rewriteRow(rid, next, rev, false);
    return true;
  }

  /** Closes postings by id (any alias id works). Unknown ids are ignored. */
  close(ids: string[], reason: NonNullable<Job['closedReason']>, nowIso: string): UpsertStats {
    const stats = emptyStats();
    tx(this.db, () => {
      const rev = nextRev(this.db);
      for (const id of ids) {
        const rid = this.ridForKey(`id:${id}`);
        if (rid !== null && this.closeRid(rid, reason, nowIso, rev)) stats.closed++;
      }
      stats.purged += this.purgeClosedUntracked(rev);
    });
    return stats;
  }

  /**
   * One complete listing of a board (or another source scope): saves every job, then closes the open jobs of that
   * scope that the listing no longer holds. Guards: an empty listing closes nothing, and a listing that would close
   * more than half of a board with 10 or more open jobs is held (nothing closes) and reported.
   */
  refreshScope(scope: string, jobs: Job[], nowIso: string): UpsertStats & { closeHeld: string | null; rids: number[] } {
    const up = this.upsert(jobs, nowIso);
    if (jobs.length === 0) return { ...up, closeHeld: 'The listing was empty, so nothing was closed.' };
    const seen = new Set(up.rids);
    const open = (q(this.db, 'SELECT rid FROM store_jobs WHERE board_scope = ? AND status = 1').all(scope) as Array<{ rid: number }>).map((r) => Number(r.rid));
    const gone = open.filter((rid) => !seen.has(rid));
    if (gone.length === 0) return { ...up, closeHeld: null };
    if (open.length >= 10 && gone.length > open.length / 2) {
      return { ...up, closeHeld: `The listing would close ${gone.length} of ${open.length} open jobs at once, so nothing was closed.` };
    }
    tx(this.db, () => {
      const rev = nextRev(this.db);
      for (const rid of gone) if (this.closeRid(rid, 'unseen', nowIso, rev)) up.closed++;
      up.purged += this.purgeClosedUntracked(rev);
    });
    return { ...up, closeHeld: null };
  }

  /**
   * Removes closed postings that nobody tracks (no like, status, note, reminder or hidden mark). Tracked ones stay,
   * so a closed job keeps its likes, notes and status and shows under the Closed view.
   */
  purgeClosedUntracked(rev: number): number {
    const rows = q(this.db, `SELECT s.rid AS rid FROM store_jobs s WHERE s.status = 0 AND NOT EXISTS (
      SELECT 1 FROM job_keys k JOIN tracker t ON t.job_id = substr(k.key, 4) WHERE k.rid = s.rid AND k.key LIKE 'id:%')`).all() as Array<{ rid: number }>;
    for (const r of rows) this.deleteRow(Number(r.rid), rev);
    return rows.length;
  }

  private deleteRow(rid: number, rev: number): void {
    q(this.db, 'DELETE FROM job_head_fts WHERE rowid = ?').run(rid);
    q(this.db, 'DELETE FROM job_body_fts WHERE rowid = ?').run(rid);
    q(this.db, 'DELETE FROM job_title_fts WHERE rowid = ?').run(rid);
    q(this.db, 'DELETE FROM job_vectors WHERE rid = ?').run(rid);
    q(this.db, 'DELETE FROM job_keys WHERE rid = ?').run(rid);
    q(this.db, 'DELETE FROM store_jobs WHERE rid = ?').run(rid);
    q(this.db, 'INSERT INTO job_tombstones (rid, rev) VALUES (?, ?) ON CONFLICT (rid) DO UPDATE SET rev = excluded.rev').run(rid, rev);
  }

  /** Company facts the filters read (industry, stage, staffing agency, H-1B history). Absent fields stay as they are. */
  upsertCompanies(list: CompanyInput[], nowIso: string): number {
    let n = 0;
    tx(this.db, () => {
      const rev = nextRev(this.db);
      for (const c of list) {
        const key = c.key ?? (c.name ? companyKeyOf(c.name) : '');
        if (!key) continue;
        this.tagId(`co:${key}`);
        const cur = q(this.db, 'SELECT name, industries, stage, is_staffing, h1b FROM companies WHERE key = ?').get(key) as
          { name: string; industries: string; stage: string | null; is_staffing: number | null; h1b: string | null } | undefined;
        const name = c.name ?? cur?.name ?? key;
        const industries = c.industries !== undefined ? JSON.stringify(c.industries) : cur?.industries ?? '[]';
        const stage = c.stage !== undefined ? c.stage : cur?.stage ?? null;
        const staffing = c.isStaffingAgency !== undefined ? (c.isStaffingAgency === null ? null : c.isStaffingAgency ? 1 : 0) : cur?.is_staffing ?? null;
        const h1b = c.h1b !== undefined ? c.h1b : cur?.h1b ?? null;
        q(this.db, `INSERT INTO companies (key, name, industries, stage, is_staffing, h1b, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET name = excluded.name, industries = excluded.industries, stage = excluded.stage,
          is_staffing = excluded.is_staffing, h1b = excluded.h1b, updated_at = excluded.updated_at, rev = excluded.rev`)
          .run(key, name, industries, stage, staffing, h1b, nowIso, rev);
        n++;
      }
    });
    return n;
  }
}
