// The mock's Network tool steps (the real ones are @jobleft/network): parse the person's own Connections.csv,
// keep stages and notes across imports, rank people at a company with reasons that are true for each row.

import type { ContactRank, NetworkContact, NetworkImportSummary } from '@jobleft/contracts';
import { companyKey, newId } from './util.ts';

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Splits the file into logical lines (a quoted field may hold a line break). */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of text.replace(/^﻿/, '')) {
    if (ch === '"') q = !q;
    if ((ch === '\n' || ch === '\r') && !q) {
      if (ch === '\n') { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function isoDate(s: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(s.trim());
  if (m && MONTHS[m[2]!.toLowerCase()]) return `${m[3]}-${MONTHS[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, '0')}`;
  const iso = /^(\d{4}-\d{2}-\d{2})$/.exec(s.trim());
  return iso ? iso[1]! : null;
}

export interface ParsedRow {
  firstName: string; lastName: string; profileUrl: string | null; email: string | null; company: string | null; position: string | null;
  connectedOn: string | null; maybeGarbled: boolean;
}

export function parseConnections(text: string): { rows: ParsedRow[]; skipped: Array<{ line: number; reason: string }>; notAConnectionsFile: boolean; warnings: string[] } {
  const lines = logicalLines(text);
  const headerAt = lines.findIndex((l) => /^\s*"?First Name"?\s*,\s*"?Last Name"?/i.test(l));
  if (headerAt < 0) return { rows: [], skipped: [], notAConnectionsFile: true, warnings: ['This file is not a LinkedIn connections export. Nothing was imported.'] };
  const header = splitCsv(lines[headerAt]!).map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.indexOf(n);
  const idx = { first: col('first name'), last: col('last name'), url: col('url'), email: col('email address'), company: col('company'), position: col('position'), on: col('connected on') };
  const rows: ParsedRow[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const f = splitCsv(raw);
    const get = (k: number) => (k >= 0 ? (f[k] ?? '').trim() : '');
    const first = get(idx.first), last = get(idx.last);
    if (!first && !last) { skipped.push({ line: i + 1, reason: 'No name on this row.' }); continue; }
    const url = get(idx.url);
    const garbled = /Ã|Â|â€|�/.test(first + last);
    rows.push({
      firstName: first, lastName: last,
      profileUrl: /^https?:\/\//.test(url) ? url : null,
      email: get(idx.email) || null,
      company: get(idx.company) || null,
      position: get(idx.position) || null,
      connectedOn: isoDate(get(idx.on)),
      maybeGarbled: garbled,
    });
  }
  const warnings: string[] = [];
  if (rows.some((r) => r.maybeGarbled)) warnings.push('Some names look garbled in the export (this happens with some scripts). They are shown as in the file.');
  const blankEmail = rows.filter((r) => !r.email).length;
  if (blankEmail) warnings.push(`${blankEmail} of ${rows.length} people have no email in the file. LinkedIn leaves it out unless they allow it.`);
  return { rows, skipped, notAConnectionsFile: false, warnings };
}

function sameKey(a: ParsedRow | NetworkContact): string {
  return (a.profileUrl ?? `${a.firstName} ${a.lastName} ${a.company ?? ''}`).toLowerCase();
}

export function mergeImport(existing: NetworkContact[], text: string, now: string): { contacts: NetworkContact[]; summary: NetworkImportSummary } {
  const parsed = parseConnections(text);
  if (parsed.notAConnectionsFile) {
    return { contacts: existing, summary: { imported: 0, updated: 0, unchanged: 0, missingFromFile: 0, skipped: [], notAConnectionsFile: true, warnings: parsed.warnings, total: existing.length, inFile: 0 } as NetworkImportSummary };
  }
  const byKey = new Map(existing.map((c) => [sameKey(c), c]));
  const seen = new Set<string>();
  let imported = 0, updated = 0, unchanged = 0;
  const out: NetworkContact[] = [];
  for (const r of parsed.rows) {
    const k = sameKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    const old = byKey.get(k);
    const fields = { firstName: r.firstName, lastName: r.lastName, profileUrl: r.profileUrl, email: r.email, company: r.company, companyKey: r.company ? companyKey(r.company) : null, position: r.position, connectedOn: r.connectedOn, maybeGarbled: r.maybeGarbled };
    if (old) {
      const changed = JSON.stringify([old.firstName, old.lastName, old.email, old.company, old.position]) !== JSON.stringify([r.firstName, r.lastName, r.email, r.company, r.position]);
      if (changed) updated++; else unchanged++;
      out.push({ ...old, ...fields, updatedAt: changed ? now : old.updatedAt, inLatestFile: true } as NetworkContact);
    } else {
      imported++;
      out.push({ id: newId('c'), ...fields, stage: 'to_contact', note: null, followUpOn: null, inPlan: false, importedAt: now, updatedAt: now, inLatestFile: true } as NetworkContact);
    }
  }
  let missing = 0;
  for (const c of existing) if (!seen.has(sameKey(c))) { missing++; out.push({ ...c, inLatestFile: false } as NetworkContact); }
  return {
    contacts: out,
    summary: { imported, updated, unchanged, missingFromFile: missing, skipped: parsed.skipped, notAConnectionsFile: false, warnings: parsed.warnings, total: out.length, inFile: seen.size } as NetworkImportSummary,
  };
}

const ROLE_RULES: Array<[RegExp, string, number]> = [
  [/recruit|talent/i, 'Works in recruiting, so they can route your application.', 30],
  [/manager|director|head/i, 'Leads a team, so they may know about open roles.', 22],
  [/engineer|scientist|analyst|designer|nurse/i, 'Works in a role close to the job.', 15],
];

export function rankAt(contacts: NetworkContact[], key: string, jobTitle: string | null, now: number): ContactRank[] {
  const out: ContactRank[] = [];
  for (const c of contacts) {
    if (c.companyKey !== key) continue;
    const reasons: Array<{ code: string; text: string }> = [];
    let score = 10;
    for (const [re, text, pts] of ROLE_RULES) if (c.position && re.test(c.position)) { reasons.push({ code: 'role', text: `${c.position}: ${text}` }); score += pts; break; }
    if (jobTitle && c.position && c.position.toLowerCase().split(/\W+/).some((w) => w.length > 3 && jobTitle.toLowerCase().includes(w))) { reasons.push({ code: 'title_overlap', text: `Their title shares words with the job title "${jobTitle}".` }); score += 10; }
    if (c.connectedOn) {
      const yrs = (now - Date.parse(c.connectedOn)) / (365.25 * 86_400_000);
      if (yrs < 2) { reasons.push({ code: 'recent', text: `You connected on ${c.connectedOn}, less than two years ago.` }); score += 8; }
    }
    if (c.email) { reasons.push({ code: 'email', text: 'The file has their email address.' }); score += 5; }
    if (!reasons.length) reasons.push({ code: 'company', text: `Works at ${c.company}.` });
    out.push({ contactId: c.id, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || (a.contactId < b.contactId ? -1 : 1));
}
