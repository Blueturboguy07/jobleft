// i-resume: the real @jobleft/resume ResumeService in the server (it replaces the interim resume stand-in). The
// bridge keeps the small methods the rest of the server already calls (`list`, `file`, `pick`, `removeOrphans`) and
// converts the lane's errors into the server's one error shape.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Job, Profile, Resume } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import { ResumeError, ResumeService, builtinSkillDictionary } from '@jobleft/resume';
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
  }

  list(): Resume[] { return this.svc.list(); }
  get(id: string): Resume | null { return this.svc.get(id); }

  /** The file the person uploaded for a base resume (byte for byte), or null (a resume made from the profile has none). */
  file(id: string): { fileName: string; mimeType: string; bytes: Buffer } | null {
    const r = this.svc.get(id);
    if (!r?.file) return null;
    const ext = r.file.mimeType === PDF ? 'pdf' : r.file.mimeType === DOCX ? 'docx' : 'txt';
    try { return { fileName: r.file.fileName, mimeType: r.file.mimeType, bytes: readFileSync(join(this.dir, `${id}.${ext}`)) }; } catch { return null; }
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
