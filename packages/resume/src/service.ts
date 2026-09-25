// ResumeService: the resume lane's stateful part. Base resumes (each with a target title), tailored versions
// linked to their job and base, tailoring proposals the person reviews change by change, cover letters, exports and
// the readability check. It owns the tables resumes, tailor_proposals and cover_letters and the files in
// files/resumes/ (inside the data folder only).

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AtsReport, CoverLetter, Job, KeywordGapReport, Profile, ProfileInput, Resume, ResumeDocument, TailorProposal } from '@jobleft/contracts';
import { nowMs } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import type { SkillDictionary } from '@jobleft/static-data';
import { mapAiError } from './ai.ts';
import { atsCheckPdf } from './ats.ts';
import { migrateResume } from './db.ts';
import { documentFromProfile } from './document.ts';
import { ResumeError } from './errors.ts';
import { keywordGaps, safeDictionary } from './gaps.ts';
import { importResume, type ImportOutcome } from './import/index.ts';
import { draftLetter, editLetter } from './letter.ts';
import { fitResume } from './render/layout.ts';
import { renderLetterDocx, renderLetterPdf, renderResumeDocx, renderResumePdf } from './render/index.ts';
import { linkedToProfile, snapshotOf, syncBaseDocument } from './sync.ts';
import { applyChanges, draftTailoring, type TailorOp } from './tailor.ts';
import { checkDocument, checkLetter, headerName } from './truth.ts';

export interface ResumeServiceOptions {
  db: DatabaseSync;
  /** $JOBLEFT_HOME/files/resumes (uploaded files and exports, inside the data folder only). */
  filesDir: string;
  profile: () => Profile;
  job: (id: string) => Job | null;
  /** The chosen AI provider; throws AiError('no_provider') when none is set. */
  ai: () => AiClient;
  skills: SkillDictionary;
  now?: () => number;
}

interface Row {
  id: string; name: string; target_title: string | null; is_primary: number; kind: 'base' | 'tailored'; base_resume_id: string | null;
  job_id: string | null; job_label_json: string | null; version: number; file_json: string | null; document_json: string;
  import_report_json: string | null; proposed_profile_json: string | null; snapshot_json: string | null; snapshot_source: string | null;
  ats_report_json: string | null; proposal_id: string | null; created_at: string; updated_at: string;
}

interface LetterRow { id: string; job_id: string; resume_id: string; text: string; violations_json: string; ready: number; extra_json: string | null; created_at: string; updated_at: string }

const parse = <T>(s: string | null): T | null => (s === null ? null : JSON.parse(s) as T);

export function profileIsEmpty(p: Profile): boolean {
  return !headerName(p) && !p.work.length && !p.education.length && !p.skills.length;
}

function safeFileName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._ -]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 80) || 'resume';
}

export interface ExportedFile { fileName: string; mimeType: string; bytes: Uint8Array; leftOut: string[] }

export class ResumeService {
  readonly #o: ResumeServiceOptions;
  readonly #now: () => number;

