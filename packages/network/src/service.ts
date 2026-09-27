// NetworkService: the Network tool's records. Owns the tables `network_contacts` and `network_meta`.
// Import keeps the person's stages, notes, follow-up dates and plan across re-imports; a person missing from a newer
// file is kept (with notes) and reported, never dropped silently. Deletes are real (see db.ts).

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CompanyCoverage, ContactRank, Job, NetworkContact, NetworkImportSummary, OutreachStage,
} from '@jobleft/contracts';
import { nowMs, OUTREACH_STAGES } from '@jobleft/contracts';
import { parseConnectionsCsv, urlIdentity, type ParsedConnection } from './csv.ts';
import {
  familyKey, howMatched, isNearName, keyFingerprint, keysForCompany, networkKey, whyNotCounted, type CompanyKeyFn,
} from './company.ts';
import { checkpoint, migrateNetwork, type ContactRow } from './db.ts';
import { rankContacts } from './rank.ts';
import { fold, isIsoDate, localDate, localTimeZone } from './text.ts';

export interface NetworkServiceOptions {
  db: DatabaseSync;
  /** @jobleft/static-data companyKey (the same key jobs use). */
  companyKey: CompanyKeyFn;
  now?: () => number;
  /** The person's time zone for "today" (default: the system zone, or JOBLEFT_TZ). */
  timeZone?: string;
}

/** A contact as the API returns it: the contract fields plus two read-only flags. */
export type NetworkContactView = NetworkContact & {
  /** false = not in the most recent file the person imported (kept from an earlier import). */
  inLatestFile: boolean;
  /** true = the follow-up date is today or past. */
  followUpDue: boolean;
};

export interface ListQuery {
  companyKey?: string;
  /** true = only contacts with no company key (blank company, or "Self-employed", "Stealth" and the like). */
  noCompany?: boolean;
  stage?: OutreachStage;
  q?: string;
  due?: boolean;
  /** true = only contacts that have a follow-up date (past, today or coming up). */
  withFollowUp?: boolean;
  inPlan?: boolean;
  limit?: number;
  offset?: number;
}

export interface CompanyGroup {
  /** null for the "unknown company" and "no specific company" groups. */
  companyKey: string | null;
  kind: 'company' | 'unknown' | 'placeholder';
  /** The names as written in the file, most people first. */
  names: Array<{ name: string; count: number }>;
  count: number;
}

export interface MatchExplanation {
  companyKey: string;
  companyName: string | null;
  count: number;
  matched: Array<{ name: string; count: number; how: string }>;
  notCounted: Array<{ name: string; count: number; why: string }>;
}

export interface PlanEntry {
  companyKey: string | null;
  companyName: string;
  contacts: Array<{ contactId: string; firstName: string; lastName: string; position: string | null; stage: OutreachStage; nextStep: string; reasons: ContactRank['reasons'] }>;
}

export class NetworkError extends Error {
  readonly code: 'not_found' | 'bad_request' | 'conflict';
  constructor(code: 'not_found' | 'bad_request' | 'conflict', message: string) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
  }
}

const NEXT_STEP: Record<OutreachStage, string> = {
  to_contact: 'Draft a short note, then send it yourself.',
  messaged: 'Wait for a reply. Set a follow-up date if you want a reminder.',
  replied: 'Suggest a short call at a time that suits them.',
  met: 'Send a thank-you note. Write down what you learned.',
  follow_up_due: 'Follow up now with a short, friendly note.',
};

function nameKey(first: string, last: string, connectedOn: string | null): string {
  return [fold(first).trim(), fold(last).trim(), connectedOn ?? ''].join('|');
}

