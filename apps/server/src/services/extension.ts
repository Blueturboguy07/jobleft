// The paired extension's calls: status, fill and review (docs/INTERFACES.md section 7).
// INTERIM fill engine: conservative matching of form labels to profile facts. It fills only what it is sure of
// (identity, contact, address, links, the resume file, and answers the person saved), leaves everything else empty
// and listed, never answers pay, age, date of birth, criminal history or ID numbers, and answers equal-employment
// and work-authorization questions only from the person's own saved answers. The extension lane's answer engine
// replaces it at integration.

import type { DatabaseSync } from 'node:sqlite';
import {
  EXTENSION_PROTOCOL_VERSION, nowIso, type ExtensionStatus, type FillRequest, type FillResponse, type FormField, type Profile,
  type ReviewResponse, type ReviewResult,
} from '@jobleft/contracts';
import type { AppData } from '../app.ts';
import { newId, tx } from '../db/util.ts';
import { missingProfileFields } from '../interim/profile.ts';
import { APP_VERSION } from '../version.ts';

type Fill = FillResponse['fills'][number];

const NEVER = /salary|compensation|pay (expectation|range|requirement)|desired pay|expected pay|\bage\b|date of birth|birth ?date|\bdob\b|criminal|convict|felony|social security|\bssn\b|national id|passport|driver'?s licen[cs]e number/i;
const NOT_ME = /refer|reference|emergency|manager'?s|supervisor|recruiter|hiring|company name|employer name|school name/i;
const EEO = /gender|\bsex\b|race|ethnic|hispanic|latin[oa]|veteran|disab|sexual|orientation|lgbt|pronoun|transgender/i;

