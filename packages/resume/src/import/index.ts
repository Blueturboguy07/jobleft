// Resume import: PDF, Word (.docx) or plain text -> a proposed profile and a report of what could not be read.
// The file is read in a worker thread with a time and memory limit, so a damaged or hostile file can never hang the
// app (resume O2). Every failure has a plain message; nothing half-read is returned as complete.

import { Worker } from 'node:worker_threads';
import type { ImportReport, ProfileInput, ResumeDocument } from '@jobleft/contracts';
import { nowIso } from '@jobleft/contracts';
import { documentFromProfile } from '../document.ts';
import { PdfReadError, readPdf } from '../pdf-read.ts';
import { ZipError } from '../zip.ts';
import { docxLines, dropPageFurniture, pdfPageLines, textLines, type SrcLine } from './lines.ts';
import { parseLines } from './parse.ts';

/** Largest resume upload (resume O2). */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const IMPORT_TIMEOUT_MS = 30_000;

export interface ImportOutcome {
  document: ResumeDocument;
  report: ImportReport;
  proposedProfile: ProfileInput;
  /** One plain sentence for the person when the import failed; null otherwise. */
  message: string | null;
  kind: 'pdf' | 'docx' | 'text' | null;
}

type Failure = NonNullable<ImportReport['failure']>;

