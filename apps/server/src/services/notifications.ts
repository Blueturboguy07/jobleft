// Notifications the shell shows (GET /api/v1/notifications, then ack). An acked notification is never shown again.
// A dedupe key makes each reminder or alert notify once, even across restarts.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, type Notification } from '@jobleft/contracts';
import { newId, tx } from '../db/util.ts';

interface Row { id: string; kind: Notification['kind']; title: string; body: string; target: string | null; created_at: string }

function clip(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : chars.slice(0, n - 1).join('') + '…';
}

export class NotificationService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  /** Adds a notification unless one with the same dedupe key exists. Returns it, or null when it was a repeat. */
  add(n: Omit<Notification, 'id' | 'createdAt'>, dedupeKey: string | null): Notification | null {
    return tx(this.db, () => {
      if (dedupeKey && this.db.prepare('SELECT 1 FROM srv_notifications WHERE dedupe_key = ?').get(dedupeKey)) return null;
      const id = newId('ntf');
      const createdAt = nowIso();
      const title = clip(n.title, 120);
      const body = clip(n.body, 400);
      this.db.prepare('INSERT INTO srv_notifications (id, kind, title, body, target, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, n.kind, title, body, n.target, createdAt, dedupeKey);
      return { id, kind: n.kind, title, body, target: n.target, createdAt };
    });
  }

  pending(): Notification[] {
    const rows = this.db.prepare('SELECT id, kind, title, body, target, created_at FROM srv_notifications WHERE acked_at IS NULL ORDER BY created_at, id').all() as unknown as Row[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, target: r.target, createdAt: r.created_at }));
  }

  /** Removes the notifications of one kind that nobody has dismissed yet (a deleted contact's follow-up must not fire). */
  dropPending(kind: Notification['kind']): number {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM srv_notifications WHERE kind = ? AND acked_at IS NULL').run(kind).changes));
  }

  /** Changes the words of a notification nobody has dismissed yet (a count that went down is not a new alert). */
  update(id: string, n: { title: string; body: string }): boolean {
    return tx(this.db, () => Number(this.db.prepare('UPDATE srv_notifications SET title = ?, body = ? WHERE id = ? AND acked_at IS NULL').run(clip(n.title, 120), clip(n.body, 400), id).changes) > 0);
  }

  /** Removes one notification nobody has dismissed yet. */
  remove(id: string): boolean {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM srv_notifications WHERE id = ? AND acked_at IS NULL').run(id).changes) > 0);
  }

  ack(id: string): boolean {
    return tx(this.db, () => {
      const r = this.db.prepare('UPDATE srv_notifications SET acked_at = ? WHERE id = ? AND acked_at IS NULL').run(nowIso(), id);
      if (Number(r.changes) > 0) return true;
      return this.db.prepare('SELECT 1 FROM srv_notifications WHERE id = ?').get(id) !== undefined;
    });
  }
}
