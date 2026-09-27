// INTERIM stand-in for @jobleft/store TrackerStore (tables srv_tracker, srv_tracker_history, srv_tracker_notes,
// srv_tracker_reminders). The person's own state on a job: like, hide, external, status with history, notes and
// reminders. A patch is one transaction: a status change and its history entry are saved together or not at all.
// Tracker rows outlive their jobs: a closed posting keeps its entry, notes and reminders (server O5).

import type { DatabaseSync } from 'node:sqlite';
import {
  nowIso, type JobSummary, type TrackerEntry, type TrackerList, type TrackerPatch, type TrackerStatus, type TrackerView,
} from '@jobleft/contracts';
import { b, newId, tx } from '../db/util.ts';
import { ApiFailure } from '../errors.ts';

interface EntryRow {
  job_id: string; liked: number; hidden: number; external: number; status: string | null; applied_at: string | null;
  resume_id: string | null; created_at: string; updated_at: string;
}

export interface TrackerDeps {
  jobExists: (jobId: string) => boolean;
  summary: (jobId: string) => JobSummary | null;
}

export class TrackerService {
  private readonly db: DatabaseSync;
  private readonly deps: TrackerDeps;
  constructor(db: DatabaseSync, deps: TrackerDeps) { this.db = db; this.deps = deps; }