export function emptyProfileInput(): ProfileInput {
  return {
    personal: { firstName: null, middleName: null, lastName: null, email: null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
    summary: null, education: [], work: [], projects: [], certifications: [], skills: [],
    preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
    extraSections: [],
  };
}

export function asProfile(input: ProfileInput, version = 'import'): import('@jobleft/contracts').Profile {
  return { id: 'default', ...structuredClone(input), version, updatedAt: nowIso() };
}

function failed(failure: Failure, message: string, kind: ImportOutcome['kind'] = null): ImportOutcome {
  const proposedProfile = emptyProfileInput();
  return {
    document: { header: { name: '', email: null, phone: null, city: null, links: [] }, sections: [] },
    report: { counts: { jobs: 0, bullets: 0, skills: 0, education: 0 }, unreadSections: [], warnings: [message], outcome: 'failed', failure },
    proposedProfile, message, kind,
  };
}

function sniff(bytes: Uint8Array): 'pdf' | 'zip' | 'cfb' | 'rtf' | 'image' | 'text' | 'binary' {
  const head = Buffer.from(bytes.subarray(0, 1024));
  if (head.includes(Buffer.from('%PDF-'))) return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'cfb';
  if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if ((head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8) || head.subarray(0, 4).toString('latin1') === 'GIF8' || head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
  const sample = Buffer.from(bytes.subarray(0, 8192));
  const text = sample.toString('utf8');
  const bad = (text.match(/[\u0000-\u0008\u000E-\u001F�]/g) ?? []).length;
  return bad <= sample.length * 0.01 ? 'text' : 'binary';
}

function claimedKind(fileName: string, mimeType: string): 'pdf' | 'docx' | 'doc' | 'text' | null {
  const n = fileName.toLowerCase();
  const m = mimeType.toLowerCase();
  if (n.endsWith('.pdf') || m === 'application/pdf') return 'pdf';
  if (n.endsWith('.docx') || m.includes('wordprocessingml')) return 'docx';
  if (n.endsWith('.doc') || m === 'application/msword') return 'doc';
  if (n.endsWith('.txt') || n.endsWith('.md') || m.startsWith('text/')) return 'text';
  return null;
}

/** The import itself, in this thread. Use importResume() (worker, time limit) from app code. */
export async function importInProcess(bytes: Uint8Array, fileName: string, mimeType: string): Promise<ImportOutcome> {
  if (bytes.byteLength === 0) return failed('empty_file', 'The file is empty (0 bytes). Choose the resume file again.');
  if (bytes.byteLength > MAX_RESUME_BYTES) {
    return failed('too_large', `The file is ${(bytes.byteLength / 1048576).toFixed(1)} MB; the largest resume jobleft reads is ${MAX_RESUME_BYTES / 1048576} MB. Export a smaller PDF (for example without pictures) and try again.`);
  }
  const claim = claimedKind(fileName, mimeType);
  const real = sniff(bytes);
  let lines: SrcLine[] = [];
  let kind: ImportOutcome['kind'] = null;
  const pageWarnings: string[] = [];
  if (real === 'pdf') {
    kind = 'pdf';
    let read;
    try {
      read = await readPdf(bytes, { maxPages: 12 });
    } catch (e) {
      if (e instanceof PdfReadError && e.reason === 'password') return failed('password_protected', 'This PDF is protected with a password. Save a copy without the password and upload that copy.', kind);
      return failed('corrupt', 'The PDF is damaged and could not be read. Export it again from your editor and upload the new file.', kind);
    }
    const textPages = read.pages.filter((p) => p.items.some((i) => i.text.trim()));
    if (!textPages.length) {
      const imgs = read.pages.some((p) => p.images > 0);
      return failed(imgs ? 'image_only' : 'empty_file', imgs
        ? 'This PDF has no text in it: it looks like a scan or a picture of a resume, so jobleft cannot read it. Export your resume as a PDF with text, or upload the Word file.'
        : 'This PDF has no text in it. Export your resume again as a PDF with text, or upload the Word file.', kind);
    }
    for (const p of read.pages) {
      if (!p.items.some((i) => i.text.trim())) pageWarnings.push(`Page ${p.index + 1} has no text (it looks like a scan or a picture), so it was not read.`);
      lines.push(...pdfPageLines(p));
    }
    lines = dropPageFurniture(lines, read.pages.length);
    if (read.pages.length >= 12) pageWarnings.push('Only the first 12 pages were read.');
  } else if (real === 'zip') {
    kind = 'docx';
    try {
      lines = docxLines(bytes).lines;
    } catch (e) {
      if (e instanceof ZipError && e.reason === 'encrypted') return failed('password_protected', 'This Word file is protected with a password. Save a copy without the password and upload that copy.', kind);
      if (e instanceof ZipError && e.reason === 'too_large') return failed('too_large', `${e.message} Save the file again without large pictures and try again.`, kind);
      const msg = (e as { reason?: string }).reason === 'corrupt' && e instanceof Error ? e.message : 'The Word file is damaged and could not be read.';
      return failed('corrupt', `${msg} Save it again from your editor (File > Save As > Word Document) and upload the new file.`, kind);
    }
  } else if (real === 'cfb') {
    const s = Buffer.from(bytes).toString('utf16le');
    if (s.includes('EncryptionInfo') || s.includes('EncryptedPackage')) return failed('password_protected', 'This Word file is protected with a password. Save a copy without the password and upload that copy.', 'docx');
    return failed('unsupported_type', 'This is an old Word (.doc) file. Save it as a .docx or a PDF and upload that.', null);
  } else if (real === 'text') {
    if (claim === 'pdf' || claim === 'docx' || claim === 'doc') {
      return failed('unsupported_type', `The file is named like a ${claim === 'pdf' ? 'PDF' : 'Word file'} but it holds plain text. Upload the real ${claim === 'pdf' ? 'PDF' : 'Word file'}, or import the text as a .txt file.`, null);
    }
    kind = 'text';
    lines = textLines(Buffer.from(bytes).toString('utf8'));
  } else if (real === 'rtf') {
    return failed('unsupported_type', 'This is an RTF file. Save it as a .docx or a PDF and upload that.');
  } else if (real === 'image') {
    return failed('image_only', 'This is a picture, not a document. jobleft cannot read text in pictures: upload the resume as a PDF with text or a Word file.');
  } else {
    return failed('unsupported_type', 'jobleft cannot read this kind of file. Upload a PDF, a Word (.docx) file or a plain-text file.');
  }

  if (!lines.some((l) => l.text.trim())) return failed('empty_file', 'The file has no readable text in it.', kind);
  const parsed = parseLines(lines, { source: kind! });
  const warnings = [...pageWarnings, ...parsed.warnings];
  const partial = parsed.unreadSections.length > 0 || pageWarnings.length > 0 || parsed.counts.jobs === 0 || parsed.warnings.some((w) => /could not tell|not found|no dates|not read|were found before/.test(w));
  const report: ImportReport = {
    counts: parsed.counts, unreadSections: parsed.unreadSections, warnings,
    outcome: partial ? 'partial' : 'ok', failure: null,
  };
  const document = documentFromProfile(asProfile(parsed.profile));
  return { document, report, proposedProfile: parsed.profile, message: null, kind };
}

/** Imports a resume file in a worker thread with a time limit (no hang, resume O2). */
export async function importResume(bytes: Uint8Array, fileName: string, mimeType: string, opts: { timeoutMs?: number } = {}): Promise<ImportOutcome> {
  if (bytes.byteLength === 0) return importInProcess(bytes, fileName, mimeType);
  if (bytes.byteLength > MAX_RESUME_BYTES) return importInProcess(bytes, fileName, mimeType);
  const envTimeout = Number(process.env.JOBLEFT_IMPORT_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : IMPORT_TIMEOUT_MS);
  const copy = new Uint8Array(bytes); // the worker gets its own copy; nothing is written to disk
  return await new Promise<ImportOutcome>((resolve) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { op: 'import', bytes: copy, fileName, mimeType },
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
    let done = false;
    const finish = (r: ImportOutcome) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); resolve(r); };
    const timer = setTimeout(() => finish(failed('corrupt', `Reading the file took more than ${Math.round(timeoutMs / 1000)} seconds, so jobleft stopped. The file may be damaged: export it again and upload the new file.`)), timeoutMs);
    worker.on('message', (m: ImportOutcome) => finish(m));
    worker.on('error', () => finish(failed('corrupt', 'The file could not be read (it may be damaged or too complex). Export it again and upload the new file.')));
    worker.on('exit', () => finish(failed('corrupt', 'The file could not be read (reading stopped unexpectedly). Export it again and upload the new file.')));
    // The worker's own output never reaches a log: resume text must not be written anywhere (resume O13).
    worker.stdout?.resume();
    worker.stderr?.resume();
  });
}

/** Runs the readability check of untrusted PDF bytes in a worker with a time limit. */
export async function atsCheckInWorker(bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<import('@jobleft/contracts').AtsReport | null> {
  const envTimeout = Number(process.env.JOBLEFT_IMPORT_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : IMPORT_TIMEOUT_MS);
  return await new Promise((resolve) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { op: 'ats', bytes: new Uint8Array(bytes), fileName: 'check.pdf', mimeType: 'application/pdf' },
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 }, stdout: true, stderr: true,
    });
    let done = false;
    const finish = (r: import('@jobleft/contracts').AtsReport | null) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); resolve(r); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.on('message', (m: { ok: boolean; report?: import('@jobleft/contracts').AtsReport }) => finish(m.ok ? m.report ?? null : null));
    worker.on('error', () => finish(null));
    worker.on('exit', () => finish(null));
    worker.stdout?.resume();
    worker.stderr?.resume();
  });
}
