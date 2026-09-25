// The list of paid charges the assistant caused (O12: every charge is visible, and the list agrees with the balance).
// One row per charge that publik reported (the x-publik-charge-micros header of the call). A call that publik refused
// or that cost nothing (a local model) adds no row. Amounts are integer micros; the text form never shows "$0.00"
// for a charge that is above zero.

import type { DatabaseSync } from 'node:sqlite';
import { formatDollars, nowIso } from '@jobleft/contracts';
import { newId, scrub } from './db.ts';

export interface UsageLine { id: string; at: string; what: string; costMicros: number; costText: string }

export class UsageLedger {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  /** Adds a line. `costMicros` null, not an integer or 0 adds nothing (unknown or free). */
  record(what: string, costMicros: number | null | undefined, meta: { chatId?: string | null; requestId?: string | null } = {}): UsageLine | null {
    if (typeof costMicros !== 'number' || !Number.isInteger(costMicros) || costMicros <= 0) return null;
    const line = { id: newId('use'), at: nowIso(), what, costMicros };
    this.db.prepare('INSERT INTO ai_usage (id, at, what, cost_micros, chat_id, request_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(line.id, line.at, line.what, line.costMicros, meta.chatId ?? null, meta.requestId ?? null);
    return { ...line, costText: formatDollars(costMicros) };
  }

  list(limit = 200): UsageLine[] {
    return (this.db.prepare('SELECT id, at, what, cost_micros FROM ai_usage ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as Array<{ id: string; at: string; what: string; cost_micros: number }>)
      .map((r) => ({ id: r.id, at: r.at, what: r.what, costMicros: Number(r.cost_micros), costText: formatDollars(Number(r.cost_micros)) }));
  }

  totalMicros(): number {
    return Number((this.db.prepare('SELECT coalesce(sum(cost_micros), 0) AS s FROM ai_usage').get() as { s: number }).s);
  }

  clear(): void {
    this.db.prepare('DELETE FROM ai_usage').run();
    scrub(this.db);
  }
}