  private row(jobId: string): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM srv_tracker WHERE job_id = ?').get(jobId) as EntryRow | undefined;
  }

  private entry(r: EntryRow): TrackerEntry {
    const history = this.db.prepare('SELECT status, at FROM srv_tracker_history WHERE job_id = ? ORDER BY id').all(r.job_id) as Array<{ status: string | null; at: string }>;
    const notes = this.db.prepare('SELECT id, text, created_at, updated_at FROM srv_tracker_notes WHERE job_id = ? ORDER BY position').all(r.job_id) as Array<{ id: string; text: string; created_at: string; updated_at: string }>;
    const reminders = this.db.prepare('SELECT id, at, text, done FROM srv_tracker_reminders WHERE job_id = ? ORDER BY position').all(r.job_id) as Array<{ id: string; at: string; text: string; done: number }>;
    return {
      jobId: r.job_id,
      liked: r.liked === 1,
      hidden: r.hidden === 1,
      external: r.external === 1,
      status: r.status as TrackerStatus | null,
      statusHistory: history.map((h) => ({ status: h.status as TrackerStatus | null, at: h.at })),
      appliedAt: r.applied_at,
      resumeId: r.resume_id,
      notes: notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.created_at, updatedAt: n.updated_at })),
      reminders: reminders.map((m) => ({ id: m.id, at: m.at, text: m.text, done: m.done === 1 })),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  get(jobId: string): TrackerEntry | null {
    const r = this.row(jobId);
    return r ? this.entry(r) : null;
  }

  /** Applies a patch in one transaction. A new entry needs an existing job. */
  patch(jobId: string, p: TrackerPatch, extra: { external?: boolean } = {}): TrackerEntry {
    const now = nowIso();
    tx(this.db, () => {
      let r = this.row(jobId);
      if (!r) {
        if (!this.deps.jobExists(jobId)) throw new ApiFailure('not_found', 'That job does not exist.');
        this.db.prepare('INSERT INTO srv_tracker (job_id, created_at, updated_at) VALUES (?, ?, ?)').run(jobId, now, now);
        r = this.row(jobId)!;
      }
      const set: string[] = ['updated_at = ?'];
      const args: Array<string | number | null> = [now];
      if (p.liked !== undefined) { set.push('liked = ?'); args.push(b(p.liked)); }
      if (p.hidden !== undefined) { set.push('hidden = ?'); args.push(b(p.hidden)); }
      if (extra.external !== undefined) { set.push('external = ?'); args.push(b(extra.external)); }
      if (p.resumeId !== undefined) { set.push('resume_id = ?'); args.push(p.resumeId); }
      if (p.status !== undefined && p.status !== r.status) {
        set.push('status = ?'); args.push(p.status);
        // Every status is a stage of an application (Interviewing, Offer, Rejected and Archived come after applying),
        // so a job moved straight to any of them gets its applied date now, as Applied does (JL-tracker-7). A date
        // already set is kept, and moving back to "not applied" keeps it too (the status history shows both).
        if (p.status !== null && !r.applied_at) { set.push('applied_at = ?'); args.push(now); }
        this.db.prepare('INSERT INTO srv_tracker_history (job_id, status, at) VALUES (?, ?, ?)').run(jobId, p.status, now);
      }
      this.db.prepare(`UPDATE srv_tracker SET ${set.join(', ')} WHERE job_id = ?`).run(...args, jobId);

      if (p.notes !== undefined) {
        const old = new Map((this.db.prepare('SELECT id, text, created_at, updated_at FROM srv_tracker_notes WHERE job_id = ?').all(jobId) as Array<{ id: string; text: string; created_at: string; updated_at: string }>).map((n) => [n.id, n]));
        this.db.prepare('DELETE FROM srv_tracker_notes WHERE job_id = ?').run(jobId);
        const ins = this.db.prepare('INSERT INTO srv_tracker_notes (id, job_id, position, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
        const used = new Set<string>();
        p.notes.forEach((n, i) => {
          const prev = n.id ? old.get(n.id) : undefined;
          const id = prev && !used.has(prev.id) ? prev.id : newId('note');
          used.add(id);
          ins.run(id, jobId, i, n.text, prev ? prev.created_at : now, prev && prev.text === n.text ? prev.updated_at : now);
        });
      }
      if (p.reminders !== undefined) {
        const old = new Map((this.db.prepare('SELECT id, at, notified_at FROM srv_tracker_reminders WHERE job_id = ?').all(jobId) as Array<{ id: string; at: string; notified_at: string | null }>).map((m) => [m.id, m]));
        this.db.prepare('DELETE FROM srv_tracker_reminders WHERE job_id = ?').run(jobId);
        const ins = this.db.prepare('INSERT INTO srv_tracker_reminders (id, job_id, position, at, text, done, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const used = new Set<string>();
        p.reminders.forEach((m, i) => {
          const prev = m.id ? old.get(m.id) : undefined;
          const id = prev && !used.has(prev.id) ? prev.id : newId('rem');
          used.add(id);
          ins.run(id, jobId, i, m.at, m.text, b(m.done), prev && prev.at === m.at ? prev.notified_at : null);
        });
      }
    });
    return this.get(jobId)!;
  }

  list(view: TrackerView, status?: TrackerStatus): TrackerList {
    const rows = this.db.prepare(`SELECT t.*,
        EXISTS (SELECT 1 FROM srv_tracker_notes n WHERE n.job_id = t.job_id) AS has_notes,
        EXISTS (SELECT 1 FROM srv_tracker_reminders m WHERE m.job_id = t.job_id) AS has_reminders
      FROM srv_tracker t ORDER BY t.updated_at DESC, t.job_id`).all() as unknown as Array<EntryRow & { has_notes: number; has_reminders: number }>;
    const counts: TrackerList['counts'] = {
      liked: 0, applied: 0, external: 0, hidden: 0, closed: 0,
      byStatus: { applied: 0, interviewing: 0, offer_received: 0, rejected: 0, archived: 0 },
    };
    const items: TrackerList['items'] = [];
    for (const r of rows) {
      const job = this.deps.summary(r.job_id);
      // Anything the person did keeps a job in the tracker: a like, a status, an applied date, a note or a reminder.
      // (Unliking a job, or setting it back to "not applied", must never make its notes and reminders vanish.)
      const kept = r.liked === 1 || r.status !== null || r.applied_at !== null || Number(r.has_notes) === 1 || Number(r.has_reminders) === 1;
      const tracked = kept || r.external === 1;
      const closed = tracked && job?.status === 'closed';
      if (r.liked === 1) counts.liked++;
      if (r.status !== null) { counts.applied++; counts.byStatus[r.status as TrackerStatus]++; }
      if (r.external === 1) counts.external++;
      if (r.hidden === 1) counts.hidden++;
      if (closed) counts.closed++;
      const inView = view === 'liked' ? r.liked === 1
        : view === 'applied' ? r.status !== null
          : view === 'external' ? r.external === 1
            : view === 'hidden' ? r.hidden === 1
              : view === 'tracked' ? kept
                : closed;
      if (!inView || (status && r.status !== status) || !job) continue;
      items.push({ entry: this.entry(r), job });
    }
    return { items, counts };
  }

  /** Reminders that are due and not yet notified (the reminder tick). */
  dueReminders(nowMsValue: number): Array<{ id: string; jobId: string; at: string; text: string }> {
    const rows = this.db.prepare('SELECT id, job_id, at, text FROM srv_tracker_reminders WHERE done = 0 AND notified_at IS NULL').all() as Array<{ id: string; job_id: string; at: string; text: string }>;
    return rows.filter((r) => Date.parse(r.at) <= nowMsValue).map((r) => ({ id: r.id, jobId: r.job_id, at: r.at, text: r.text }));
  }

  markReminderNotified(id: string): void {
    tx(this.db, () => { this.db.prepare('UPDATE srv_tracker_reminders SET notified_at = ? WHERE id = ?').run(nowIso(), id); });
  }

  counts(): Record<string, number> {
    const q = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      trackedJobs: q('SELECT count(*) AS n FROM srv_tracker'),
      likes: q('SELECT count(*) AS n FROM srv_tracker WHERE liked = 1'),
      statuses: q('SELECT count(*) AS n FROM srv_tracker WHERE status IS NOT NULL'),
      notes: q('SELECT count(*) AS n FROM srv_tracker_notes'),
      reminders: q('SELECT count(*) AS n FROM srv_tracker_reminders'),
    };
  }
}
