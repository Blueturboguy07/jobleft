// Crawl runs: one row per run and one row per board of the run, so a run that was cut short (quit, crash, power loss,
// network loss) resumes with the boards it had not finished, and every run leaves a report.
// Also the crawl lease: one crawler per database at a time, so two processes never double the pace to a host.

import type { Store } from './store.ts';
import type { BoardRef } from './types.ts';

export type RunReason = 'first_run' | 'launch_catch_up' | 'schedule' | 'confirm' | 'manual' | 'resume' | 'simulate';
export type RunState = 'running' | 'done' | 'stopped' | 'abandoned';

export interface RunRow {
  id: number; reason: RunReason; state: RunState; started_at: string; finished_at: string | null; pid: number | null;
  heartbeat_at: string | null; boards_total: number; boards_done: number; ok: number; failed: number; deferred: number;
  listed: number; inserted: number; updated: number; unchanged: number; closed: number; requests: number; note: string | null;
}

export interface RunBoardRow {
  run_id: number; position: number; ats: string; board: string; company: string; region: string; origin: string | null;
  state: 'pending' | 'done'; status: string | null; reason_code: string | null; reason: string | null; listed: number;
  inserted: number; updated: number; unchanged: number; skipped: number; closed: number; missing: number;
  close_held: string | null; requests: number; bytes: number; not_modified: number; finished_at: string | null;
}

export interface BoardOutcome {
  status: string;
  reasonCode: string;
  reason: string | null;
  listed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  closed: number;
  missing: number;
  closeHeld: string | null;
  requests: number;
  bytes: number;
  notModified: boolean;
  /** false leaves the board pending (the run was stopped before it finished). */
  done: boolean;
}

