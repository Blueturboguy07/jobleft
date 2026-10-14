// What Jobs > Web jobs shows, kept so it is there again after a restart, whatever address the local server listens
// on: the results open in tabs (GET/PUT /websearch/tabs, one row as the page last sent them) and the last search with
// its answer (GET /websearch/last, kept here as each search from the page is answered).

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, type WebLastSearch, type WebSearchRequest, type WebSearchResponse, type WebTabs } from '@jobleft/contracts';

const NONE: WebTabs = { tabs: [], active: null };

export class WebTabsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec('CREATE TABLE IF NOT EXISTS srv_web_tabs (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS srv_web_last (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }

  lastSearch(): WebLastSearch | null {
    const r = this.db.prepare('SELECT json FROM srv_web_last WHERE id = 1').get() as { json: string } | undefined;
    try { return r ? (JSON.parse(r.json) as WebLastSearch) : null; } catch { return null; }
  }

  /**
   * Keeps a search the page made and its answer. A later page of the same search (More results) is merged in as the
   * page merges it: the new results after the ones it had, each address once.
   */
  keepSearch(req: WebSearchRequest, answer: WebSearchResponse): void {
    const page = req.page ?? 1;
    const { page: _p, ...request } = req;
    const prev = page > 1 ? this.lastSearch() : null;
    const same = !!prev && prev.request.q === request.q && (prev.request.place ?? '') === (request.place ?? '')
      && prev.request.timeRange === request.timeRange && !!prev.request.widen === !!request.widen;
    let kept: WebLastSearch;
    if (page > 1 && same) {
      const have = new Set(prev!.answer.results.map((x) => x.url));
      kept = {
        request, page: Math.max(prev!.page, page),
        answer: { ...answer, results: [...prev!.answer.results, ...answer.results.filter((x) => !have.has(x.url))], unresponsive: [...new Set([...prev!.answer.unresponsive, ...answer.unresponsive])].sort() },
      };
    } else if (page > 1) return; // a later page of a search no longer kept: the kept one stays
    else kept = { request, answer, page: 1 };
    this.db.prepare(`INSERT INTO srv_web_last (id, json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(JSON.stringify(kept), nowIso());
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
