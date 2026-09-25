// The protocol between the Chrome MV3 extension and the local app (assisted apply: it fills, the user reviews,
// the user submits). Transport: HTTP to the local API on 127.0.0.1, from the extension's service worker only.
//
// Flow:
//   1. The app shows a 6-digit code (POST /api/v1/extension/pairing-code, launch token, valid 5 minutes).
//   2. The user types the code in the extension. The extension finds the app (GET /api/v1/health on ports
//      DEFAULT_PORT..DEFAULT_PORT+9, looking for app "jobleft") and calls POST /api/v1/extension/pair.
//      The request's Origin must be chrome-extension://<extensionId>. Five wrong codes void the code.
//   3. The app answers with a pairing token. Every later call carries it in PAIRING_TOKEN_HEADER, from the same
//      extension Origin. The token is stored only in chrome.storage.local, never in a page or a URL.
//   4. On an application page, the extension sends the form's fields (FillRequest). The app answers with values
//      (FillResponse). The extension fills and highlights them. It NEVER submits a form and never solves a CAPTCHA.
//   5. After the user's own review, the extension sends ReviewResult. When the user submitted, the app marks the
//      job Applied in the tracker.
// The extension never receives network contacts, AI keys or the publik key. EEO answers go only into EEO fields.

import { HttpUrlSchema, IdSchema, IsoDateTimeSchema, MicrosSchema } from './common.ts';
import { AtsIdSchema } from './job.ts';
import { TrackerEntrySchema } from './tracker.ts';
import { arr, bool, enm, int, named, nullable, obj, str, type Infer } from './schema.ts';

export const EXTENSION_PROTOCOL_VERSION = 1;

export const PairingCodeSchema = named(obj({
  code: str({ pattern: '^[0-9]{6}$' }),
  expiresAt: IsoDateTimeSchema,
}), 'PairingCode');

export const PairRequestSchema = named(obj({
  code: str({ pattern: '^[0-9]{6}$' }),
  /** Chrome extension id: 32 characters a to p. Must equal the id in the request's Origin. */
  extensionId: str({ pattern: '^[a-p]{32}$' }),
  extensionVersion: str({ maxLength: 40 }),
  protocolVersion: int({ minimum: 1 }),
  browser: str({ maxLength: 80 }),
}), 'PairRequest');

export const PairResponseSchema = named(obj({
  /** 32 random bytes, base64url. The app keeps only its hash. */
  pairingToken: str({ pattern: '^[A-Za-z0-9_-]{43}$' }),
  appVersion: str(),
  protocolVersion: int({ minimum: 1 }),
}), 'PairResponse');

export const ExtensionStatusSchema = named(obj({
  paired: bool(),
  appVersion: str(),
  protocolVersion: int({ minimum: 1 }),
  /** false = the profile lacks facts that most forms need; the popup says which. */
  profileComplete: bool(),
  missingProfileFields: arr(str()),
}), 'ExtensionStatus');

export const FormFieldSchema = named(obj({
  /** Stable within the page (the extension's own id for the element). */
  fieldId: str({ minLength: 1, maxLength: 200 }),
  label: str({ maxLength: 1000 }),
  name: nullable(str({ maxLength: 200 })),
  kind: enm(['text', 'email', 'tel', 'url', 'textarea', 'select', 'radio', 'checkbox', 'file', 'date', 'number', 'unknown']),
  required: bool(),
  options: arr(obj({ value: str(), label: str() }), { maxItems: 500 }),
  maxLength: nullable(int({ minimum: 0 })),
  /** The form section heading, when there is one ("Voluntary Self-Identification"). */
  section: nullable(str({ maxLength: 200 })),
}, {
  // Optional hints (contracts 1.1, extension lane). Readers treat a missing hint as unknown.
  /** The control's HTML autocomplete token ("given-name", "email", "tel", "address-level2"). */
  autocomplete: str({ maxLength: 100 }),
  /** The input's placeholder text. */
  placeholder: str({ maxLength: 300 }),
  /** The input's HTML type ("text", "email", "month", "search"). */
  inputType: str({ maxLength: 40 }),
  /** 0-based position of this field's repeated block ("School" of the second education entry = 1). */
  entry: int({ minimum: 0, maximum: 50 }),
  /** Nearby words that change who the field is about ("Reference 1", "Emergency contact", "Education"). */
  context: str({ maxLength: 300 }),
  /** true for a custom dropdown whose options appear only when opened (options is then empty). */
  combobox: bool(),
  /** The accept attribute of a file input (".pdf,.docx"). */
  accept: str({ maxLength: 300 }),
}), 'FormField');