/** A heartbeat older than this means the process holding a run or the lease is gone (or hung). */
const STALE_MS = 120_000;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class Runs {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }

  /** Starts a run with its board list (all pending). */
  create(reason: RunReason, boards: BoardRef[], nowIso: string, note: string | null = null): number {
    return this.store.transaction(() => {
      const r = this.store.db.prepare(`INSERT INTO crawler_runs (reason, state, started_at, pid, heartbeat_at, boards_total, note)
        VALUES (?, 'running', ?, ?, ?, ?, ?)`).run(reason, nowIso, process.pid, new Date().toISOString(), boards.length, note);
      const id = Number(r.lastInsertRowid);
      const ins = this.store.db.prepare(`INSERT OR IGNORE INTO crawler_run_boards (run_id, position, ats, board, company, region, origin)
        VALUES (?,?,?,?,?,?,?)`);
      boards.forEach((b, i) => ins.run(id, i, b.ats, b.board, b.company, b.region ?? '', b.origin ?? null));
      return id;
    });
  }

  get(id: number): RunRow | null {
    return (this.store.db.prepare('SELECT * FROM crawler_runs WHERE id = ?').get(id) as unknown as RunRow | undefined) ?? null;
  }

  latest(): RunRow | null {
    return (this.store.db.prepare('SELECT * FROM crawler_runs ORDER BY id DESC LIMIT 1').get() as unknown as RunRow | undefined) ?? null;
  }

  /** The last run that finished (done or stopped). */
  lastFinished(): RunRow | null {
    return (this.store.db.prepare("SELECT * FROM crawler_runs WHERE state IN ('done','stopped') ORDER BY id DESC LIMIT 1").get() as unknown as RunRow | undefined) ?? null;
  }

  /** A run left 'running' by a process that is gone (crash, force-quit, power loss), with pending boards. */
  interrupted(): RunRow | null {
    const rows = this.store.db.prepare("SELECT * FROM crawler_runs WHERE state IN ('running','stopped') AND boards_done < boards_total ORDER BY id DESC").all() as unknown as RunRow[];
    for (const r of rows) {
      const fresh = r.heartbeat_at !== null && Date.now() - Date.parse(r.heartbeat_at) < STALE_MS;
      if (r.state === 'running' && r.pid !== null && r.pid !== process.pid && alive(r.pid) && fresh) continue;
      return r;
    }
    return null;
  }

  /** The run another live process is working on right now, if any. */
  activeElsewhere(): RunRow | null {
    const rows = this.store.db.prepare("SELECT * FROM crawler_runs WHERE state = 'running' ORDER BY id DESC").all() as unknown as RunRow[];
    for (const r of rows) {
      const fresh = r.heartbeat_at !== null && Date.now() - Date.parse(r.heartbeat_at) < STALE_MS;
      if (r.pid !== null && r.pid !== process.pid && alive(r.pid) && fresh) return r;
    }
    return null;
  }

  pendingBoards(id: number): BoardRef[] {
    const rows = this.store.db.prepare("SELECT * FROM crawler_run_boards WHERE run_id = ? AND state = 'pending' ORDER BY position").all(id) as unknown as RunBoardRow[];
    return rows.map((r) => {
      const ref: BoardRef = { ats: r.ats as BoardRef['ats'], board: r.board, company: r.company };
      if (r.region) ref.region = r.region;
      if (r.origin) ref.origin = r.origin;
      return ref;
    });
  }

  boards(id: number): RunBoardRow[] {
    return this.store.db.prepare('SELECT * FROM crawler_run_boards WHERE run_id = ? ORDER BY position').all(id) as unknown as RunBoardRow[];
  }

  /** Takes over an interrupted run in this process. */
  adopt(id: number): void {
    this.store.db.prepare("UPDATE crawler_runs SET state = 'running', pid = ?, heartbeat_at = ?, finished_at = NULL WHERE id = ?")
      .run(process.pid, new Date().toISOString(), id);
  }

  abandon(id: number, nowIso: string): void {
    this.store.db.prepare("UPDATE crawler_runs SET state = 'abandoned', finished_at = ? WHERE id = ?").run(nowIso, id);
  }

  /** Records one board's result. Call inside the same transaction as the board's job writes. */
  boardDone(id: number, b: BoardRef, o: BoardOutcome, nowIso: string): void {
    const db = this.store.db;
    const prev = db.prepare('SELECT state FROM crawler_run_boards WHERE run_id = ? AND ats = ? AND board = ? AND region = ?')
      .get(id, b.ats, b.board, b.region ?? '') as { state: string } | undefined;
    db.prepare(`UPDATE crawler_run_boards SET state = ?, status = ?, reason_code = ?, reason = ?, listed = ?, inserted = inserted + ?,
      updated = updated + ?, unchanged = ?, skipped = ?, closed = closed + ?, missing = ?, close_held = ?, requests = requests + ?,
      bytes = bytes + ?, not_modified = ?, finished_at = ? WHERE run_id = ? AND ats = ? AND board = ? AND region = ?`)
      .run(o.done ? 'done' : 'pending', o.status, o.reasonCode, o.reason, o.listed, o.inserted, o.updated, o.unchanged, o.skipped,
        o.closed, o.missing, o.closeHeld, o.requests, o.bytes, o.notModified ? 1 : 0, nowIso, id, b.ats, b.board, b.region ?? '');
    const newlyDone = o.done && prev?.state !== 'done';
    const good = o.status === 'ok';
    const deferred = o.status === 'deferred' || o.status === 'host-skipped';
    db.prepare(`UPDATE crawler_runs SET boards_done = boards_done + ?, ok = ok + ?, failed = failed + ?, deferred = deferred + ?,
      listed = listed + ?, inserted = inserted + ?, updated = updated + ?, unchanged = unchanged + ?, closed = closed + ?,
      heartbeat_at = ? WHERE id = ?`)
      .run(newlyDone ? 1 : 0, newlyDone && good ? 1 : 0, newlyDone && !good && !deferred ? 1 : 0, newlyDone && deferred ? 1 : 0,
        newlyDone ? o.listed : 0, o.inserted, o.updated, newlyDone ? o.unchanged : 0, o.closed, new Date().toISOString(), id);
  }

  /** Adds closes found by a confirming reading to a board already done. */
  addCloses(id: number, b: BoardRef, closed: number, requests: number): void {
    if (closed === 0 && requests === 0) return;
    this.store.db.prepare('UPDATE crawler_run_boards SET closed = closed + ?, requests = requests + ? WHERE run_id = ? AND ats = ? AND board = ? AND region = ?')
      .run(closed, requests, id, b.ats, b.board, b.region ?? '');
    this.store.db.prepare('UPDATE crawler_runs SET closed = closed + ? WHERE id = ?').run(closed, id);
  }

  /** Adds the requests a run sent (every request, robots.txt and retries included). */
  addRequests(id: number, n: number): void {
    this.store.db.prepare('UPDATE crawler_runs SET requests = requests + ? WHERE id = ?').run(n, id);
  }

  heartbeat(id: number): void {
    this.store.db.prepare('UPDATE crawler_runs SET heartbeat_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  finish(id: number, state: RunState, nowIso: string, note?: string | null): void {
    this.store.db.prepare('UPDATE crawler_runs SET state = ?, finished_at = ?, note = coalesce(?, note) WHERE id = ?').run(state, nowIso, note ?? null, id);
  }

  /** Recent runs, newest first. */
  recent(limit = 10): RunRow[] {
    return this.store.db.prepare('SELECT * FROM crawler_runs ORDER BY id DESC LIMIT ?').all(limit) as unknown as RunRow[];
  }

  // ---------------------------------------------------------------------------------------------- lease

  /**
   * Takes the crawl lease of this database. Refuses (returns the holder) when another live process holds it, so two
   * crawls never run against the same hosts at once. A lease left by a dead process is taken over.
   */
  acquireLease(): { ok: true } | { ok: false; pid: number; since: string } {
    return this.store.transaction(() => {
      const raw = this.store.getMeta('lease');
      if (raw) {
        try {
          const l = JSON.parse(raw) as { pid: number; since: string; beat?: string };
          const fresh = l.beat !== undefined && Date.now() - Date.parse(l.beat) < STALE_MS;
          if (l.pid !== process.pid && alive(l.pid) && fresh) return { ok: false as const, pid: l.pid, since: l.since };
        } catch { /* a broken lease is ignored */ }
      }
      const now = new Date().toISOString();
      this.store.setMeta('lease', JSON.stringify({ pid: process.pid, since: now, beat: now }));
      return { ok: true as const };
    });
  }

  /** Keeps the lease fresh (call every 30 s while crawling or waiting in the daemon). */
  touchLease(): void {
    const raw = this.store.getMeta('lease');
    if (!raw) return;
    try {
      const l = JSON.parse(raw) as { pid: number; since: string };
      if (l.pid === process.pid) this.store.setMeta('lease', JSON.stringify({ ...l, beat: new Date().toISOString() }));
    } catch { /* ignore */ }
  }

  releaseLease(): void {
    const raw = this.store.getMeta('lease');
    if (!raw) return;
    try {
      const l = JSON.parse(raw) as { pid: number };
      if (l.pid === process.pid) this.store.setMeta('lease', null);
    } catch { this.store.setMeta('lease', null); }
  }
}
