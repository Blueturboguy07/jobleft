// i-resume: the real @jobleft/resume ResumeService in the server (it replaces the interim resume stand-in). The
// bridge keeps the small methods the rest of the server already calls (`list`, `file`, `pick`, `removeOrphans`) and
// converts the lane's errors into the server's one error shape.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Job, Profile, Resume, ResumeDocument } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import { ResumeError, ResumeService, builtinSkillDictionary, documentFromProfile } from '@jobleft/resume';
import { ApiFailure } from '../errors.ts';

export const PDF = 'application/pdf';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The lane's error as the server's error (same code, one plain sentence, the one top-up link, details for the screen). */
export function resumeFailure(e: unknown): unknown {
  if (!(e instanceof ResumeError)) return e;
  return new ApiFailure(e.code, e.message, {
    ...(e.details !== null && e.details !== undefined ? { details: e.details } : {}),
    ...(e.link ? { link: { label: 'Add to your balance', url: e.link } } : {}),
  });
}

/** Runs a resume step; a ResumeError becomes an ApiFailure. */
export async function step<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw resumeFailure(e); }
}

export class ResumeBridge {
  readonly svc: ResumeService;
  private readonly db: DatabaseSync;
  private readonly dir: string;

  constructor(opts: { db: DatabaseSync; filesDir: string; profile: () => Profile; job: (id: string) => Job | null; ai: () => AiClient }) {
    this.db = opts.db; this.dir = opts.filesDir;
    this.svc = new ResumeService({ db: opts.db, filesDir: opts.filesDir, profile: opts.profile, job: opts.job, ai: opts.ai, skills: builtinSkillDictionary() });
    this.adoptInterimResumes(opts.profile);
  }

  /**
   * An older data folder kept resumes in the server's stand-in table (srv_resumes) with the file under the same
   * files folder. Each one becomes a base resume of the engine once, with its file record kept byte for byte; the
   * document is read from the person's profile (the stand-in stored no readable document).
   */
  private adoptInterimResumes(profile: () => Profile): void {
    const has = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'srv_resumes'").get();
    if (!has) return;
    type Old = { id: string; name: string; is_primary: number; file_name: string | null; file_mime: string | null; file_bytes: number | null; file_sha256: string | null; created_at: string; updated_at: string };
    const rows = this.db.prepare('SELECT id, name, is_primary, file_name, file_mime, file_bytes, file_sha256, created_at, updated_at FROM srv_resumes WHERE id NOT IN (SELECT id FROM resumes)').all() as Old[];
    if (!rows.length) return;
    let doc: ResumeDocument | null = null;
    try { doc = documentFromProfile(profile()); } catch { doc = null; }
    const ins = this.db.prepare(`INSERT INTO resumes (id, name, target_title, is_primary, kind, version, file_json, document_json, import_report_json, proposed_profile_json, snapshot_json, snapshot_source, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'base', 1, ?, ?, NULL, NULL, NULL, 'profile', ?, ?)`);
    for (const r of rows) {
      const file = r.file_name && r.file_mime && r.file_sha256 ? { fileName: r.file_name, mimeType: r.file_mime, bytes: r.file_bytes ?? 0, sha256: r.file_sha256 } : null;
      const d = doc ?? { header: { name: '', email: null, phone: null, city: null, links: [] }, sections: [] };
      ins.run(r.id, r.name, r.is_primary, file ? JSON.stringify(file) : null, JSON.stringify(d), r.created_at, r.updated_at);
    }
  }

  list(): Resume[] { return this.svc.list(); }
  get(id: string): Resume | null { return this.svc.get(id); }

  /** The file the person uploaded for a base resume (byte for byte), or null (a resume made from the profile has none). */
  file(id: string): { fileName: string; mimeType: string; bytes: Buffer } | null {
    const r = this.svc.get(id);
    if (!r?.file) return null;
    const ext = r.file.mimeType === PDF ? 'pdf' : r.file.mimeType === DOCX ? 'docx' : 'txt';
    // An upload sent without a name is kept as "resume": the copy that leaves the app gets its type's extension, so it
    // opens with a double-click (JL-settings-17).
    const fileName = r.file.fileName.toLowerCase().endsWith(`.${ext}`) ? r.file.fileName : `${r.file.fileName}.${ext}`;
    try { return { fileName, mimeType: r.file.mimeType, bytes: readFileSync(join(this.dir, `${id}.${ext}`)) }; } catch { return null; }
  }

  /** The resume to attach: the one asked for, else the tailored one for the job, else the primary. */
  pick(resumeId: string | null, jobId: string | null): string | null {
    const all = this.svc.list();
    if (resumeId) return all.some((r) => r.id === resumeId) ? resumeId : null;
    if (jobId) {
      const t = all.filter((r) => r.kind === 'tailored' && r.jobId === jobId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
      if (t) return t.id;
    }
    return all.find((r) => r.kind === 'base' && r.isPrimary)?.id ?? null;
  }

  /** Removes uploaded files that no record points at (a crash between file and record). Returns how many. */
  removeOrphans(): number {
    if (!existsSync(this.dir)) return 0;
    const ids = new Set((this.db.prepare('SELECT id FROM resumes').all() as Array<{ id: string }>).map((r) => r.id));
    let n = 0;
    for (const name of readdirSync(this.dir)) {
      const m = /^(res_[0-9a-f-]{36})\.(pdf|docx|txt)$/.exec(name);
      if (!m || ids.has(m[1]!)) continue;
      try { if (statSync(join(this.dir, name)).isFile()) { rmSync(join(this.dir, name), { force: true }); n++; } } catch { /* ignore */ }
    }
    return n;
  }

  count(): number { return Number((this.db.prepare('SELECT count(*) AS n FROM resumes').get() as { n: number }).n); }
}
