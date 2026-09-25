// @jobleft/resume: resumes from import to export, with a truth gate.
//   * import a PDF, Word or text file into a ResumeDocument and a proposed profile, reporting what it could not read
//   * base resumes built from the profile; tailored versions per job, linked to their base; the base never changes
//   * keyword gaps; a tailoring proposal the person reviews change by change; cover letters
//   * the truth gate: every fact must trace to the profile (T1). Violations are shown, never saved as ready
//   * export: a one-page PDF (left-out items listed, never cut) and a Word file; the ATS check grades the real PDF
// Every model call goes through the ai-engine AiClient; with no provider, everything works without AI.
// Interface: docs/INTERFACES.md, section "@jobleft/resume". Commands: packages/resume/README.md.

import type {
  AtsReport, ImportReport, Job, KeywordGapReport, Profile, ProfileInput, ResumeDocument, TruthViolation,
} from '@jobleft/contracts';
import type { SkillDictionary } from '@jobleft/static-data';
import { createHash } from 'node:crypto';
import { nowIso } from '@jobleft/contracts';
import { documentFromProfile as buildDocument } from './document.ts';
import { keywordGaps as gapsOf } from './gaps.ts';
import { atsCheckInWorker, importResume as importFile, MAX_RESUME_BYTES as MAX_BYTES } from './import/index.ts';
import { renderResumeDocx, renderResumePdf } from './render/index.ts';
import { truthGate as gate } from './truth.ts';

export const PACKAGE_NAME = '@jobleft/resume';
/** Largest resume upload (resume O2). */
export const MAX_RESUME_BYTES: number = MAX_BYTES;

/**
 * Reads a PDF, Word (.docx) or plain-text resume in a worker thread (30 s limit). Never throws for a bad file:
 * `report.outcome` is "failed" with `report.failure` and a plain message in `report.warnings[0]`.
 */
export async function importResume(bytes: Uint8Array, fileName: string, mimeType: string): Promise<{
  document: ResumeDocument; report: ImportReport; proposedProfile: ProfileInput;
}> {
  const r = await importFile(bytes, fileName, mimeType);
  return { document: r.document, report: r.report, proposedProfile: r.proposedProfile };
}

/** A base resume document from the profile (header copied character for character). */
export function documentFromProfile(profile: Profile): ResumeDocument {
  return buildDocument(profile);
}

/** Facts in a draft (resume document or letter text) that do not trace to the profile. Empty = passes. */
export function truthGate(draft: ResumeDocument | string, profile: Profile, job: Job | null): TruthViolation[] {
  return gate(draft, profile, job);
}

export function keywordGaps(job: Job, resume: ResumeDocument, profile: Profile, skills: SkillDictionary): KeywordGapReport {
  return gapsOf(job, resume, profile, skills, 'unsaved');
}

/** Exactly one page. Throws ResumeError when the characters cannot be printed or nothing fits (never cuts text). */
export async function renderPdf(doc: ResumeDocument): Promise<{ bytes: Uint8Array; pages: number; leftOut: string[] }> {
  const r = renderResumePdf(doc);
  return { bytes: r.bytes, pages: r.pages, leftOut: r.leftOut };
}

/** The Word file with the same content as renderPdf (the same items left out, in the same order). */
export async function renderDocx(doc: ResumeDocument): Promise<Uint8Array> {
  return renderResumeDocx(doc).bytes;
}

/** Grades the exact PDF bytes (same file, same report). Runs in a worker with a time limit. */
export async function atsCheck(pdf: Uint8Array): Promise<AtsReport> {
  const r = await atsCheckInWorker(pdf);
  if (r) return r;
  // The worker could not finish (a damaged or hostile file): say so, with the file's hash.
  return {
    grade: 'F', score: 0, fileSha256: createHash('sha256').update(pdf).digest('hex'), checkedAt: nowIso(),
    findings: [{ id: 'file-unreadable', rule: 'not_a_pdf', severity: 'urgent', message: 'The file could not be read as a PDF.', evidence: 'Reading failed or went past the time limit.' }],
  };
}

export { ResumeService, profileIsEmpty, type ResumeServiceOptions, type ExportedFile } from './service.ts';
export { ResumeError, type ResumeErrorCode } from './errors.ts';
export { refusedFacts, workYears, headerFromProfile, checkDocument, checkLetter, buildProfileFacts } from './truth.ts';
export { builtinSkillDictionary, safeDictionary, jobTerms } from './gaps.ts';
export { draftTailoring, applyChanges, type TailorOp, type TailorDraft } from './tailor.ts';
export { draftLetter, editLetter, cleanJobField } from './letter.ts';
export { renderLetterPdf, renderLetterDocx } from './render/index.ts';
export { atsCheckPdf } from './ats.ts';
export { migrateResume, RESUME_SCHEMA_VERSION } from './db.ts';
export { documentText, dateRange } from './document.ts';
export { emptyProfileInput, asProfile } from './import/index.ts';
