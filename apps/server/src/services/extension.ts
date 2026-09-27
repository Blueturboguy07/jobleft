// The paired extension's calls: status, page, fill, drafts, add-job and review (docs/INTERFACES.md section 7).
//
// The answer engine is the extension package's own (`answerFill`, `openQuestions`, `templateDraft`): the app and the
// extension agree on topics and on strict option matching, and the answers come from the saved profile as it is NOW
// (nothing is cached between fills). This file adds what only the app knows: which job a page is, which resume goes
// with it, what the tracker says, and the one place that turns a confirm into an "Applied" entry.
//
// Rules kept here (outcomes i-ext O5, O7, O9, O10, O13):
//   * a page that matches no job is "unknown", never a guess at another job;
//   * a draft uses only profile facts (the template never names the employer of the page or any contact detail) and is
//     never written into a form by the app; drafts made here are free and local, so no balance is touched;
//   * the tracker says Applied only after review() with submittedByUser = true, once per job, with the resume version.

import type { DatabaseSync } from 'node:sqlite';
import {
  EXTENSION_PROTOCOL_VERSION, nowIso, type DraftRequest, type DraftResponse, type ExtensionStatus, type FillRequest, type FillResponse,
  type FormField, type PageInfo, type PageInfoRequest, type Profile, type Resume, type ReviewResponse, type ReviewResult,
} from '@jobleft/contracts';
import { answerFill, classify, contactLeaks, isNeverHost, openQuestions, templateDraft, type ResumeFile } from '@jobleft/extension';
import type { AppData } from '../app.ts';
import { newId, tx } from '../db/util.ts';
import { ApiFailure } from '../errors.ts';
import { addExternal } from '../interim/external.ts';
import { missingProfileFields } from '../interim/profile.ts';
import { APP_VERSION } from '../version.ts';
import { PageMatcher } from './pagematch.ts';

/** The draft writer in this build: a facts-only template on this computer. Free, so no balance is ever touched. */
const LOCAL_DRAFTS = { provider: 'Local template (no AI, on this computer)', local: true, maxPriceMicrosPerDraft: 0, balanceMicros: null } as const;

const matchers = new WeakMap<DatabaseSync, PageMatcher>();
function matcherFor(db: DatabaseSync): PageMatcher {
  let m = matchers.get(db);
  if (!m) { m = new PageMatcher(db); matchers.set(db, m); }
  return m;
}

export interface ExtensionDeps {
  hostMap: Record<string, string>;
  offline: () => boolean;
}

export class ExtensionService {
  private readonly d: AppData;
  private readonly deps: ExtensionDeps;
  constructor(d: AppData, deps: ExtensionDeps = { hostMap: {}, offline: () => false }) { this.d = d; this.deps = deps; }

  private jobIdOf(pageUrl: string): string | null {
    const id = matcherFor(this.d.db).find(pageUrl);
    return id && this.d.jobs.exists(id) ? id : null;
  }

  /**
   * Resumes the extension can attach: every one. An uploaded resume goes as its own file; a resume made or tailored
   * in the app (no uploaded file) goes as the PDF the app exports, made when a fill needs it.
   */
  private attachable(): Resume[] {
    return this.d.resumes.list();
  }

  /** The name the page shows for a resume: its uploaded file, or the PDF the app will make of it. */
  private attachName(r: Resume): string {
    if (r.file) return r.file.fileName;
    try { return this.d.resumes.svc.renderedFileName(r.id, 'pdf'); } catch { return `${r.name}.pdf`; }
  }

  /**
   * The file to attach for a resume: the uploaded file byte for byte, else the resume exported now as a PDF (or as
   * a Word file when the PDF cannot be made, for example letters the PDF font lacks). `why` says what failed.
   */
  private async attachFile(r: Resume): Promise<{ file: ResumeFile | null; why: string | null }> {
    const f = r.file ? this.d.resumes.file(r.id) : null;
    if (f) return { file: { id: r.id, fileName: f.fileName, mimeType: f.mimeType, base64: f.bytes.toString('base64') }, why: null };
    let why: string | null = null;
    for (const format of ['pdf', 'docx'] as const) {
      try {
        const x = await this.d.resumes.svc.export(r.id, format);
        return { file: { id: r.id, fileName: x.fileName, mimeType: x.mimeType, base64: Buffer.from(x.bytes).toString('base64') }, why: null };
      } catch (e) {
        why ??= e instanceof Error ? e.message : null;
      }
    }
    return { file: null, why };
  }

