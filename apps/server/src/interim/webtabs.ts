// The results open in tabs in Jobs > Web jobs (GET/PUT /websearch/tabs). One row: the tabs as the page last sent them,
// so they are there again after a restart, whatever address the local server listens on.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, type WebTabs } from '@jobleft/contracts';

const NONE: WebTabs = { tabs: [], active: null };

export class WebTabsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec('CREATE TABLE IF NOT EXISTS srv_web_tabs (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }

  get(): WebTabs {
    const r = this.db.prepare('SELECT json FROM srv_web_tabs WHERE id = 1').get() as { json: string } | undefined;
    if (!r) return NONE;
    try {
      const v = JSON.parse(r.json) as WebTabs;
      return Array.isArray(v?.tabs) ? { tabs: v.tabs, active: typeof v.active === 'string' ? v.active : null } : NONE;
    } catch { return NONE; }
  }

  /** Keeps the tabs (one entry per address) and the one in front, if it is one of them. */
  put(v: WebTabs): WebTabs {
    const seen = new Set<string>();
    const tabs = v.tabs.filter((t) => !seen.has(t.url) && seen.add(t.url));
    const kept: WebTabs = { tabs, active: v.active && seen.has(v.active) ? v.active : null };
    this.db.prepare(`INSERT INTO srv_web_tabs (id, json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(JSON.stringify(kept), nowIso());
    return kept;
  }
}