function labelKey(s: string): string {
  return s.toLowerCase().replace(/[*:?]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function norm(s: string): string { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

/** Picks the option that states the value: exact first, then a whole-word containment (needs review). */
function pickOption(f: FormField, wanted: string[]): { value: string; confidence: 'exact' | 'likely' } | null {
  const want = wanted.map(norm).filter(Boolean);
  for (const o of f.options) if (want.includes(norm(o.label)) || want.includes(norm(o.value))) return { value: o.value, confidence: 'exact' };
  const hits = f.options.filter((o) => want.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(norm(o.label))));
  return hits.length === 1 ? { value: hits[0]!.value, confidence: 'likely' } : null;
}

function countryName(code: string): string | null {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? null; } catch { return null; }
}

function linkFor(p: Profile, re: RegExp): string | null {
  return p.personal.links.find((l) => re.test(l.url) || re.test(l.label))?.url ?? null;
}

export class ExtensionService {
  private readonly d: AppData;
  constructor(d: AppData) { this.d = d; }

  status(): ExtensionStatus {
    const p = this.d.profile.get();
    const missing = missingProfileFields(p);
    return { paired: true, appVersion: APP_VERSION, protocolVersion: EXTENSION_PROTOCOL_VERSION, profileComplete: missing.length === 0, missingProfileFields: missing };
  }

  private savedAnswers(): Map<string, string> {
    return new Map((this.d.db.prepare('SELECT label_key, value FROM srv_saved_answers').all() as Array<{ label_key: string; value: string }>).map((r) => [r.label_key, r.value]));
  }

  fill(req: FillRequest): FillResponse {
    const p = this.d.profile.get();
    const saved = this.savedAnswers();
    const jobId = this.d.jobs.findByUrl(req.pageUrl);
    const fills: Fill[] = [];
    const unknown: string[] = [];
    const files: FillResponse['files'] = [];
    const warnings: string[] = [];
    const usedIdentity = new Set<string>();
    const fullName = [p.personal.firstName, p.personal.middleName, p.personal.lastName].filter(Boolean).join(' ');

    const put = (f: FormField, value: string | null, source: Fill['source'], topic: string | null) => {
      if (!value) { unknown.push(f.fieldId); return; }
      if (topic && usedIdentity.has(topic)) { unknown.push(f.fieldId); return; }
      if (f.kind === 'select' || f.kind === 'radio') {
        const alt = topic === 'country' ? [value, countryName(value) ?? value] : [value];
        const o = pickOption(f, alt);
        if (!o) { unknown.push(f.fieldId); return; }
        fills.push({ fieldId: f.fieldId, values: [o.value], source, confidence: o.confidence, needsReview: o.confidence !== 'exact' });
      } else {
        if (f.maxLength !== null && [...value].length > f.maxLength) { unknown.push(f.fieldId); return; }
        fills.push({ fieldId: f.fieldId, values: [value], source, confidence: 'exact', needsReview: false });
      }
      if (topic) usedIdentity.add(topic);
    };

    for (const f of req.fields) {
      const text = `${f.label} ${f.name ?? ''}`.trim();
      const key = labelKey(f.label);
      if (NEVER.test(text)) { unknown.push(f.fieldId); continue; }
      if (f.kind === 'file') {
        if (/resume|\bcv\b|curriculum/i.test(text)) {
          const rid = this.d.resumes.pick(req.resumeId, jobId);
          const file = rid ? this.d.resumes.file(rid) : null;
          if (file) files.push({ fieldId: f.fieldId, fileName: file.fileName, mimeType: file.mimeType, base64: file.bytes.toString('base64') });
          else { unknown.push(f.fieldId); warnings.push('No resume file is saved yet, so the resume field stays empty.'); }
        } else unknown.push(f.fieldId);
        continue;
      }
      const savedValue = saved.get(key);
      if (EEO.test(text) || /sponsor|authori[sz]ed to work|legally (eligible|authori[sz]ed)|work permit|citizen/i.test(text)) {
        // Sensitive: only the person's own saved answer.
        let v: string | null = savedValue ?? null;
        if (!v) {
          const e = p.eeo, w = p.workAuthorization;
          const yn = (x: string | null) => (x === 'yes' ? 'Yes' : x === 'no' ? 'No' : x === 'decline' ? 'Decline' : null);
          if (/sponsor/i.test(text)) v = yn(w.needsSponsorship);
          else if (/authori[sz]ed to work|legally/i.test(text)) v = yn(w.usAuthorized);
          else if (/veteran/i.test(text)) v = yn(e.veteran);
          else if (/disab/i.test(text)) v = yn(e.disability);
          else if (/hispanic|latin/i.test(text)) v = yn(e.hispanicOrLatino);
          else if (/gender|\bsex\b/i.test(text)) v = e.gender;
          else if (/race|ethnic/i.test(text)) v = e.race;
          else if (/pronoun/i.test(text)) v = e.pronouns;
        }
        if (v && (f.kind === 'select' || f.kind === 'radio')) {
          const o = pickOption(f, v === 'Decline' ? ['decline to self identify', 'decline to state', 'prefer not to say', 'i do not wish to answer', 'decline'] : [v]);
          if (o) fills.push({ fieldId: f.fieldId, values: [o.value], source: EEO.test(text) ? 'eeo' : 'saved_answer', confidence: o.confidence, needsReview: true });
          else unknown.push(f.fieldId);
        } else if (v && f.kind !== 'checkbox') {
          fills.push({ fieldId: f.fieldId, values: [v], source: EEO.test(text) ? 'eeo' : 'saved_answer', confidence: 'exact', needsReview: true });
        } else unknown.push(f.fieldId);
        continue;
      }
      if (savedValue !== undefined) { put(f, savedValue, 'saved_answer', null); continue; }
      if (NOT_ME.test(text)) { unknown.push(f.fieldId); continue; }
      if (/first\s*name|given\s*name|forename/i.test(text)) put(f, p.personal.firstName, 'profile', 'first');
      else if (/last\s*name|surname|family\s*name/i.test(text)) put(f, p.personal.lastName, 'profile', 'last');
      else if (/middle\s*name/i.test(text)) put(f, p.personal.middleName, 'profile', 'middle');
      else if (/^(full |legal |your )?name\b/i.test(f.label.trim()) || /full\s*name/i.test(text)) put(f, fullName || null, 'profile', 'name');
      else if (f.kind === 'email' || /e-?mail/i.test(text)) put(f, p.personal.email, 'profile', /confirm|re-?enter/i.test(text) ? null : 'email');
      else if (f.kind === 'tel' || /phone|mobile|cell/i.test(text)) put(f, p.personal.phone, 'profile', 'phone');
      else if (/linkedin/i.test(text)) put(f, linkFor(p, /linkedin/i), 'profile', 'linkedin');
      else if (/github/i.test(text)) put(f, linkFor(p, /github/i), 'profile', 'github');
      else if (/website|portfolio|personal (site|url)/i.test(text)) put(f, p.personal.links.find((l) => !/linkedin|github/i.test(l.url))?.url ?? null, 'profile', 'website');
      else if (/zip|postal/i.test(text)) put(f, p.personal.postalCode, 'profile', 'postal');
      else if (/\bcity\b/i.test(text)) put(f, p.personal.city, 'profile', 'city');
      else if (/\bstate\b|province|region/i.test(text)) put(f, p.personal.region, 'profile', 'region');
      else if (/country/i.test(text)) put(f, p.personal.country, 'profile', 'country');
      else if (/address|street/i.test(text)) put(f, p.personal.addressLine, 'profile', 'address');
      else if (/^(current )?location$/i.test(f.label.trim())) put(f, [p.personal.city, p.personal.region].filter(Boolean).join(', ') || null, 'profile', 'location');
      else unknown.push(f.fieldId);
    }
    return { requestId: req.requestId, jobId, fills, drafts: [], unknownFieldIds: unknown, files, warnings };
  }

  review(r: ReviewResult, extensionId: string | null): ReviewResponse {
    const jobId = r.jobId && this.d.jobs.exists(r.jobId) ? r.jobId : this.d.jobs.findByUrl(r.pageUrl);
    const now = nowIso();
    tx(this.d.db, () => {
      this.d.db.prepare(`INSERT OR IGNORE INTO srv_extension_reviews (request_id, extension_id, job_id, page_url, ats, submitted, filled, edited, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.requestId, extensionId, jobId, r.pageUrl, r.ats, r.submittedByUser ? 1 : 0, r.filledFieldIds.length, r.editedFieldIds.length, r.at);
      for (const a of r.savedAnswers) {
        const key = labelKey(a.label);
        if (!key || NEVER.test(a.label)) continue;
        this.d.db.prepare(`INSERT INTO srv_saved_answers (id, label, label_key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(label_key) DO UPDATE SET label = excluded.label, value = excluded.value, updated_at = excluded.updated_at`)
          .run(newId('ans'), a.label, key, a.value, now, now);
      }
    });
    if (r.submittedByUser && jobId) {
      const cur = this.d.tracker.get(jobId);
      if (!cur || cur.status === null) return { trackerEntry: this.d.tracker.patch(jobId, { status: 'applied' }) };
      return { trackerEntry: cur };
    }
    return { trackerEntry: jobId ? this.d.tracker.get(jobId) : null };
  }
}