  constructor(opts: ResumeServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => nowMs());
    migrateResume(opts.db);
    // Deleted resume text is overwritten in the database file, not left in free pages (i-resume O15).
    try { opts.db.exec('PRAGMA secure_delete = ON'); } catch { /* older SQLite: best effort */ }
    if (!existsSync(opts.filesDir)) mkdirSync(opts.filesDir, { recursive: true, mode: 0o700 });
  }

  #iso(): string { return new Date(this.#now()).toISOString(); }

  #row(id: string): Row | null {
    return (this.#o.db.prepare('SELECT * FROM resumes WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  #mustRow(id: string): Row {
    const r = this.#row(id);
    if (!r) throw new ResumeError('not_found', 'No resume with that id.');
    return r;
  }

  #profile(): Profile {
    return this.#o.profile();
  }

  #ai(): AiClient | null {
    try {
      return this.#o.ai();
    } catch (e) {
      if ((e as { code?: string }).code === 'no_provider') return null;
      throw mapAiError(e);
    }
  }

  /** A base resume's document, brought in step with the current profile (stored back when it changed). */
  #synced(r: Row): ResumeDocument {
    const doc = JSON.parse(r.document_json) as ResumeDocument;
    if (r.kind !== 'base' || !r.snapshot_json) return doc;
    const profile = this.#profile();
    if (profileIsEmpty(profile)) return doc;
    const old = JSON.parse(r.snapshot_json) as ProfileInput;
    const mode = r.snapshot_source === 'import' ? 'import' : 'profile';
    const next = syncBaseDocument(doc, old, profile, mode);
    const linked = mode === 'import' && linkedToProfile(next, profile);
    const snapNow = snapshotOf(profile);
    const changed = JSON.stringify(next) !== r.document_json;
    const snapChanged = JSON.stringify(snapNow) !== r.snapshot_json;
    if (changed || snapChanged || linked) {
      // An import keeps its snapshot until the person adopts it into the profile; then it follows the profile.
      const newSource = mode === 'profile' || linked ? 'profile' : 'import';
      const snap = newSource === 'profile' ? JSON.stringify(snapNow) : r.snapshot_json;
      this.#o.db.prepare('UPDATE resumes SET document_json = ?, snapshot_json = ?, snapshot_source = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), snap, newSource, changed ? this.#iso() : r.updated_at, r.id);
    }
    return next;
  }

  #toResume(r: Row, doc?: ResumeDocument): Resume {
    return {
      id: r.id, name: r.name, targetTitle: r.target_title, isPrimary: !!r.is_primary, kind: r.kind, baseResumeId: r.base_resume_id,
      jobId: r.job_id, version: r.version, file: parse(r.file_json), document: doc ?? this.#synced(r), importReport: parse(r.import_report_json),
      atsReport: parse(r.ats_report_json), createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  // ---------------------------------------------------------------------------------------------- resumes

  list(): Resume[] {
    const rows = this.#o.db.prepare('SELECT * FROM resumes ORDER BY created_at, rowid').all() as unknown as Row[];
    const bases = rows.filter((r) => r.kind === 'base').sort((a, b) => b.is_primary - a.is_primary);
    const out: Resume[] = [];
    for (const b of bases) {
      out.push(this.#toResume(b));
      for (const v of rows.filter((r) => r.kind === 'tailored' && r.base_resume_id === b.id)) out.push(this.#toResume(v));
    }
    for (const v of rows.filter((r) => r.kind === 'tailored' && !bases.some((b) => b.id === r.base_resume_id))) out.push(this.#toResume(v));
    return out;
  }

  /** Version rows carry a small label of their job (title, company), kept even if the job is gone later. */
  jobLabel(id: string): { title: string; company: string } | null {
    const r = this.#row(id);
    return r ? parse(r.job_label_json) : null;
  }

  async import(bytes: Uint8Array, fileName: string, mimeType: string): Promise<{ resume: Resume; proposedProfile: ProfileInput; outcome: ImportOutcome }> {
    const outcome = await importResume(bytes, fileName, mimeType);
    if (outcome.report.outcome === 'failed') {
      const f = outcome.report.failure;
      const code = f === 'too_large' ? 'payload_too_large' : f === 'unsupported_type' ? 'unsupported_media_type' : 'bad_request';
      throw new ResumeError(code, outcome.message ?? 'The file could not be read.', { report: outcome.report });
    }
    const id = `res_${randomUUID()}`;
    const ext = outcome.kind === 'pdf' ? 'pdf' : outcome.kind === 'docx' ? 'docx' : 'txt';
    const path = join(this.#o.filesDir, `${id}.${ext}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    const { createHash } = await import('node:crypto');
    const file = { fileName: fileName.slice(0, 200), mimeType: mimeType || (ext === 'pdf' ? 'application/pdf' : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain'), bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    const now = this.#iso();
    const hasPrimary = !!this.#o.db.prepare(`SELECT 1 FROM resumes WHERE kind = 'base' AND is_primary = 1`).get();
    const name = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 200) || 'Imported resume';
    this.#o.db.prepare(`INSERT INTO resumes (id, name, target_title, is_primary, kind, version, file_json, document_json, import_report_json, proposed_profile_json, snapshot_json, snapshot_source, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'base', 1, ?, ?, ?, ?, ?, 'import', ?, ?)`).run(
      id, name, hasPrimary ? 0 : 1, JSON.stringify(file), JSON.stringify(outcome.document), JSON.stringify(outcome.report),
      JSON.stringify(outcome.proposedProfile), JSON.stringify(outcome.proposedProfile), now, now);
    return { resume: this.#toResume(this.#mustRow(id), outcome.document), proposedProfile: outcome.proposedProfile, outcome };
  }

  /** The profile an import proposed (for "adopt this import"). */
  proposedProfile(id: string): ProfileInput | null {
    return parse(this.#mustRow(id).proposed_profile_json);
  }

  create(input: { name: string; targetTitle?: string }): Resume {
    const profile = this.#profile();
    if (profileIsEmpty(profile)) throw new ResumeError('needs_profile', 'Your profile is empty. Import a resume or fill in your profile first.');
    const name = input.name.trim();
    if (!name) throw new ResumeError('bad_request', 'Give the resume a name.');
    const id = `res_${randomUUID()}`;
    const now = this.#iso();
    const hasPrimary = !!this.#o.db.prepare(`SELECT 1 FROM resumes WHERE kind = 'base' AND is_primary = 1`).get();
    const doc = documentFromProfile(profile);
    this.#o.db.prepare(`INSERT INTO resumes (id, name, target_title, is_primary, kind, version, document_json, snapshot_json, snapshot_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'base', 1, ?, ?, 'profile', ?, ?)`).run(id, name.slice(0, 200), input.targetTitle?.trim() || null, hasPrimary ? 0 : 1, JSON.stringify(doc), JSON.stringify(snapshotOf(profile)), now, now);
    return this.#toResume(this.#mustRow(id), doc);
  }

  get(id: string): Resume | null {
    const r = this.#row(id);
    return r ? this.#toResume(r) : null;
  }

  update(id: string, patch: { name?: string; targetTitle?: string | null; isPrimary?: boolean; document?: ResumeDocument }): Resume {
    const r = this.#mustRow(id);
    const now = this.#iso();
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new ResumeError('bad_request', 'The name cannot be empty.');
      this.#o.db.prepare('UPDATE resumes SET name = ?, updated_at = ? WHERE id = ?').run(patch.name.trim().slice(0, 200), now, id);
    }
    if (patch.targetTitle !== undefined) this.#o.db.prepare('UPDATE resumes SET target_title = ?, updated_at = ? WHERE id = ?').run(patch.targetTitle?.trim() || null, now, id);
    if (patch.isPrimary) {
      if (r.kind !== 'base') throw new ResumeError('bad_request', 'Only a base resume can be the primary one.');
      this.#o.db.exec('BEGIN');
      this.#o.db.prepare(`UPDATE resumes SET is_primary = 0 WHERE kind = 'base'`).run();
      this.#o.db.prepare('UPDATE resumes SET is_primary = 1, updated_at = ? WHERE id = ?').run(now, id);
      this.#o.db.exec('COMMIT');
    }
    if (patch.document) {
      const profile = this.#profile();
      const doc: ResumeDocument = { ...structuredClone(patch.document), header: r.kind === 'base' ? documentFromProfile(profile).header : (JSON.parse(r.document_json) as ResumeDocument).header };
      const v = checkDocument(doc, profile, null);
      if (v.length) throw new ResumeError('bad_request', `These edits hold facts that are not in your profile: ${v.slice(0, 5).map((x) => `"${x.fact}"`).join(', ')}. Add them to your profile first if they are true.`, { violations: v });
      this.#o.db.prepare('UPDATE resumes SET document_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(doc), now, id);
    }
    return this.#toResume(this.#mustRow(id));
  }

  /** Refuses (conflict) to delete a base with versions or letters unless withVersions is true. */
  delete(id: string, withVersions: boolean): string[] {
    const r = this.#mustRow(id);
    const versions = r.kind === 'base' ? (this.#o.db.prepare(`SELECT id FROM resumes WHERE base_resume_id = ?`).all(id) as Array<{ id: string }>).map((x) => x.id) : [];
    const ids = [id, ...versions];
    const letters = (this.#o.db.prepare(`SELECT id FROM cover_letters WHERE resume_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string }>).map((x) => x.id);
    if ((versions.length || letters.length) && !withVersions) {
      throw new ResumeError('conflict', `This resume has ${versions.length} tailored version${versions.length === 1 ? '' : 's'} and ${letters.length} cover letter${letters.length === 1 ? '' : 's'}. Nothing was deleted. Delete them too (withVersions=true), or keep the resume.`, { versions, letters });
    }
    this.#o.db.exec('BEGIN');
    try {
      const ph = ids.map(() => '?').join(',');
      this.#o.db.prepare(`DELETE FROM cover_letters WHERE resume_id IN (${ph})`).run(...ids);
      this.#o.db.prepare(`DELETE FROM tailor_proposals WHERE resume_id IN (${ph})`).run(...ids);
      this.#o.db.prepare(`DELETE FROM resumes WHERE id IN (${ph})`).run(...ids);
      if (r.is_primary) {
        const next = this.#o.db.prepare(`SELECT id FROM resumes WHERE kind = 'base' ORDER BY created_at LIMIT 1`).get() as { id: string } | undefined;
        if (next) this.#o.db.prepare('UPDATE resumes SET is_primary = 1 WHERE id = ?').run(next.id);
      }
      this.#o.db.exec('COMMIT');
    } catch (e) {
      this.#o.db.exec('ROLLBACK');
      throw e;
    }
    for (const x of ids) for (const ext of ['pdf', 'docx', 'txt']) rmSync(join(this.#o.filesDir, `${x}.${ext}`), { force: true });
    // Push the deletion through the write-ahead log too, so no copy of the deleted text stays in the -wal file.
    try { this.#o.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL mode, or busy: best effort */ }
    return [...ids, ...letters];
  }

  // ---------------------------------------------------------------------------------------------- tailoring

  #job(jobId: string): Job {
    const j = this.#o.job(jobId);
    if (!j) throw new ResumeError('not_found', 'No job with that id.');
    return j;
  }

  async tailor(resumeId: string, jobId: string, opts: { instruction?: string; useAi?: boolean } = {}): Promise<TailorProposal> {
    const r = this.#mustRow(resumeId);
    if (r.kind !== 'base') throw new ResumeError('bad_request', 'Pick a base resume to tailor from (this one is already a tailored version).');
    const profile = this.#profile();
    if (profileIsEmpty(profile)) throw new ResumeError('needs_profile', 'Your profile is empty. Import a resume or fill in your profile first.');
    const job = this.#job(jobId);
    const base = this.#synced(r);
    const ai = opts.useAi === false ? null : this.#ai();
    const proposalId = `tp_${randomUUID()}`;
    const draft = await draftTailoring({ profile, job, base, resumeId, skills: this.#o.skills, ai, instruction: opts.instruction ?? null, proposalId });
    this.#o.db.prepare(`INSERT INTO tailor_proposals (id, resume_id, job_id, proposal_json, ops_json, base_document_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(proposalId, resumeId, jobId, JSON.stringify(draft.proposal), JSON.stringify(draft.ops), JSON.stringify(base), draft.proposal.createdAt);
    return draft.proposal;
  }

  proposal(id: string): { proposal: TailorProposal; state: string } | null {
    const p = this.#o.db.prepare('SELECT proposal_json, state FROM tailor_proposals WHERE id = ?').get(id) as { proposal_json: string; state: string } | undefined;
    return p ? { proposal: JSON.parse(p.proposal_json) as TailorProposal, state: p.state } : null;
  }

  /** Nothing is saved: the proposal is marked rejected and the base stays as it is. */
  reject(proposalId: string): void {
    this.#o.db.prepare(`UPDATE tailor_proposals SET state = 'rejected', decided_at = ? WHERE id = ? AND state = 'pending'`).run(this.#iso(), proposalId);
  }

  accept(resumeId: string, proposalId: string, acceptChangeIds: string[]): Resume {
    const p = this.#o.db.prepare('SELECT * FROM tailor_proposals WHERE id = ?').get(proposalId) as { resume_id: string; job_id: string; ops_json: string; base_document_json: string; state: string } | undefined;
    if (!p || p.resume_id !== resumeId) throw new ResumeError('not_found', 'No tailoring draft with that id for this resume.');
    if (p.state !== 'pending') throw new ResumeError('conflict', `This draft was already ${p.state}. Tailor again to make a new one.`);
    const ids = [...new Set(acceptChangeIds)];
    if (!ids.length) {
      this.reject(proposalId);
      throw new ResumeError('conflict', 'No change was accepted, so no tailored version was saved. The base resume is unchanged.');
    }
    const ops = JSON.parse(p.ops_json) as TailorOp[];
    const base = JSON.parse(p.base_document_json) as ResumeDocument;
    const doc = applyChanges(base, ops, ids);
    const job = this.#job(p.job_id);
    const profile = this.#profile();
    const v = checkDocument(doc, profile, job);
    if (v.length) throw new ResumeError('conflict', `Your profile changed since this draft was made, and ${v.length === 1 ? 'a fact' : 'some facts'} no longer trace${v.length === 1 ? 's' : ''} to it (for example "${v[0]!.fact}"). Tailor again.`, { violations: v });
    const baseRow = this.#mustRow(resumeId);
    const ver = (this.#o.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM resumes WHERE base_resume_id = ? AND job_id = ?').get(resumeId, p.job_id) as { v: number }).v + 1;
    const id = `res_${randomUUID()}`;
    const now = this.#iso();
    const label = { title: job.title.slice(0, 120), company: job.company.slice(0, 120) };
    this.#o.db.exec('BEGIN');
    try {
      this.#o.db.prepare(`INSERT INTO resumes (id, name, target_title, is_primary, kind, base_resume_id, job_id, job_label_json, version, document_json, proposal_id, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'tailored', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, `${baseRow.name} for ${label.title} (${label.company})`.slice(0, 200), baseRow.target_title, resumeId, p.job_id, JSON.stringify(label), ver, JSON.stringify(doc), proposalId, now, now);
      this.#o.db.prepare(`UPDATE tailor_proposals SET state = 'accepted', decided_at = ? WHERE id = ?`).run(now, proposalId);
      this.#o.db.exec('COMMIT');
    } catch (e) {
      this.#o.db.exec('ROLLBACK');
      throw e;
    }
    return this.#toResume(this.#mustRow(id), doc);
  }

  // ---------------------------------------------------------------------------------------------- output

  #doc(resumeId: string): { row: Row; doc: ResumeDocument } {
    const row = this.#mustRow(resumeId);
    return { row, doc: this.#synced(row) };
  }

  async fitCheck(resumeId: string): Promise<{ fitsOnePage: boolean; leftOut: string[] }> {
    const fit = fitResume(this.#doc(resumeId).doc);
    return { fitsOnePage: fit.leftOut.length === 0, leftOut: fit.leftOut };
  }

  async export(resumeId: string, format: 'pdf' | 'docx'): Promise<ExportedFile> {
    const { row, doc } = this.#doc(resumeId);
    // An uploaded resume that was never edited comes back as the person's own file, byte for byte, when the format
    // matches. Anything edited or tailored is rendered from the document.
    if (row.kind === 'base' && row.version === 1 && row.file_json) {
      const file = parse<{ fileName?: string; mimeType?: string }>(row.file_json);
      const path = join(this.#o.filesDir, `${row.id}.${format}`);
      const mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (file?.mimeType === mime && existsSync(path)) {
        return { fileName: file.fileName || `${row.id}.${format}`, mimeType: mime, bytes: new Uint8Array(readFileSync(path)), leftOut: [] };
      }
    }
    const base = safeFileName(`${doc.header.name || 'Resume'}_${row.kind === 'tailored' ? (parse<{ company: string }>(row.job_label_json)?.company ?? 'job') : row.name}`);
    if (format === 'pdf') {
      const r = renderResumePdf(doc);
      return { fileName: `${base}.pdf`, mimeType: 'application/pdf', bytes: r.bytes, leftOut: r.leftOut };
    }
    const r = renderResumeDocx(doc);
    return { fileName: `${base}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: r.bytes, leftOut: r.leftOut };
  }

  async atsCheck(resumeId: string): Promise<AtsReport> {
    const file = await this.export(resumeId, 'pdf');
    const rep = await atsCheckPdf(file.bytes);
    this.#o.db.prepare('UPDATE resumes SET ats_report_json = ? WHERE id = ?').run(JSON.stringify(rep), resumeId);
    return rep;
  }

  keywordGaps(jobId: string, resumeId: string): KeywordGapReport {
    const job = this.#job(jobId);
    const { doc } = this.#doc(resumeId);
    return keywordGaps(job, doc, this.#profile(), safeDictionary(this.#o.skills), resumeId);
  }

  // ---------------------------------------------------------------------------------------------- cover letters

  #letter(r: LetterRow): CoverLetter {
    const extra = parse<{ gaps?: string[]; notice?: string | null; provider?: string; costMicros?: number | null }>(r.extra_json) ?? {};
    return {
      id: r.id, jobId: r.job_id, resumeId: r.resume_id, text: r.text, violations: JSON.parse(r.violations_json), ready: !!r.ready,
      createdAt: r.created_at, updatedAt: r.updated_at, gaps: extra.gaps ?? [], notice: extra.notice ?? null, provider: extra.provider ?? 'none',
      costMicros: extra.costMicros ?? null,
    };
  }

  #letterRow(id: string): LetterRow {
    const r = this.#o.db.prepare('SELECT * FROM cover_letters WHERE id = ?').get(id) as LetterRow | undefined;
    if (!r) throw new ResumeError('not_found', 'No cover letter with that id.');
    return r;
  }

  coverLetters(jobId: string): CoverLetter[] {
    return (this.#o.db.prepare('SELECT * FROM cover_letters WHERE job_id = ? ORDER BY created_at, rowid').all(jobId) as unknown as LetterRow[]).map((r) => this.#letter(r));
  }

  getCoverLetter(id: string): CoverLetter {
    return this.#letter(this.#letterRow(id));
  }

  async createCoverLetter(jobId: string, resumeId: string, opts: { useAi?: boolean } = {}): Promise<CoverLetter> {
    const job = this.#job(jobId);
    const { doc } = this.#doc(resumeId);
    const profile = this.#profile();
    if (profileIsEmpty(profile)) throw new ResumeError('needs_profile', 'Your profile is empty. Import a resume or fill in your profile first.');
    const ai = opts.useAi === false ? null : this.#ai();
    const res = await draftLetter({ profile, job, resume: doc, skills: this.#o.skills, ai });
    const violations = checkLetter(res.text, profile, job);
    const id = `cl_${randomUUID()}`;
    const now = this.#iso();
    this.#o.db.prepare('INSERT INTO cover_letters (id, job_id, resume_id, text, violations_json, ready, extra_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, jobId, resumeId, res.text, JSON.stringify(violations), violations.length ? 0 : 1, JSON.stringify({ gaps: res.gaps, notice: res.notice, provider: res.provider, costMicros: res.costMicros }), now, now);
    return this.getCoverLetter(id);
  }

  async updateCoverLetter(id: string, patch: { text?: string; instruction?: string }, opts: { useAi?: boolean } = {}): Promise<CoverLetter> {
    const r = this.#letterRow(id);
    const job = this.#job(r.job_id);
    const profile = this.#profile();
    const extra = parse<{ gaps?: string[]; notice?: string | null; provider?: string; costMicros?: number | null; history?: string[] }>(r.extra_json) ?? {};
    let text = r.text;
    let notice: string | null = null;
    let gaps = extra.gaps ?? [];
    let provider = extra.provider ?? 'none';
    let costMicros: number | null = null;
    if (patch.text !== undefined) {
      if (!patch.text.trim()) throw new ResumeError('bad_request', 'The letter cannot be empty.');
      text = patch.text.replace(/\r\n?/g, '\n');
      provider = 'you';
    }
    if (patch.instruction !== undefined && patch.instruction.trim()) {
      const resumeDoc = this.#row(r.resume_id) ? this.#doc(r.resume_id).doc : documentFromProfile(profile);
      const ai = opts.useAi === false ? null : this.#ai();
      const res = await editLetter({ current: text, instruction: patch.instruction, profile, job, resume: resumeDoc, skills: this.#o.skills, ai });
      text = res.text;
      notice = res.notice;
      gaps = [...new Set([...gaps, ...res.gaps])];
      if (res.changed) provider = res.provider;
      costMicros = res.costMicros;
    }
    const violations = checkLetter(text, profile, job);
    if (violations.length && !notice) notice = `This letter holds ${violations.length === 1 ? 'a fact' : 'facts'} that ${violations.length === 1 ? 'is' : 'are'} not in your profile, so it is not ready: ${violations.slice(0, 5).map((v) => `"${v.fact}"`).join(', ')}.`;
    const history = [...(extra.history ?? []), r.text].slice(-10);
    this.#o.db.prepare('UPDATE cover_letters SET text = ?, violations_json = ?, ready = ?, extra_json = ?, updated_at = ? WHERE id = ?')
      .run(text, JSON.stringify(violations), violations.length ? 0 : 1, JSON.stringify({ gaps, notice, provider, costMicros, history }), this.#iso(), id);
    return this.getCoverLetter(id);
  }

  async exportCoverLetter(id: string, format: 'pdf' | 'docx'): Promise<ExportedFile> {
    const r = this.#letterRow(id);
    if (!r.ready) {
      const v = JSON.parse(r.violations_json) as Array<{ fact: string }>;
      throw new ResumeError('conflict', `This letter is not ready: it holds ${v.length === 1 ? 'a fact' : 'facts'} that ${v.length === 1 ? 'is' : 'are'} not in your profile (${v.slice(0, 5).map((x) => `"${x.fact}"`).join(', ')}). Remove ${v.length === 1 ? 'it' : 'them'}, or add ${v.length === 1 ? 'it' : 'them'} to your profile first, then export.`, { violations: v });
    }
    const job = this.#o.job(r.job_id);
    const base = safeFileName(`Cover_letter_${job?.company ?? 'job'}`);
    if (format === 'pdf') return { fileName: `${base}.pdf`, mimeType: 'application/pdf', bytes: renderLetterPdf(r.text), leftOut: [] };
    return { fileName: `${base}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: renderLetterDocx(r.text), leftOut: [] };
  }
}
