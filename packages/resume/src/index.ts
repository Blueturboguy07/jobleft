// @jobleft/resume: resumes from import to export, with a truth gate.
//   * import a PDF or Word file into a ResumeDocument and a proposed profile, reporting what it could not read
//   * base resumes built from the profile; tailored versions per job, linked to their base; the base never changes
//   * keyword gaps; a tailoring proposal the person reviews change by change; cover letters
//   * the truth gate: every fact must trace to the profile (T1). Violations are shown, never saved as ready
//   * export: a one-page PDF (left-out items listed, never cut) and a Word file; the ATS check grades the real PDF
// Status: interface stubs (foundation). Bodies throw until the resume lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/resume".

import type { DatabaseSync } from 'node:sqlite';
import type {
  AtsReport, CoverLetter, ImportReport, Job, KeywordGapReport, Profile, ProfileInput, Resume, ResumeDocument,
  TailorProposal, TruthViolation,
} from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import type { SkillDictionary } from '@jobleft/static-data';

export const PACKAGE_NAME = '@jobleft/resume';
/** Largest resume upload (resume O2). */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/resume)`);
}

export async function importResume(bytes: Uint8Array, fileName: string, mimeType: string): Promise<{
  document: ResumeDocument; report: ImportReport; proposedProfile: ProfileInput;
}> { return notImplemented('importResume'); }

/** A base resume document from the profile (header copied character for character). */
export function documentFromProfile(profile: Profile): ResumeDocument { return notImplemented('documentFromProfile'); }

/** Facts in a draft (resume document or letter text) that do not trace to the profile. Empty = passes. */
export function truthGate(draft: ResumeDocument | string, profile: Profile, job: Job | null): TruthViolation[] {
  return notImplemented('truthGate');
}

export function keywordGaps(job: Job, resume: ResumeDocument, profile: Profile, skills: SkillDictionary): KeywordGapReport {
  return notImplemented('keywordGaps');
}

export async function renderPdf(doc: ResumeDocument): Promise<{ bytes: Uint8Array; pages: number; leftOut: string[] }> {
  return notImplemented('renderPdf');
}
export async function renderDocx(doc: ResumeDocument): Promise<Uint8Array> { return notImplemented('renderDocx'); }
/** Grades the exact PDF bytes (same file, same report). */
export async function atsCheck(pdf: Uint8Array): Promise<AtsReport> { return notImplemented('atsCheck'); }

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

/** Owns the tables `resumes`, `resume_versions`, `tailor_proposals` and `cover_letters`. */
export class ResumeService {
  constructor(opts: ResumeServiceOptions) { void opts; }
  list(): Resume[] { return notImplemented('ResumeService.list'); }
  async import(bytes: Uint8Array, fileName: string, mimeType: string): Promise<{ resume: Resume; proposedProfile: ProfileInput }> { return notImplemented('ResumeService.import'); }
  create(input: { name: string; targetTitle?: string }): Resume { return notImplemented('ResumeService.create'); }
  get(id: string): Resume | null { return notImplemented('ResumeService.get'); }
  update(id: string, patch: { name?: string; targetTitle?: string | null; isPrimary?: boolean; document?: ResumeDocument }): Resume { return notImplemented('ResumeService.update'); }
  /** Refuses (conflict) to delete a base with versions unless withVersions is true. */
  delete(id: string, withVersions: boolean): string[] { return notImplemented('ResumeService.delete'); }
  async tailor(resumeId: string, jobId: string): Promise<TailorProposal> { return notImplemented('ResumeService.tailor'); }
  accept(resumeId: string, proposalId: string, acceptChangeIds: string[]): Resume { return notImplemented('ResumeService.accept'); }
  async fitCheck(resumeId: string): Promise<{ fitsOnePage: boolean; leftOut: string[] }> { return notImplemented('ResumeService.fitCheck'); }
  async export(resumeId: string, format: 'pdf' | 'docx'): Promise<{ fileName: string; mimeType: string; bytes: Uint8Array }> { return notImplemented('ResumeService.export'); }
  async atsCheck(resumeId: string): Promise<AtsReport> { return notImplemented('ResumeService.atsCheck'); }
  keywordGaps(jobId: string, resumeId: string): KeywordGapReport { return notImplemented('ResumeService.keywordGaps'); }
  coverLetters(jobId: string): CoverLetter[] { return notImplemented('ResumeService.coverLetters'); }
  async createCoverLetter(jobId: string, resumeId: string): Promise<CoverLetter> { return notImplemented('ResumeService.createCoverLetter'); }
  async updateCoverLetter(id: string, patch: { text?: string; instruction?: string }): Promise<CoverLetter> { return notImplemented('ResumeService.updateCoverLetter'); }
}