  /** The resume a fill attaches unless the person picks another: the version for this job, else the default. */
  private suggested(jobId: string | null, list: Resume[]): Resume | null {
    if (jobId) {
      const t = list.filter((r) => r.kind === 'tailored' && r.jobId === jobId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (t) return t;
    }
    return list.find((r) => r.isPrimary) ?? list.find((r) => r.kind === 'base') ?? list[0] ?? null;
  }

  status(): ExtensionStatus {
    const p = this.d.profile.get();
    const missing = missingProfileFields(p);
    return { paired: true, appVersion: APP_VERSION, protocolVersion: EXTENSION_PROTOCOL_VERSION, profileComplete: missing.length === 0, missingProfileFields: missing };
  }

  page(req: PageInfoRequest): PageInfo {
    const jobId = this.jobIdOf(req.pageUrl);
    const job = jobId ? this.d.jobs.get(jobId) : null;
    const tracked = jobId ? this.d.tracker.get(jobId) : null;
    const list = this.attachable();
    const sug = this.suggested(jobId, list);
    return {
      jobId: job ? jobId : null,
      title: job?.title ?? null,
      company: job?.company ?? null,
      applied: tracked && tracked.status !== null && tracked.appliedAt ? { at: tracked.appliedAt, resumeId: tracked.resumeId } : null,
      resumes: list.map((r) => ({
        id: r.id, name: r.name, fileName: this.attachName(r),
        tailoredForThisJob: !!jobId && r.kind === 'tailored' && r.jobId === jobId, isDefault: r.isPrimary,
      })),
      suggestedResumeId: sug?.id ?? null,
    };
  }

  /** Adds the job on the person's tab, the same way add-by-link does (never a never-crawl site). */
  async addJob(req: PageInfoRequest): Promise<PageInfo> {
    if (isNeverHost(new URL(req.pageUrl).hostname)) {
      throw new ApiFailure('forbidden_source', 'jobleft never reads that site, so nothing was sent to it. Open the job in the app and paste its text instead.');
    }
    const known = this.jobIdOf(req.pageUrl);
    if (!known) {
      const id = await addExternal({ url: req.pageUrl }, { crawlStore: this.d.crawlStore, hostMap: this.deps.hostMap, offline: this.deps.offline });
      this.d.tracker.patch(id, {}, { external: true });
    }
    return this.page(req);
  }

  async fill(req: FillRequest): Promise<FillResponse> {
    const profile = this.d.profile.get();
    const jobId = this.jobIdOf(req.pageUrl);
    const list = this.attachable();
    // The person's pick wins. The file is read (or the PDF made) only when the form has a file field.
    const picked = req.resumeId ? list.find((r) => r.id === req.resumeId) ?? null : this.suggested(jobId, list);
    const made = picked && req.fields.some((f) => f.kind === 'file') ? await this.attachFile(picked) : null;
    const resume = made?.file ?? null;
    const out = await answerFill(req, {
      profile, jobId, draftOffer: LOCAL_DRAFTS, resume,
      draft: async (fields) => this.makeDrafts(fields, profile),
    });
    if (req.resumeId && !picked) out.warnings.push('The resume you picked is no longer in jobleft, so the resume box stays empty.');
    if (picked && made && !resume) out.warnings.push(`jobleft could not make a file of the resume "${picked.name}", so the resume box stays empty.${made.why ? ` ${made.why}` : ''}`);
    this.applySavedAnswers(req, out);
    return out;
  }

  /**
   * Answers the person chose to remember (review.savedAnswers) go into a field whose question is the same words and
   * that the engine could not classify. A sensitive or never-answered topic never gets one this way.
   */
  private applySavedAnswers(req: FillRequest, out: FillResponse): void {
    const rows = this.d.db.prepare('SELECT label_key, value FROM srv_saved_answers').all() as Array<{ label_key: string; value: string }>;
    if (rows.length === 0) return;
    const saved = new Map(rows.map((r) => [r.label_key, r.value]));
    for (const n of [...(out.notes ?? [])]) {
      if (n.topic !== 'unknown') continue;
      const f = req.fields.find((x) => x.fieldId === n.fieldId);
      const v = f ? saved.get(labelKey(f.label)) : undefined;
      if (!f || v === undefined) continue;
      let value: string | null = v;
      if (f.kind === 'select' || f.kind === 'radio') {
        const want = norm(v);
        value = f.options.find((o) => norm(o.label) === want || norm(o.value) === want)?.value ?? null;
      } else if (f.kind === 'checkbox' || f.kind === 'file' || (f.maxLength !== null && [...v].length > f.maxLength)) value = null;
      if (value === null) continue;
      out.fills.push({ fieldId: f.fieldId, values: [value], source: 'saved_answer', confidence: 'exact', needsReview: false, item: 'Saved answer' });
      out.unknownFieldIds = out.unknownFieldIds.filter((id) => id !== f.fieldId);
      out.notes = (out.notes ?? []).filter((x) => x.fieldId !== f.fieldId);
    }
  }

  /** One facts-only draft per open question. A question the profile cannot answer truthfully gets none. */
  private makeDrafts(fields: FormField[], profile: Profile): Array<{ fieldId: string; text: string; provider: string }> {
    const out: Array<{ fieldId: string; text: string; provider: string }> = [];
    for (const f of fields) {
      // The job of the page is left out on purpose: a draft holds facts from the profile only.
      let text = templateDraft(f, profile, null);
      if (f.maxLength && [...text].length > f.maxLength) text = [...text].slice(0, f.maxLength).join('');
      if (!text || contactLeaks(text, profile).length > 0) continue;
      out.push({ fieldId: f.fieldId, text, provider: LOCAL_DRAFTS.provider });
    }
    return out;
  }

  drafts(req: DraftRequest): DraftResponse {
    const profile = this.d.profile.get();
    const open = openQuestions(req.fields);
    const skipped = req.fields.filter((f) => !open.includes(f)).map((f) => ({ fieldId: f.fieldId, message: 'This is not an open question, so jobleft does not draft it.' }));
    const drafts = this.makeDrafts(open, profile);
    for (const f of open) {
      if (!drafts.some((x) => x.fieldId === f.fieldId)) skipped.push({ fieldId: f.fieldId, message: 'Your profile has too few facts for a true draft.' });
    }
    return { drafts, costMicros: 0, balanceMicros: null, skipped };
  }

  review(r: ReviewResult, extensionId: string | null): ReviewResponse {
    const known = r.jobId && this.d.jobs.exists(r.jobId) ? r.jobId : null;
    const jobId = known ?? this.jobIdOf(r.pageUrl);
    if (r.submittedByUser && !jobId) {
      // Nothing is recorded for a job the app does not have: the person adds it first, so the entry has a real job.
      throw new ApiFailure('not_found', 'jobleft does not know this job yet, so nothing was saved. Press "Add this job to jobleft" in the extension, then confirm again.');
    }
    // A resume id that is not a saved resume is dropped, so the tracker never points at nothing.
    const resumeId = r.resumeId && this.d.resumes.get(r.resumeId) ? r.resumeId : null;
    const now = nowIso();
    tx(this.d.db, () => {
      this.d.db.prepare(`INSERT OR IGNORE INTO srv_extension_reviews (request_id, extension_id, job_id, page_url, ats, submitted, filled, edited, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.requestId, extensionId, jobId, pageLog(r.pageUrl), r.ats, r.submittedByUser ? 1 : 0, r.filledFieldIds.length, r.editedFieldIds.length, r.at);
      for (const a of r.savedAnswers) {
        const key = labelKey(a.label);
        // Only a question the engine has no topic for can be remembered: never a sensitive one, never pay or age.
        if (!key || classify({ fieldId: 'x', label: a.label, name: null, kind: 'text', required: false, options: [], maxLength: null, section: null }).topic !== 'unknown') continue;
        this.d.db.prepare(`INSERT INTO srv_saved_answers (id, label, label_key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(label_key) DO UPDATE SET label = excluded.label, value = excluded.value, updated_at = excluded.updated_at`)
          .run(newId('ans'), a.label, key, a.value, now, now);
      }
    });
    if (!r.submittedByUser || !jobId) return { trackerEntry: jobId ? this.d.tracker.get(jobId) : null };
    const cur = this.d.tracker.get(jobId);
    // One confirm makes one entry. A second confirm changes nothing: not the date, not the resume.
    if (cur && cur.status !== null) return { trackerEntry: cur };
    return { trackerEntry: this.d.tracker.patch(jobId, { status: 'applied', resumeId }) };
  }
}

function labelKey(s: string): string {
  return s.toLowerCase().replace(/[*:?]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function norm(s: string): string { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

/** The address kept in the review log: origin and path only (no query, which can carry tokens). */
function pageLog(u: string): string {
  try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return 'unknown'; }
}
