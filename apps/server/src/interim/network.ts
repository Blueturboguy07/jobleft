// INTERIM stand-in for @jobleft/network NetworkService (table srv_contacts): import of the person's own LinkedIn
// Connections.csv, list, coverage, a simple rank with true reasons, stage/note/follow-up edits and real deletes.
// Nothing here makes a request: no LinkedIn, no people lookup (network rules in INTERFACES).

import type { DatabaseSync } from 'node:sqlite';
import {
  nowIso, type CompanyCoverage, type ContactRank, type Job, type NetworkContact, type NetworkImportSummary, type OutreachStage,
} from '@jobleft/contracts';
import { b, newId, tx } from '../db/util.ts';
import { ApiFailure } from '../errors.ts';
import { companyKey } from './company-key.ts';

interface Row {
  id: string; identity: string; first_name: string; last_name: string; profile_url: string | null; email: string | null;
  company: string | null; company_key: string | null; position: string | null; connected_on: string | null;
  maybe_garbled: number; stage: string; note: string | null; follow_up_on: string | null; in_plan: number;
  in_last_import: number; imported_at: string; updated_at: string;
}

function toContact(r: Row): NetworkContact {
  return {
    id: r.id, firstName: r.first_name, lastName: r.last_name, profileUrl: r.profile_url, email: r.email, company: r.company,
    companyKey: r.company_key, position: r.position, connectedOn: r.connected_on, maybeGarbled: r.maybe_garbled === 1,
    stage: r.stage as OutreachStage, note: r.note, followUpOn: r.follow_up_on, inPlan: r.in_plan === 1,
    importedAt: r.imported_at, updatedAt: r.updated_at,
  };
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      if (c === '\r' && s[i + 1] === '\n') i++;
      i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "24 Sep 2026" or "2026-09-24" to a calendar date; anything else is unknown (null). */
export function connectedDate(v: string): string | null {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(t);
  if (!m) return null;
  const mon = MONTHS[m[2]!.toLowerCase()];
  if (!mon) return null;
  const d = `${m[3]}-${mon}-${m[1]!.padStart(2, '0')}`;
  const parsed = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === d ? d : null;
}

function httpUrl(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  try { const u = new URL(t); return u.protocol === 'https:' || u.protocol === 'http:' ? t : null; } catch { return null; }
}

function garbled(s: string): boolean { return /�|Ã.|â€|Â./.test(s); }

export class NetworkService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  import(text: string): NetworkImportSummary {
    const rows = parseCsv(text);
    const headerAt = rows.findIndex((r) => {
      const h = r.map((x) => x.trim().toLowerCase());
      return h.includes('first name') && h.includes('last name');
    });
    if (headerAt < 0) {
      return { imported: 0, updated: 0, unchanged: 0, missingFromFile: 0, skipped: [], notAConnectionsFile: true, warnings: ['This file is not a LinkedIn connections export (no "First Name" and "Last Name" columns). Nothing was imported.'] };
    }
    const header = rows[headerAt]!.map((x) => x.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    const cFirst = col('first name'), cLast = col('last name'), cUrl = col('url'), cEmail = col('email address');
    const cCompany = col('company'), cPosition = col('position'), cConnected = col('connected on');
    const summary: NetworkImportSummary = { imported: 0, updated: 0, unchanged: 0, missingFromFile: 0, skipped: [], notAConnectionsFile: false, warnings: [] };
    const now = nowIso();
    tx(this.db, () => {
      this.db.prepare('UPDATE srv_contacts SET in_last_import = 0').run();
      const find = this.db.prepare('SELECT * FROM srv_contacts WHERE identity = ?');
      const seen = new Set<string>();
      for (let i = headerAt + 1; i < rows.length; i++) {
        const r = rows[i]!;
        const line = i + 1;
        if (r.every((x) => x.trim() === '')) continue;
        const get = (c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');
        const first = get(cFirst), last = get(cLast);
        if (!first && !last) { summary.skipped.push({ line, reason: 'no first or last name' }); continue; }
        const url = httpUrl(get(cUrl));
        const company = get(cCompany) || null;
        const identity = url ? `url:${url.toLowerCase().replace(/\/+$/, '')}` : `name:${first.toLowerCase()}|${last.toLowerCase()}|${(company ?? '').toLowerCase()}`;
        if (seen.has(identity)) { summary.skipped.push({ line, reason: 'the same person appears earlier in the file' }); continue; }
        seen.add(identity);
        const fields = {
          first_name: first, last_name: last, profile_url: url, email: get(cEmail) || null, company,
          company_key: company ? companyKey(company) || null : null, position: get(cPosition) || null,
          connected_on: connectedDate(get(cConnected)), maybe_garbled: b(garbled(first + last)),
        };
        const old = find.get(identity) as Row | undefined;
        if (old) {
          const changed = (Object.keys(fields) as Array<keyof typeof fields>).some((k) => (old as unknown as Record<string, unknown>)[k] !== fields[k]);
          if (changed) {
            this.db.prepare(`UPDATE srv_contacts SET first_name = ?, last_name = ?, profile_url = ?, email = ?, company = ?, company_key = ?,
              position = ?, connected_on = ?, maybe_garbled = ?, in_last_import = 1, updated_at = ? WHERE id = ?`)
              .run(fields.first_name, fields.last_name, fields.profile_url, fields.email, fields.company, fields.company_key, fields.position, fields.connected_on, fields.maybe_garbled, now, old.id);
            summary.updated++;
          } else {
            this.db.prepare('UPDATE srv_contacts SET in_last_import = 1 WHERE id = ?').run(old.id);
            summary.unchanged++;
          }
        } else {
          this.db.prepare(`INSERT INTO srv_contacts (id, identity, first_name, last_name, profile_url, email, company, company_key, position,
            connected_on, maybe_garbled, stage, in_plan, in_last_import, imported_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'to_contact', 0, 1, ?, ?)`)
            .run(newId('con'), identity, fields.first_name, fields.last_name, fields.profile_url, fields.email, fields.company, fields.company_key, fields.position, fields.connected_on, fields.maybe_garbled, now, now);
          summary.imported++;
        }
      }
      summary.missingFromFile = Number((this.db.prepare('SELECT count(*) AS n FROM srv_contacts WHERE in_last_import = 0').get() as { n: number }).n);
    });
    if (summary.missingFromFile) summary.warnings.push(`${summary.missingFromFile} people from an earlier import are not in this file. They were kept, with their notes.`);
    return summary;
  }

  list(q: { companyKey?: string; stage?: OutreachStage; q?: string; due?: boolean; inPlan?: boolean; today: string }): NetworkContact[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.companyKey) { where.push('company_key = ?'); args.push(q.companyKey); }
    if (q.stage) { where.push('stage = ?'); args.push(q.stage); }
    if (q.inPlan !== undefined) { where.push('in_plan = ?'); args.push(b(q.inPlan)); }
    if (q.due !== undefined) { where.push(q.due ? '(follow_up_on IS NOT NULL AND follow_up_on <= ?)' : '(follow_up_on IS NULL OR follow_up_on > ?)'); args.push(q.today); }
    if (q.q) {
      const needle = q.q.toLowerCase();
      where.push("(instr(lower(first_name || ' ' || last_name), ?) > 0 OR instr(lower(COALESCE(company, '')), ?) > 0 OR instr(lower(COALESCE(position, '')), ?) > 0)");
      args.push(needle, needle, needle);
    }
    const sql = `SELECT * FROM srv_contacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_name, first_name, id`;
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toContact);
  }

  get(id: string): NetworkContact | null {
    const r = this.db.prepare('SELECT * FROM srv_contacts WHERE id = ?').get(id) as Row | undefined;
    return r ? toContact(r) : null;
  }

  countFor(key: string): number | null {
    if (!key) return null;
    const n = Number((this.db.prepare('SELECT count(*) AS n FROM srv_contacts WHERE company_key = ?').get(key) as { n: number }).n);
    return n > 0 ? n : null;
  }

  coverage(targets: Array<{ companyKey: string; companyName: string }>): CompanyCoverage[] {
    const out: CompanyCoverage[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      if (!t.companyKey || seen.has(t.companyKey)) continue;
      seen.add(t.companyKey);
      const ranked = this.rank(t.companyKey, null);
      out.push({ companyKey: t.companyKey, companyName: t.companyName, count: ranked.length, topContactIds: ranked.slice(0, 3).map((r) => r.contactId) });
    }
    return out.sort((a, b2) => b2.count - a.count || a.companyName.localeCompare(b2.companyName));
  }

  /** Who to message first at a company. Every reason is true for the contact's own row; same data, same order. */
  rank(key: string, job: Job | null): ContactRank[] {
    const rows = this.db.prepare('SELECT * FROM srv_contacts WHERE company_key = ? ORDER BY id').all(key) as unknown as Row[];
    const jobWords = new Set((job?.title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const ranks = rows.map((r) => {
      const reasons: ContactRank['reasons'] = [];
      let score = 0;
      const pos = (r.position ?? '').toLowerCase();
      if (/recruit|talent|sourc|people partner/.test(pos)) { score += 30; reasons.push({ code: 'recruiting', text: `Works in recruiting (${r.position})` }); }
      if (/\b(manager|director|head|lead|vp|chief)\b/.test(pos)) { score += 20; reasons.push({ code: 'leader', text: `Holds a lead role (${r.position})` }); }
      const shared = [...jobWords].filter((w) => pos.includes(w));
      if (shared.length) { score += 15; reasons.push({ code: 'same_field', text: `Their title shares "${shared[0]}" with the job title` }); }
      if (r.email) { score += 5; reasons.push({ code: 'email', text: 'Their email address is in your file' }); }
      if (r.connected_on) { score += 2; reasons.push({ code: 'connected', text: `Connected on ${r.connected_on}` }); }
      return { contactId: r.id, score, reasons };
    });
    return ranks.sort((a, c) => c.score - a.score || a.contactId.localeCompare(c.contactId));
  }

  update(id: string, patch: { stage?: OutreachStage; note?: string | null; followUpOn?: string | null; inPlan?: boolean }): NetworkContact {
    tx(this.db, () => {
      const set: string[] = ['updated_at = ?'];
      const args: Array<string | number | null> = [nowIso()];
      if (patch.stage !== undefined) { set.push('stage = ?'); args.push(patch.stage); }
      if (patch.note !== undefined) { set.push('note = ?'); args.push(patch.note); }
      if (patch.followUpOn !== undefined) { set.push('follow_up_on = ?'); args.push(patch.followUpOn); }
      if (patch.inPlan !== undefined) { set.push('in_plan = ?'); args.push(b(patch.inPlan)); }
      const r = this.db.prepare(`UPDATE srv_contacts SET ${set.join(', ')} WHERE id = ?`).run(...args, id);
      if (Number(r.changes) === 0) throw new ApiFailure('not_found', 'That contact does not exist.');
    });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM srv_contacts WHERE id = ?').run(id).changes) > 0);
  }

  deleteAll(): number {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM srv_contacts').run().changes));
  }

  due(today: string): NetworkContact[] {
    return (this.db.prepare('SELECT * FROM srv_contacts WHERE follow_up_on IS NOT NULL AND follow_up_on <= ? ORDER BY follow_up_on, id').all(today) as unknown as Row[]).map(toContact);
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM srv_contacts').get() as { n: number }).n);
  }
}