export const FillRequestSchema = named(obj({
  requestId: IdSchema,
  pageUrl: HttpUrlSchema,
  /** The ATS the extension recognised from the page. */
  ats: AtsIdSchema,
  /** Page number in a multi-page flow (Workday), 1-based; null for one-page forms. */
  step: nullable(int({ minimum: 1 })),
  fields: arr(FormFieldSchema, { maxItems: 500 }),
  /** The resume to attach; null = the primary resume, or the tailored one for this job when it exists. */
  resumeId: nullable(IdSchema),
}), 'FillRequest');

/** Why the app left a field empty. */
export const FIELD_NOTE_REASONS = [
  'no_value', 'sensitive', 'other_person', 'open_question', 'consent', 'account', 'captcha', 'no_option', 'file',
  'duplicate', 'unknown',
] as const;

export const FieldNoteSchema = named(obj({
  fieldId: str(),
  reason: enm(FIELD_NOTE_REASONS),
  /** One plain sentence for the person. */
  message: str({ maxLength: 300 }),
}, {
  /** The topic the app recognised, when it recognised one. */
  topic: str({ maxLength: 60 }),
}), 'FieldNote');

export const DraftOfferSchema = named(obj({
  /** The open questions the app can draft. */
  fieldIds: arr(str()),
  /** The provider in words ("Local model (llama3.1:8b)", "publik API"). */
  provider: str({ maxLength: 120 }),
  /** true when drafting sends nothing off this computer. */
  local: bool(),
  /** The most one draft can cost, in micros; 0 for a free provider. */
  maxPriceMicrosPerDraft: MicrosSchema,
  /** The publik balance now, when the provider is publik. */
  balanceMicros: nullable(MicrosSchema),
}), 'DraftOffer');

export const FillResponseSchema = named(obj({
  requestId: IdSchema,
  /** The local job this page belongs to, matched from its URL; null when unknown. */
  jobId: nullable(IdSchema),
  fills: arr(obj({
    fieldId: str(),
    /** One value; for a multi-select checkbox group, the chosen option values. */
    values: arr(str(), { minItems: 1 }),
    /** eeo and saved_answer are used only for answers the person saved; sensitive fields otherwise stay empty. */
    source: enm(['profile', 'resume', 'eeo', 'saved_answer']),
    confidence: enm(['exact', 'likely']),
    /** true when the value needs the person's eye (for example a close dropdown match). */
    needsReview: bool(),
  }, {
    /** The profile item the value came from, in words ("Phone", "Education 1: School"). Shown in the report. */
    item: str({ maxLength: 200 }),
    /**
     * The topic the app recognised ("country", "edu_degree", "eeo_veteran"). For a combobox (options unknown when the
     * extension asked) the value is the wanted option text, and the extension picks an option with the same strict
     * matcher for this topic, or leaves the field empty.
     */
    topic: str({ maxLength: 60 }),
  })),
  /**
   * Draft answers for open questions. They are NEVER written into the form by the fill: the extension shows each
   * draft, and inserts it only when the person accepts it. Drafts use only profile facts.
   */
  drafts: arr(obj({ fieldId: str(), text: str(), provider: str() })),
  /** Fields the app has no answer for. The extension leaves them empty and marks them. */
  unknownFieldIds: arr(str()),
  /** Files to attach (the resume PDF), base64. */
  files: arr(obj({ fieldId: str(), fileName: str(), mimeType: str(), base64: str() }, {
    /** The resume record the file came from. */
    resumeId: IdSchema,
  })),
  warnings: arr(str()),
}, {
  /** Why each field without a fill was left empty (the report shows it as "needs you"). */
  notes: arr(FieldNoteSchema),
  /**
   * Drafts the app can make for open questions when the provider costs money (or is not free to call): the extension
   * shows the price in dollars and asks first (POST /api/v1/extension/drafts). null = no draft provider set up.
   */
  draftOffer: nullable(DraftOfferSchema),
}), 'FillResponse');

