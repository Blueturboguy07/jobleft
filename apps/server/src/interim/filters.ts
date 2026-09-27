// INTERIM stand-in for @jobleft/store FilterStore (table srv_saved_filters).

import type { DatabaseSync } from 'node:sqlite';
import { JobFilterSchema, nowIso, type JobFilter, type JobSort, type SavedFilter } from '@jobleft/contracts';
import { b, newId, parseJson, prune, tx } from '../db/util.ts';
import { ApiFailure } from '../errors.ts';

interface Row {
  id: string; name: string; filter: string; sort: string; alert_enabled: number; last_notified_at: string | null;
  created_at: string; updated_at: string; q: string | null;
}

function toFilter(r: Row): SavedFilter {
  return {
    id: r.id, name: r.name, filter: parseJson<JobFilter>(r.filter, {}), sort: r.sort as JobSort,
    alert: { enabled: r.alert_enabled === 1, lastNotifiedAt: r.last_notified_at },
    createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.q ? { q: r.q } : {}),
  };
}

/** `q`: the search words the filter keeps (JL-tracker-15); blank = none. On a change, absent keeps the saved words. */
export interface FilterInput { name: string; filter: JobFilter; sort: JobSort; alert?: boolean; q?: string }

const words = (q: string | undefined): string | null => (q && q.trim() ? q.trim() : null);

export class FilterService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  list(): SavedFilter[] {
    return (this.db.prepare('SELECT * FROM srv_saved_filters ORDER BY created_at, id').all() as unknown as Row[]).map(toFilter);
  }

  get(id: string): SavedFilter | null {
    const r = this.db.prepare('SELECT * FROM srv_saved_filters WHERE id = ?').get(id) as Row | undefined;
    return r ? toFilter(r) : null;
  }

  create(input: FilterInput): SavedFilter {
    const id = newId('flt');
    const now = nowIso();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO srv_saved_filters (id, name, filter, sort, alert_enabled, created_at, updated_at, q) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.name, JSON.stringify(prune(JobFilterSchema, input.filter)), input.sort, b(input.alert ?? false), now, now, words(input.q));
    });
    return this.get(id)!;
  }

  update(id: string, input: FilterInput): SavedFilter {
    const now = nowIso();
    tx(this.db, () => {
      const r = this.db.prepare(`UPDATE srv_saved_filters SET name = ?, filter = ?, sort = ?, alert_enabled = COALESCE(?, alert_enabled), updated_at = ?, q = CASE WHEN ? THEN ? ELSE q END WHERE id = ?`)
        .run(input.name, JSON.stringify(prune(JobFilterSchema, input.filter)), input.sort, input.alert === undefined ? null : b(input.alert), now, input.q === undefined ? 0 : 1, words(input.q), id);
      if (Number(r.changes) === 0) throw new ApiFailure('not_found', 'That saved filter does not exist.');
    });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM srv_saved_filters WHERE id = ?').run(id).changes) > 0);
  }
}