function makeId(identity: string): string {
  return 'c_' + createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

function searchText(r: { first_name: string; last_name: string; company: string | null; position: string | null; email: string | null }): string {
  return fold([r.first_name, r.last_name, r.company ?? '', r.position ?? '', r.email ?? ''].join(' ')).replace(/\s+/g, ' ');
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export class NetworkService {
  readonly db: DatabaseSync;
  private readonly keyFn: CompanyKeyFn;
  private readonly nowFn: () => number;
  private readonly tz: string;
  private counts: Map<string, number> | null = null;
  private countsVersion = -1;

  constructor(opts: NetworkServiceOptions) {
    this.db = opts.db;
    this.keyFn = opts.companyKey;
    this.nowFn = opts.now ?? (() => nowMs());
    this.tz = opts.timeZone ?? localTimeZone();
    // Deleted or replaced network text is overwritten, not just unlinked (network O10).
    this.db.exec('PRAGMA secure_delete = ON');
    migrateNetwork(this.db, new Date(this.nowFn()).toISOString());
    this.rekeyIfNeeded();
    // A delete that another writer kept from emptying the log is finished here, at the next start.
    checkpoint(this.db, 1);
  }

  private nowIso(): string { return new Date(this.nowFn()).toISOString(); }

  /** A company key from a key or a name. Keys pass through unchanged ("stripe" stays "stripe"); "Stripe, Inc." becomes "stripe". */
  normalizeKey(keyOrName: string): string {
    if (!keyOrName) return '';
    // A key is put in its reviewed alias family ("palantirtechnologies" -> "palantir"), the way stored keys are.
    if (/^[\p{Ll}\p{N}\p{Lo}]+$/u.test(keyOrName)) return familyKey(keyOrName);
    return networkKey(keyOrName, this.keyFn) || keyOrName;
  }

  /** Today's calendar date in the person's time zone. */
  today(): string { return localDate(this.nowFn(), this.tz); }

  private meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM network_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO network_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** When the key function changes (the interim key is replaced by the static-data key), stored keys are rebuilt. */
  private rekeyIfNeeded(): void {
    const fp = keyFingerprint(this.keyFn);
    if (this.meta('company_key_fingerprint') === fp) return;
    this.tx(() => {
      const rows = this.db.prepare('SELECT id, company FROM network_contacts').all() as Array<{ id: string; company: string | null }>;
      const upd = this.db.prepare('UPDATE network_contacts SET company_key = ?, company_raw_key = ? WHERE id = ?');
      for (const r of rows) {
        const k = keysForCompany(r.company, this.keyFn);
        upd.run(k.key, k.rawKey, r.id);
      }
      this.setMeta('company_key_fingerprint', fp);
    });
    this.counts = null;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  private toView(r: ContactRow, today = this.today()): NetworkContactView {
    const stage = (OUTREACH_STAGES as readonly string[]).includes(r.stage) ? (r.stage as OutreachStage) : 'to_contact';
    return {
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      profileUrl: r.profile_url,
      email: r.email,
      company: r.company,
      companyKey: r.company_key,
      position: r.position,
      connectedOn: r.connected_on,
      maybeGarbled: r.maybe_garbled === 1,
      stage,
      note: r.note,
      followUpOn: r.follow_up_on,
      inPlan: r.in_plan === 1,
      importedAt: r.imported_at,
      updatedAt: r.updated_at,
      inLatestFile: r.in_latest_file === 1,
      followUpDue: !!r.follow_up_on && r.follow_up_on <= today,
    };
  }

  // ---------------------------------------------------------------- import

  /** Imports the file text. Keeps stages and notes of people already there; never drops a person silently. */
  import(csvText: string): NetworkImportSummary & { total: number; inFile: number } {
    const parsed = parseConnectionsCsv(csvText);
    if (parsed.notAConnectionsFile) {
      return {
        imported: 0, updated: 0, unchanged: 0, missingFromFile: 0, skipped: [], notAConnectionsFile: true,
        warnings: [...parsed.warnings, 'Nothing was imported and nothing you had was changed.'], total: this.total(), inFile: 0,
      };
    }
    const now = this.nowIso();
    const result = this.tx(() => this.applyImport(parsed.rows, now));
    this.counts = null;
    const warnings = [...parsed.warnings];
    if (result.missing) {
      warnings.push(`${result.missing} ${result.missing === 1 ? 'person' : 'people'} from an earlier import ${result.missing === 1 ? 'is' : 'are'} not in this file. They are kept with their stages and notes and marked "not in latest file". Delete them one by one if you want.`);
    }
    const summary = {
      imported: result.imported, updated: result.updated, unchanged: result.unchanged, missingFromFile: result.missing,
      skipped: parsed.skipped, notAConnectionsFile: false, warnings, total: this.total(), inFile: parsed.rows.length,
    };
    this.setMeta('last_import', JSON.stringify({
      at: now, imported: summary.imported, updated: summary.updated, unchanged: summary.unchanged,
      missingFromFile: summary.missingFromFile, skipped: summary.skipped.length, inFile: summary.inFile,
    }));
    return summary;
  }

  private applyImport(rows: ParsedConnection[], now: string): { imported: number; updated: number; unchanged: number; missing: number } {
    const existing = this.db.prepare('SELECT * FROM network_contacts').all() as unknown as ContactRow[];
    const byUrl = new Map<string, ContactRow>();
    const byName = new Map<string, ContactRow[]>();
    const ids = new Set<string>();
    for (const c of existing) {
      ids.add(c.id);
      if (c.url_key) byUrl.set(c.url_key, c);
      const list = byName.get(c.name_key) ?? [];
      list.push(c);
      byName.set(c.name_key, list);
    }
    for (const list of byName.values()) list.sort((a, b) => (a.file_line ?? 0) - (b.file_line ?? 0) || (a.id < b.id ? -1 : 1));
    const matched = new Set<string>();
    const fileUrls = new Set(rows.filter((r) => r.profileUrl).map((r) => urlIdentity(r.profileUrl!)));
    const insert = this.db.prepare(`INSERT INTO network_contacts (id, url_key, name_key, first_name, last_name, profile_url, email,
      company, company_key, company_raw_key, position, connected_on, maybe_garbled, stage, note, follow_up_on, in_plan, reminded_for,
      in_latest_file, file_line, search_text, imported_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'to_contact', NULL, NULL, 0, NULL, 1, ?, ?, ?, ?)`);
    const update = this.db.prepare(`UPDATE network_contacts SET url_key = ?, name_key = ?, first_name = ?, last_name = ?,
      profile_url = ?, email = ?, company = ?, company_key = ?, company_raw_key = ?, position = ?, connected_on = ?, maybe_garbled = ?,
      in_latest_file = 1, file_line = ?, search_text = ?, updated_at = ? WHERE id = ?`);
    const touch = this.db.prepare('UPDATE network_contacts SET in_latest_file = 1, file_line = ? WHERE id = ?');
    let imported = 0;
    let updated = 0;
    let unchanged = 0;

    for (const r of rows) {
      const urlKey = r.profileUrl ? urlIdentity(r.profileUrl) : null;
      const nk = nameKey(r.firstName, r.lastName, r.connectedOn);
      let hit: ContactRow | undefined = urlKey ? byUrl.get(urlKey) : undefined;
      if (hit && matched.has(hit.id)) hit = undefined;
      if (!hit) {
        // No link match: the same name and Connected On date. A contact that has a link is taken only when its link
        // is gone from this file (the link changed) and it is the only such contact.
        const candidates = (byName.get(nk) ?? []).filter((c) => !matched.has(c.id) && (!urlKey || !c.url_key || !fileUrls.has(c.url_key)));
        const noLink = candidates.filter((c) => !urlKey || !c.url_key);
        const pool = noLink.length ? noLink : candidates.length === 1 && r.connectedOn ? candidates : [];
        hit = pool.find((c) => c.company === r.company && c.position === r.position) ?? pool[0];
      }
      const keys = keysForCompany(r.company, this.keyFn);
      const st = searchText({ first_name: r.firstName, last_name: r.lastName, company: r.company, position: r.position, email: r.email });
      if (hit) {
        matched.add(hit.id);
        const same = hit.first_name === r.firstName && hit.last_name === r.lastName && hit.profile_url === r.profileUrl
          && hit.email === r.email && hit.company === r.company && hit.position === r.position && hit.connected_on === r.connectedOn
          && hit.url_key === urlKey && (hit.maybe_garbled === 1) === r.maybeGarbled && hit.company_key === keys.key;
        if (same) {
          touch.run(r.line, hit.id);
          unchanged++;
        } else {
          update.run(urlKey, nk, r.firstName, r.lastName, r.profileUrl, r.email, r.company, keys.key, keys.rawKey, r.position,
            r.connectedOn, r.maybeGarbled ? 1 : 0, r.line, st, now, hit.id);
          updated++;
        }
        continue;
      }
      let identity = urlKey ? `url:${urlKey}` : `name:${nk}`;
      let id = makeId(identity);
      for (let n = 2; ids.has(id); n++) { identity = `${urlKey ? `url:${urlKey}` : `name:${nk}`}#${n}`; id = makeId(identity); }
      ids.add(id);
      matched.add(id);
      insert.run(id, urlKey, nk, r.firstName, r.lastName, r.profileUrl, r.email, r.company, keys.key, keys.rawKey, r.position,
        r.connectedOn, r.maybeGarbled ? 1 : 0, r.line, st, now, now);
      imported++;
    }
    let missing = 0;
    const markMissing = this.db.prepare('UPDATE network_contacts SET in_latest_file = 0 WHERE id = ?');
    for (const c of existing) {
      if (matched.has(c.id)) continue;
      markMissing.run(c.id);
      missing++;
    }
    return { imported, updated, unchanged, missing };
  }

  // ---------------------------------------------------------------- reading

  total(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM network_contacts').get() as { n: number }).n;
  }

  get(id: string): NetworkContactView | null {
    const r = this.db.prepare('SELECT * FROM network_contacts WHERE id = ?').get(id) as unknown as ContactRow | undefined;
    return r ? this.toView(r) : null;
  }

  list(q: ListQuery = {}): NetworkContactView[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.companyKey !== undefined) {
      if (!q.companyKey) return [];
      const k = familyKey(q.companyKey);
      where.push('(company_key = ? OR company_raw_key = ?)');
      args.push(k, k);
    }
    if (q.noCompany) where.push('company_key IS NULL');
    if (q.stage) { where.push('stage = ?'); args.push(q.stage); }
    if (q.inPlan !== undefined) { where.push('in_plan = ?'); args.push(q.inPlan ? 1 : 0); }
    const today = this.today();
    if (q.withFollowUp) where.push('follow_up_on IS NOT NULL');
    if (q.due !== undefined) {
      if (q.due) { where.push('follow_up_on IS NOT NULL AND follow_up_on <= ?'); args.push(today); }
      else { where.push('(follow_up_on IS NULL OR follow_up_on > ?)'); args.push(today); }
    }
    if (q.q && q.q.trim()) {
      for (const word of fold(q.q).trim().split(/\s+/).slice(0, 8)) {
        where.push("search_text LIKE ? ESCAPE '\\'");
        args.push(`%${likeEscape(word)}%`);
      }
    }
    let sql = `SELECT * FROM network_contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, last_name, first_name, id`;
    if (q.limit !== undefined) { sql += ' LIMIT ?'; args.push(Math.max(0, Math.floor(q.limit))); }
    if (q.offset !== undefined) { if (q.limit === undefined) sql += ' LIMIT -1'; sql += ' OFFSET ?'; args.push(Math.max(0, Math.floor(q.offset))); }
    const rows = this.db.prepare(sql).all(...args) as unknown as ContactRow[];
    return rows.map((r) => this.toView(r, today));
  }

  /** How many rows a list query matches (for "showing 200 of 30,000"). */
  countList(q: ListQuery = {}): number {
    const { limit: _l, offset: _o, ...rest } = q;
    void _l; void _o;
    return this.list(rest).length;
  }

  /** SQLite's data_version: it changes when another connection (another process) commits to the file. */
  private dataVersion(): number {
    return (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  }

  private countCache(): Map<string, number> {
    const v = this.dataVersion();
    if (this.counts && this.countsVersion === v) return this.counts;
    this.countsVersion = v;
    const m = new Map<string, number>();
    const rows = this.db.prepare('SELECT company_key AS k, company_raw_key AS r FROM network_contacts WHERE company_key IS NOT NULL').all() as Array<{ k: string; r: string | null }>;
    for (const { k, r } of rows) {
      m.set(k, (m.get(k) ?? 0) + 1);
      if (r && r !== k) m.set(r, (m.get(r) ?? 0) + 1);
    }
    this.counts = m;
    return m;
  }

  /** How many connections work at a company (null when none, so cards show nothing). Same rule as list({ companyKey }). */
  countFor(companyKey: string): number | null {
    if (!companyKey) return null;
    return this.countCache().get(familyKey(companyKey)) ?? null;
  }

  /** countFor for many keys at once (a job feed page). One cached map; no query per card. */
  countsFor(keys: Iterable<string>): Map<string, number | null> {
    const cache = this.countCache();
    const out = new Map<string, number | null>();
    for (const k of keys) out.set(k, k ? cache.get(familyKey(k)) ?? null : null);
    return out;
  }

  /** Company groups of the whole network, with the names as written. Blank and placeholder companies are their own groups. */
  companies(): CompanyGroup[] {
    const rows = this.db.prepare(`SELECT company_key AS k, company AS name, COUNT(*) AS n FROM network_contacts
      GROUP BY company_key, company`).all() as Array<{ k: string | null; name: string | null; n: number }>;
    const groups = new Map<string, CompanyGroup>();
    for (const r of rows) {
      const kind: CompanyGroup['kind'] = r.k ? 'company' : r.name ? 'placeholder' : 'unknown';
      const id = r.k ? `k:${r.k}` : kind;
      const g = groups.get(id) ?? { companyKey: r.k, kind, names: [], count: 0 };
      g.names.push({ name: r.name ?? '', count: r.n });
      g.count += r.n;
      groups.set(id, g);
    }
    for (const g of groups.values()) g.names.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return [...groups.values()].sort((a, b) => b.count - a.count || (a.names[0]!.name < b.names[0]!.name ? -1 : 1));
  }

  /** How a company's count was made: which names were counted and why, and which near names were not. */
  explain(companyKey: string, companyName: string | null = null): MatchExplanation {
    companyKey = familyKey(companyKey);
    const matched = new Map<string, number>();
    const contacts = companyKey ? this.list({ companyKey }) : [];
    for (const c of contacts) matched.set(c.company ?? '', (matched.get(c.company ?? '') ?? 0) + 1);
    const target = companyName ?? [...matched.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? companyKey;
    const out: MatchExplanation = {
      companyKey, companyName, count: contacts.length,
      matched: [...matched.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([name, count]) => ({ name, count, how: howMatched(name, companyName ?? target, this.keyFn) })),
      notCounted: [],
    };
    if (!companyKey) return out;
    const near: Array<{ name: string; count: number; why: string }> = [];
    for (const g of this.companies()) {
      if (g.kind !== 'company' || g.companyKey === companyKey) continue;
      for (const n of g.names) {
        if (isNearName(n.name, target, g.companyKey!, companyKey)) near.push({ name: n.name, count: n.count, why: whyNotCounted(n.name, target) });
      }
    }
    out.notCounted = near.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)).slice(0, 10);
    return out;
  }

  coverage(targetCompanies: Array<{ companyKey: string; companyName: string }>): CompanyCoverage[] {
    const seen = new Map<string, { companyKey: string; companyName: string }>();
    for (const t of targetCompanies) {
      // The same key as the job card's count (the job's key, in its alias family), so both always agree.
      const key = familyKey(t.companyKey || keysForCompany(t.companyName, this.keyFn).rawKey || '');
      if (!key || seen.has(key)) continue;
      seen.set(key, { companyKey: key, companyName: t.companyName });
    }
    const out: CompanyCoverage[] = [];
    for (const t of seen.values()) {
      const count = this.countFor(t.companyKey) ?? 0;
      const top = count ? this.rank(t.companyKey, null).slice(0, 3).map((r) => r.contactId) : [];
      out.push({ companyKey: t.companyKey, companyName: t.companyName, count, topContactIds: top });
    }
    return out.sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0) || b.count - a.count
      || (a.companyName.toLowerCase() < b.companyName.toLowerCase() ? -1 : a.companyName.toLowerCase() > b.companyName.toLowerCase() ? 1 : 0));
  }

  rank(companyKey: string, job: Job | null): ContactRank[] {
    if (!companyKey) return [];
    companyKey = familyKey(companyKey);
    const contacts = this.list({ companyKey }).map((c) => ({ ...c, companyKey, matchKeys: [companyKey] }));
    return rankContacts(contacts, { companyKey, job, now: this.nowFn(), timeZone: this.tz });
  }

  // ---------------------------------------------------------------- tracking

  update(id: string, patch: { stage?: OutreachStage; note?: string | null; followUpOn?: string | null; inPlan?: boolean }): NetworkContactView {
    const cur = this.db.prepare('SELECT * FROM network_contacts WHERE id = ?').get(id) as unknown as ContactRow | undefined;
    if (!cur) throw new NetworkError('not_found', 'No such contact.');
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.stage !== undefined) {
      if (!(OUTREACH_STAGES as readonly string[]).includes(patch.stage)) throw new NetworkError('bad_request', 'Unknown stage.');
      sets.push('stage = ?'); args.push(patch.stage);
    }
    if (patch.note !== undefined) {
      const note = patch.note === null || patch.note.trim() === '' ? null : patch.note;
      if (note && note.length > 20000) throw new NetworkError('bad_request', 'The note is longer than 20,000 characters.');
      sets.push('note = ?'); args.push(note);
    }
    if (patch.followUpOn !== undefined) {
      if (patch.followUpOn !== null && !isIsoDate(patch.followUpOn)) throw new NetworkError('bad_request', 'The follow-up date must be a real date written YYYY-MM-DD.');
      sets.push('follow_up_on = ?'); args.push(patch.followUpOn);
      if (patch.followUpOn !== cur.follow_up_on) sets.push('reminded_for = NULL');
    }
    if (patch.inPlan !== undefined) { sets.push('in_plan = ?'); args.push(patch.inPlan ? 1 : 0); }
    if (sets.length) {
      sets.push('updated_at = ?'); args.push(this.nowIso());
      this.db.prepare(`UPDATE network_contacts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }
    return this.get(id)!;
  }

  /** Puts the top `count` people at a company (ranked for the job, when given) into the coffee-chat plan. */
  addTopToPlan(companyKey: string, count: number, job: Job | null): NetworkContactView[] {
    const top = this.rank(companyKey, job).slice(0, Math.max(0, Math.min(50, Math.floor(count))));
    const now = this.nowIso();
    const upd = this.db.prepare('UPDATE network_contacts SET in_plan = 1, updated_at = ? WHERE id = ? AND in_plan = 0');
    this.tx(() => { for (const r of top) upd.run(now, r.contactId); });
    return top.map((r) => this.get(r.contactId)!);
  }

  /** The coffee-chat plan: people in the plan, grouped by company, in rank order, with a next step for each. */
  plan(): PlanEntry[] {
    const inPlan = this.list({ inPlan: true });
    const groups = new Map<string, NetworkContactView[]>();
    for (const c of inPlan) {
      const k = c.companyKey ? `k:${c.companyKey}` : `n:${c.company ?? ''}`;
      const list = groups.get(k) ?? [];
      list.push(c);
      groups.set(k, list);
    }
    const out: PlanEntry[] = [];
    for (const list of groups.values()) {
      const key = list[0]!.companyKey;
      const ranks = key ? rankContacts(list.map((c) => ({ ...c })), { companyKey: key, job: null, now: this.nowFn(), timeZone: this.tz }) : list.map((c) => ({ contactId: c.id, score: 0, reasons: [] }));
      const byId = new Map(list.map((c) => [c.id, c]));
      const names = new Map<string, number>();
      for (const c of list) if (c.company) names.set(c.company, (names.get(c.company) ?? 0) + 1);
      const best = [...names.entries()].sort((a, b) => b[1] - a[1] || Number(a[0] === a[0].toLowerCase()) - Number(b[0] === b[0].toLowerCase()) || (a[0] < b[0] ? -1 : 1))[0]?.[0];
      out.push({
        companyKey: key,
        companyName: best ?? 'Unknown company',
        contacts: ranks.map((r) => {
          const c = byId.get(r.contactId)!;
          const stage: OutreachStage = c.followUpDue && c.stage !== 'met' ? 'follow_up_due' : c.stage;
          return { contactId: c.id, firstName: c.firstName, lastName: c.lastName, position: c.position, stage: c.stage, nextStep: NEXT_STEP[stage], reasons: r.reasons };
        }),
      });
    }
    return out.sort((a, b) => (a.companyName.toLowerCase() < b.companyName.toLowerCase() ? -1 : 1));
  }

  /** Contacts whose follow-up date is today or past (for reminders). */
  due(today: string = this.today()): NetworkContactView[] {
    const rows = this.db.prepare(`SELECT * FROM network_contacts WHERE follow_up_on IS NOT NULL AND follow_up_on <= ?
      ORDER BY follow_up_on, last_name COLLATE NOCASE, first_name COLLATE NOCASE, id`).all(today) as unknown as ContactRow[];
    return rows.map((r) => this.toView(r, today));
  }

  /**
   * Follow-ups that are due and have not had a reminder for their date yet. Marks them reminded, so a reminder
   * shows once per date, and still shows after a restart when it was missed. The caller shows one notification
   * with a count (no names: notification centres keep their own copy outside the data folder).
   */
  takeReminders(today: string = this.today()): { count: number; contactIds: string[]; text: { title: string; body: string } | null } {
    const rows = this.db.prepare(`SELECT id, follow_up_on FROM network_contacts WHERE follow_up_on IS NOT NULL AND follow_up_on <= ?
      AND (reminded_for IS NULL OR reminded_for <> follow_up_on) ORDER BY follow_up_on, id`).all(today) as Array<{ id: string; follow_up_on: string }>;
    if (!rows.length) return { count: 0, contactIds: [], text: null };
    const mark = this.db.prepare('UPDATE network_contacts SET reminded_for = follow_up_on WHERE id = ?');
    this.tx(() => { for (const r of rows) mark.run(r.id); });
    const n = rows.length;
    return {
      count: n,
      contactIds: rows.map((r) => r.id),
      text: { title: 'jobleft: network follow-up', body: `${n} network follow-up${n === 1 ? ' is' : 's are'} due. Open Network > Due to see ${n === 1 ? 'who' : 'them'}.` },
    };
  }

  // ---------------------------------------------------------------- deleting

  /** true when the last delete also emptied the write-ahead log (false only when another writer kept it busy). */
  lastDeleteCleanedLog = true;

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM network_contacts WHERE id = ?').run(id);
    this.counts = null;
    this.lastDeleteCleanedLog = checkpoint(this.db);
    return Number(r.changes) > 0;
  }

  /** Deletes every connection, note, stage, date and plan entry, and the tool's small records. The person's own file is not touched. */
  deleteAll(): number {
    const n = this.total();
    this.tx(() => {
      this.db.exec('DELETE FROM network_contacts');
      this.db.prepare("DELETE FROM network_meta WHERE key <> 'company_key_fingerprint'").run();
    });
    this.counts = null;
    this.lastDeleteCleanedLog = checkpoint(this.db);
    return n;
  }

  // ---------------------------------------------------------------- small records

  lastImport(): { at: string; imported: number; updated: number; unchanged: number; missingFromFile: number; skipped: number; inFile: number } | null {
    const v = this.meta('last_import');
    return v ? JSON.parse(v) : null;
  }

  /** Was a remote AI destination approved for drafts? (network O8: the person is told before the first remote draft.) */
  remoteApproved(destination: string): boolean {
    return this.meta(`remote_ok:${destination}`) !== null;
  }

  approveRemote(destination: string): void {
    this.setMeta(`remote_ok:${destination}`, this.nowIso());
  }
}