export const ReviewResultSchema = named(obj({
  requestId: IdSchema,
  pageUrl: HttpUrlSchema,
  jobId: nullable(IdSchema),
  ats: AtsIdSchema,
  filledFieldIds: arr(str()),
  /** Fields the user changed after the fill. */
  editedFieldIds: arr(str()),
  /** true only when the PERSON confirmed in the extension that they submitted the application themselves. */
  submittedByUser: bool(),
  /** Answers the user chose to remember for later forms (label and value only). */
  savedAnswers: arr(obj({ label: str({ maxLength: 1000 }), value: str({ maxLength: 5000 }) }), { maxItems: 100 }),
  at: IsoDateTimeSchema,
}, {
  /** The resume the extension attached, so the tracker can name the version that went out. */
  resumeId: nullable(IdSchema),
}), 'ReviewResult');

/** What the extension asks about the page the person is on (only its address; never page text). */
export const PageInfoRequestSchema = named(obj({
  pageUrl: HttpUrlSchema,
}), 'PageInfoRequest');

/** The app's answer: which job this page is, whether the person applied, and the resumes they can attach. */
export const PageInfoSchema = named(obj({
  /** null when the page matches no job in the app. */
  jobId: nullable(IdSchema),
  title: nullable(str()),
  company: nullable(str()),
  /** The tracker says the person applied to this job (their own confirm), with the date. */
  applied: nullable(obj({ at: IsoDateTimeSchema, resumeId: nullable(IdSchema) })),
  resumes: arr(obj({
    id: IdSchema,
    name: str(),
    fileName: str(),
    /** A version tailored for this job. */
    tailoredForThisJob: bool(),
    /** The person's default (primary) resume. */
    isDefault: bool(),
  })),
  /** The resume a fill attaches unless the person picks another: the version for this job, else the default. */
  suggestedResumeId: nullable(IdSchema),
}), 'PageInfo');

/** Draft answers for open questions, after the person saw the price and asked (O8, O15). */
export const DraftRequestSchema = named(obj({
  requestId: IdSchema,
  pageUrl: HttpUrlSchema,
  jobId: nullable(IdSchema),
  /** Only the open questions to draft (label and limits; never page text). */
  fields: arr(FormFieldSchema, { minItems: 1, maxItems: 20 }),
  /** The most the person agreed to spend on this request, in micros (0 = free providers only). */
  maxCostMicros: MicrosSchema,
}), 'DraftRequest');

export const DraftResponseSchema = named(obj({
  drafts: arr(obj({ fieldId: str(), text: str(), provider: str() })),
  /** What this request spent, in micros (0 for a local or free provider). */
  costMicros: MicrosSchema,
  /** The publik balance after the request, when the provider is publik. */
  balanceMicros: nullable(MicrosSchema),
  /** Questions the app would not draft, with a reason each. */
  skipped: arr(obj({ fieldId: str(), message: str() })),
}), 'DraftResponse');

export const ReviewResponseSchema = named(obj({
  /** The tracker entry after the review (Applied when the user submitted). */
  trackerEntry: nullable(TrackerEntrySchema),
}), 'ReviewResponse');

/** One paired extension, as the app lists it (the person can unpair each one). */
export const PairingInfoSchema = named(obj({
  extensionId: str({ pattern: '^[a-p]{32}$' }),
  browser: str(),
  extensionVersion: str(),
  pairedAt: IsoDateTimeSchema,
  lastSeenAt: nullable(IsoDateTimeSchema),
}), 'PairingInfo');

export type PairingInfo = Infer<typeof PairingInfoSchema>;
export type PairingCode = Infer<typeof PairingCodeSchema>;
export type PairRequest = Infer<typeof PairRequestSchema>;
export type PairResponse = Infer<typeof PairResponseSchema>;
export type ExtensionStatus = Infer<typeof ExtensionStatusSchema>;
export type FormField = Infer<typeof FormFieldSchema>;
export type FillRequest = Infer<typeof FillRequestSchema>;
export type FillResponse = Infer<typeof FillResponseSchema>;
export type ReviewResult = Infer<typeof ReviewResultSchema>;
export type ReviewResponse = Infer<typeof ReviewResponseSchema>;
export type FieldNote = Infer<typeof FieldNoteSchema>;
export type FieldNoteReason = (typeof FIELD_NOTE_REASONS)[number];
export type DraftOffer = Infer<typeof DraftOfferSchema>;
export type PageInfoRequest = Infer<typeof PageInfoRequestSchema>;
export type PageInfo = Infer<typeof PageInfoSchema>;
export type DraftRequest = Infer<typeof DraftRequestSchema>;
export type DraftResponse = Infer<typeof DraftResponseSchema>;
