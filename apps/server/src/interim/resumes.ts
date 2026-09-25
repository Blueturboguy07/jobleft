// INTERIM stand-in for @jobleft/resume ResumeService: resume records (table srv_resumes) and uploaded files
// (files/resumes/, inside the data folder only). Reading the text of an upload, tailoring, rendering and the ATS
// check arrive with the resume lane; until then an upload is kept byte for byte and its report says so plainly.
//
// Save order (server O4): the file is written to a temporary name, flushed and renamed, then the record is saved in
// one transaction. A failed record removes the file; a file with no record (a crash in between) is removed at the
// next start. So a confirmed upload has both, and no record points at a missing file.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ResumeDocumentSchema, nowIso, type ImportReport, type Profile, type ProfileInput, type Resume, type ResumeDocument,
  type ResumeSection,
} from '@jobleft/contracts';
import { b, newId, parseJson, prune, tx } from '../db/util.ts';
import { ApiFailure, storageProblem, writeFailed } from '../errors.ts';

export const PDF = 'application/pdf';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface Row {
  id: string; name: string; target_title: string | null; is_primary: number; kind: string; base_resume_id: string | null;
  job_id: string | null; version: number; file_name: string | null; file_mime: string | null; file_bytes: number | null;
  file_sha256: string | null; file_path: string | null; document: string; import_report: string | null;
  ats_report: string | null; created_at: string; updated_at: string;
}

function headerFrom(p: Profile): ResumeDocument['header'] {
  const name = [p.personal.firstName, p.personal.middleName, p.personal.lastName].filter((x): x is string => !!x).join(' ');
  return { name, email: p.personal.email, phone: p.personal.phone, city: p.personal.city, links: p.personal.links };
}

/** A base resume document from the profile: every line is copied from the profile, nothing is added. */
export function documentFromProfile(p: Profile): ResumeDocument {
  const sections: ResumeSection[] = [];
  if (p.summary) sections.push({ id: 'summary', kind: 'summary', title: 'Summary', text: p.summary, items: [] });
  if (p.work.length) {
    sections.push({
      id: 'experience', kind: 'experience', title: 'Experience', text: null,
      items: p.work.map((w) => ({ id: w.id, heading: w.company, subheading: w.title, location: w.location, startDate: w.startDate, endDate: w.endDate, current: w.current, bullets: [...w.bullets], tags: [] })),
    });
  }
  if (p.education.length) {
    sections.push({
      id: 'education', kind: 'education', title: 'Education', text: null,
      items: p.education.map((e) => ({ id: e.id, heading: e.school, subheading: [e.degree, e.major].filter(Boolean).join(', ') || null, location: null, startDate: e.startDate, endDate: e.endDate, current: e.current, bullets: [...e.achievements], tags: [] })),
    });
  }
  if (p.projects.length) {
    sections.push({
      id: 'projects', kind: 'projects', title: 'Projects', text: null,
      items: p.projects.map((pr) => ({ id: pr.id, heading: pr.name, subheading: null, location: null, startDate: pr.startDate, endDate: pr.endDate, current: false, bullets: [...(pr.description ? [pr.description] : []), ...pr.bullets], tags: [] })),
    });
  }
  if (p.skills.length) {
    sections.push({ id: 'skills', kind: 'skills', title: 'Skills', text: null, items: [{ id: 'skills', heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [], tags: p.skills.map((s) => s.name) }] });
  }
  if (p.certifications.length) {
    sections.push({
      id: 'certifications', kind: 'certifications', title: 'Certifications', text: null,
      items: p.certifications.map((c, i) => ({ id: `cert${i + 1}`, heading: c.name, subheading: c.issuer, location: null, startDate: c.date, endDate: null, current: false, bullets: [], tags: [] })),
    });
  }
  return { header: headerFrom(p), sections };
}

/** The file's real type from its first bytes (a name or a header can lie). */
export function sniff(bytes: Uint8Array): 'pdf' | 'docx' | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'docx';
  return null;
}

/** A display file name: the last path part only, no control characters, at most 200 characters. */
export function safeFileName(raw: string | null, fallback: string): string {
  let n = raw ?? '';
  try { n = decodeURIComponent(n); } catch { /* keep as sent */ }
  n = n.split(/[\\/]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n || n === '.' || n === '..') n = fallback;
  return [...n].slice(0, 200).join('');
}

