// Resume: base resumes (each with a target title) and tailored versions linked to a job and a base.
// Truth rule (T1): a tailored resume or a cover letter holds only facts that trace to the Profile.

import { IdSchema, IsoDateTimeSchema, YearMonthSchema } from './common.ts';
import { LinkSchema as LinkSchemaRef } from './profile.ts';
import { arr, bool, enm, int, named, nullable, obj, str, type Infer } from './schema.ts';

export const ResumeItemSchema = named(obj({
  id: IdSchema,
  /** Employer, school or project name. */
  heading: nullable(str()),
  /** Title, degree or role. */
  subheading: nullable(str()),
  location: nullable(str()),
  startDate: nullable(YearMonthSchema),
  endDate: nullable(YearMonthSchema),
  current: bool(),
  bullets: arr(str()),
  tags: arr(str()),
}), 'ResumeItem');

export const ResumeSectionSchema = named(obj({
  id: IdSchema,
  kind: enm(['summary', 'experience', 'education', 'skills', 'projects', 'certifications', 'custom']),
  title: str(),
  /** Summary text, for kind "summary" and free-text custom sections. */
  text: nullable(str()),
  items: arr(ResumeItemSchema),
}), 'ResumeSection');

export const ResumeDocumentSchema = named(obj({
  /** Always copied from the Profile, character for character (resume O5). */
  header: obj({
    name: str(),
    email: nullable(str()),
    phone: nullable(str()),
    city: nullable(str()),
    links: arr(LinkSchemaRef),
  }),
  sections: arr(ResumeSectionSchema),
}), 'ResumeDocument');

/** What an import could and could not read (resume O2). */
export const ImportReportSchema = named(obj({
  counts: obj({ jobs: int({ minimum: 0 }), bullets: int({ minimum: 0 }), skills: int({ minimum: 0 }), education: int({ minimum: 0 }) }),
  /** Section titles the importer found but could not map. They are shown, never dropped silently. */
  unreadSections: arr(str()),
  warnings: arr(str()),
  /** ok, partial (some parts unread), or failed with a reason. */
  outcome: enm(['ok', 'partial', 'failed']),
  failure: nullable(enm(['empty_file', 'too_large', 'image_only', 'password_protected', 'unsupported_type', 'corrupt'])),
}), 'ImportReport');

/** The ATS readability check of an exported file (resume O11). Same file, same result. */
export const AtsReportSchema = named(obj({
  grade: enm(['A', 'B', 'C', 'D', 'F']),
  score: int({ minimum: 0, maximum: 100 }),
  findings: arr(obj({
    id: str(),
    rule: str(),
    severity: enm(['urgent', 'critical', 'optional']),
    message: str(),
    evidence: str(),
  })),
  /** sha256 of the exact file that was checked. */
  fileSha256: str({ pattern: '^[0-9a-f]{64}$' }),
  checkedAt: IsoDateTimeSchema,
}), 'AtsReport');

export const ResumeSchema = named(obj({
  id: IdSchema,
  name: str({ minLength: 1, maxLength: 200 }),
  targetTitle: nullable(str()),
  isPrimary: bool(),
  kind: enm(['base', 'tailored']),
  /** For a tailored version: the base it came from and the job it is for. */
  baseResumeId: nullable(IdSchema),
  jobId: nullable(IdSchema),
  version: int({ minimum: 1 }),
  /** The uploaded source file, for an imported base resume. */
  file: nullable(obj({ fileName: str(), mimeType: str(), bytes: int({ minimum: 0 }), sha256: str({ pattern: '^[0-9a-f]{64}$' }) })),
  document: ResumeDocumentSchema,
  importReport: nullable(ImportReportSchema),
  atsReport: nullable(AtsReportSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}), 'Resume', 'A base resume or a tailored version');

/** A fact in a draft that does not trace to the Profile. A draft with violations is never "ready". */
export const TruthViolationSchema = named(obj({
  fact: str(),
  kind: enm(['skill', 'employer', 'title', 'school', 'degree', 'date', 'duration', 'number', 'certification', 'location', 'contact', 'other']),
  where: str({ description: 'Section, item or sentence that holds it' }),
  reason: str(),
}), 'TruthViolation');

export const KeywordGapReportSchema = named(obj({
  jobId: IdSchema,
  resumeId: IdSchema,
  /** false = the requirements could not be read (shown as such, never as "no gaps"). */
  requirementsFound: bool(),
  terms: arr(obj({
    term: str(),
    status: enm(['covered', 'in_profile_not_resume', 'not_in_profile']),
    /** The resume or profile wording that covers it ("k8s" for Kubernetes). */
    matchedAs: nullable(str()),
  })),
}), 'KeywordGapReport');

/** A tailoring draft. Nothing is saved until the user accepts changes (resume O7). */
export const TailorProposalSchema = named(obj({
  id: IdSchema,
  resumeId: IdSchema,
  jobId: IdSchema,
  changes: arr(obj({
    id: IdSchema,
    sectionId: IdSchema,
    itemId: nullable(IdSchema),
    field: str(),
    before: str(),
    after: str(),
    /** Shown next to a change that rewrites a claim. */
    warning: nullable(str()),
  })),
  /** Facts the job asks for that the profile does not have. Shown as gaps, never added. */
  gaps: arr(str()),
  /** Rejected AI output: facts that do not trace to the profile. They are not in `changes`. */
  violations: arr(TruthViolationSchema),
  provider: str(),
  createdAt: IsoDateTimeSchema,
}), 'TailorProposal');

export const CoverLetterSchema = named(obj({
  id: IdSchema,
  jobId: IdSchema,
  resumeId: IdSchema,
  text: str(),
  violations: arr(TruthViolationSchema),
  /** false while violations exist or the answer was partial. */
  ready: bool(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}), 'CoverLetter');

export type ResumeItem = Infer<typeof ResumeItemSchema>;
export type ResumeSection = Infer<typeof ResumeSectionSchema>;
export type ResumeDocument = Infer<typeof ResumeDocumentSchema>;
export type ImportReport = Infer<typeof ImportReportSchema>;
export type AtsReport = Infer<typeof AtsReportSchema>;
export type Resume = Infer<typeof ResumeSchema>;
export type TruthViolation = Infer<typeof TruthViolationSchema>;
export type KeywordGapReport = Infer<typeof KeywordGapReportSchema>;
export type TailorProposal = Infer<typeof TailorProposalSchema>;
export type CoverLetter = Infer<typeof CoverLetterSchema>;