function writeDurably(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { const d = openSync(join(path, '..'), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* best effort */ }
}

export class ResumeService {
  private readonly db: DatabaseSync;
  private readonly home: string;
  private readonly dir: string;
  private readonly profile: () => Profile;
  constructor(db: DatabaseSync, home: string, dir: string, profile: () => Profile) {
    this.db = db; this.home = home; this.dir = dir; this.profile = profile;
  }

  private toResume(r: Row): Resume {
    return {
      id: r.id,
      name: r.name,
      targetTitle: r.target_title,
      isPrimary: r.is_primary === 1,
      kind: r.kind === 'tailored' ? 'tailored' : 'base',
      baseResumeId: r.base_resume_id,
      jobId: r.job_id,
      version: r.version,
      file: r.file_name && r.file_mime && r.file_sha256 && r.file_bytes !== null
        ? { fileName: r.file_name, mimeType: r.file_mime, bytes: r.file_bytes, sha256: r.file_sha256 }
        : null,
      document: parseJson<ResumeDocument>(r.document, { header: { name: '', email: null, phone: null, city: null, links: [] }, sections: [] }),
      importReport: parseJson<ImportReport | null>(r.import_report, null),
      atsReport: parseJson(r.ats_report, null),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): Resume[] {
    return (this.db.prepare('SELECT * FROM srv_resumes ORDER BY created_at, id').all() as unknown as Row[]).map((r) => this.toResume(r));
  }

  get(id: string): Resume | null {
    const r = this.db.prepare('SELECT * FROM srv_resumes WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toResume(r) : null;
  }

  private hasBase(): boolean {
    return this.db.prepare("SELECT 1 FROM srv_resumes WHERE kind = 'base'").get() !== undefined;
  }

  import(bytes: Uint8Array, rawName: string | null, mimeType: string): { resume: Resume; proposedProfile: ProfileInput } {
    if (bytes.length === 0) throw new ApiFailure('bad_request', 'The file is empty. Nothing was saved.');
    const kind = sniff(bytes);
    const want = mimeType === PDF ? 'pdf' : 'docx';
    if (kind !== want) {
      throw new ApiFailure('bad_request', want === 'pdf' ? 'The file is not a PDF, although it was sent as one. Nothing was saved.' : 'The file is not a Word (.docx) file, although it was sent as one. Nothing was saved.');
    }
    const id = newId('res');
    const ext = kind === 'pdf' ? 'pdf' : 'docx';
    const fileName = safeFileName(rawName, `resume.${ext}`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const path = join(this.dir, `${id}.${ext}`);
    try { writeDurably(path, bytes); } catch (e) {
      try { rmSync(`${path}.tmp`, { force: true }); rmSync(path, { force: true }); } catch { /* ignore */ }
      const p = storageProblem(e);
      if (p) throw writeFailed(p);
      throw e;
    }
    const profile = this.profile();
    const report: ImportReport = {
      counts: { jobs: 0, bullets: 0, skills: 0, education: 0 },
      unreadSections: [],
      warnings: ['The file is saved exactly as uploaded. Reading its text into the profile arrives with the resume engine, so no profile fact was proposed.'],
      outcome: 'partial',
      failure: null,
    };
    const now = nowIso();
    try {
      tx(this.db, () => {
        const primary = !this.hasBase();
        this.db.prepare(`INSERT INTO srv_resumes (id, name, target_title, is_primary, kind, version, file_name, file_mime, file_bytes,
          file_sha256, file_path, document, import_report, created_at, updated_at) VALUES (?, ?, NULL, ?, 'base', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, fileName.replace(/\.(pdf|docx)$/i, '') || 'Resume', b(primary), fileName, mimeType, bytes.length, sha,
            relative(this.home, path).split(sep).join('/'), JSON.stringify({ header: headerFrom(profile), sections: [] }), JSON.stringify(report), now, now);
      });
    } catch (e) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
      throw e;
    }
    const { id: _id, version: _v, updatedAt: _u, ...proposed } = profile;
    return { resume: this.get(id)!, proposedProfile: proposed };
  }

  create(input: { name: string; targetTitle?: string }): Resume {
    const id = newId('res');
    const now = nowIso();
    const doc = documentFromProfile(this.profile());
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO srv_resumes (id, name, target_title, is_primary, kind, version, document, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'base', 1, ?, ?, ?)`).run(id, input.name, input.targetTitle ?? null, b(!this.hasBase()), JSON.stringify(doc), now, now);
    });
    return this.get(id)!;
  }

  update(id: string, patch: { name?: string; targetTitle?: string | null; isPrimary?: boolean; document?: ResumeDocument }): Resume {
    const now = nowIso();
    tx(this.db, () => {
      const r = this.db.prepare('SELECT * FROM srv_resumes WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new ApiFailure('not_found', 'That resume does not exist.');
      const set: string[] = ['updated_at = ?'];
      const args: Array<string | number | null> = [now];
      if (patch.name !== undefined) { set.push('name = ?'); args.push(patch.name); }
      if (patch.targetTitle !== undefined) { set.push('target_title = ?'); args.push(patch.targetTitle); }
      if (patch.document !== undefined) {
        // The header is always the profile's, character for character.
        const doc = prune(ResumeDocumentSchema, patch.document) as ResumeDocument;
        set.push('document = ?'); args.push(JSON.stringify({ ...doc, header: headerFrom(this.profile()) }));
      }
      if (patch.isPrimary === true) {
        this.db.prepare('UPDATE srv_resumes SET is_primary = 0 WHERE id <> ?').run(id);
        set.push('is_primary = 1');
      } else if (patch.isPrimary === false) {
        set.push('is_primary = 0');
      }
      this.db.prepare(`UPDATE srv_resumes SET ${set.join(', ')} WHERE id = ?`).run(...args, id);
    });
    return this.get(id)!;
  }

  delete(id: string, withVersions: boolean): string[] {
    const files: string[] = [];
    const deleted = tx(this.db, () => {
      const r = this.db.prepare('SELECT * FROM srv_resumes WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new ApiFailure('not_found', 'That resume does not exist.');
      const versions = this.db.prepare('SELECT id, file_path FROM srv_resumes WHERE base_resume_id = ?').all(id) as Array<{ id: string; file_path: string | null }>;
      if (versions.length && !withVersions) {
        throw new ApiFailure('conflict', `This resume has ${versions.length} tailored version${versions.length === 1 ? '' : 's'}. Delete them too (withVersions=true), or keep the resume.`);
      }
      const ids = [id, ...versions.map((v) => v.id)];
      for (const v of [r, ...versions]) if (v.file_path) files.push(v.file_path);
      for (const x of ids) this.db.prepare('DELETE FROM srv_resumes WHERE id = ?').run(x);
      return ids;
    });
    for (const f of files) { try { rmSync(this.absolute(f), { force: true }); } catch { /* removed at next start */ } }
    return deleted;
  }

  private absolute(rel: string): string {
    const p = join(this.home, ...rel.split('/'));
    if (!p.startsWith(this.dir + sep)) throw new Error('resume file path outside files/resumes');
    return p;
  }

  /** The uploaded file of a resume (extension fill, export), or null. */
  file(id: string): { fileName: string; mimeType: string; bytes: Buffer } | null {
    const r = this.db.prepare('SELECT file_name, file_mime, file_path FROM srv_resumes WHERE id = ?').get(id) as Pick<Row, 'file_name' | 'file_mime' | 'file_path'> | undefined;
    if (!r?.file_path || !r.file_name || !r.file_mime) return null;
    try { return { fileName: r.file_name, mimeType: r.file_mime, bytes: readFileSync(this.absolute(r.file_path)) }; } catch { return null; }
  }

  /** The resume to attach: the one asked for, else the tailored one for the job, else the primary. */
  pick(resumeId: string | null, jobId: string | null): string | null {
    if (resumeId) return this.get(resumeId) ? resumeId : null;
    if (jobId) {
      const t = this.db.prepare("SELECT id FROM srv_resumes WHERE kind = 'tailored' AND job_id = ? ORDER BY updated_at DESC LIMIT 1").get(jobId) as { id: string } | undefined;
      if (t) return t.id;
    }
    const p = this.db.prepare('SELECT id FROM srv_resumes WHERE is_primary = 1 LIMIT 1').get() as { id: string } | undefined;
    return p?.id ?? null;
  }

  /** Every file path (relative to the data folder) that a record points at. */
  referencedFiles(): string[] {
    return (this.db.prepare('SELECT file_path FROM srv_resumes WHERE file_path IS NOT NULL').all() as Array<{ file_path: string }>).map((r) => r.file_path);
  }

  /** Removes files that no record points at (a crash between file and record). Returns how many. */
  removeOrphans(): number {
    if (!existsSync(this.dir)) return 0;
    const keep = new Set(this.referencedFiles().map((f) => this.absolute(f)));
    let n = 0;
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name);
      try {
        if (!statSync(p).isFile() || keep.has(p)) continue;
        // Only this service's own names (res_<hex>.<ext> and their .tmp): other lanes' files are theirs.
        if (!/^res_[0-9a-f]{16}\.(pdf|docx)(\.tmp)?$/.test(name)) continue;
        rmSync(p, { force: true });
        n++;
      } catch { /* ignore */ }
    }
    return n;
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM srv_resumes').get() as { n: number }).n);
  }
}
