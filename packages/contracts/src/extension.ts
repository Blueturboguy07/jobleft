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

import { HttpUrlSchema, IdSchema, IsoDateTimeSchema } from './common.ts';
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

export const FillResponseSchema = named(obj({
  requestId: IdSchema,
  /** The local job this page belongs to, matched from its URL; null when unknown. */
  jobId: nullable(IdSchema),
  fills: arr(obj({
    fieldId: str(),
    /** One value; for a multi-select checkbox group, the chosen option values. */
    values: arr(str(), { minItems: 1 }),
    source: enm(['profile', 'resume', 'eeo', 'saved_answer', 'ai_draft']),
    confidence: enm(['exact', 'likely', 'guess']),
    /** true for guesses and AI drafts: the extension marks them for the user's review. */
    needsReview: bool(),
  })),
  /** Fields the app has no answer for. The extension leaves them empty and marks them. */
  unknownFieldIds: arr(str()),
  /** Files to attach (the resume PDF), base64. */
  files: arr(obj({ fieldId: str(), fileName: str(), mimeType: str(), base64: str() })),
  warnings: arr(str()),
}), 'FillResponse');

export const ReviewResultSchema = named(obj({
  requestId: IdSchema,
  pageUrl: HttpUrlSchema,
  jobId: nullable(IdSchema),
  ats: AtsIdSchema,
  filledFieldIds: arr(str()),
  /** Fields the user changed after the fill. */
  editedFieldIds: arr(str()),
  /** true only when the USER pressed the page's own submit button. */
  submittedByUser: bool(),
  /** Answers the user chose to remember for later forms (label and value only). */
  savedAnswers: arr(obj({ label: str({ maxLength: 1000 }), value: str({ maxLength: 5000 }) }), { maxItems: 100 }),
  at: IsoDateTimeSchema,
}), 'ReviewResult');

export const ReviewResponseSchema = named(obj({
  /** The tracker entry after the review (Applied when the user submitted). */
  trackerEntry: nullable(TrackerEntrySchema),
}), 'ReviewResponse');

export type PairingCode = Infer<typeof PairingCodeSchema>;
export type PairRequest = Infer<typeof PairRequestSchema>;
export type PairResponse = Infer<typeof PairResponseSchema>;
export type ExtensionStatus = Infer<typeof ExtensionStatusSchema>;
export type FormField = Infer<typeof FormFieldSchema>;
export type FillRequest = Infer<typeof FillRequestSchema>;
export type FillResponse = Infer<typeof FillResponseSchema>;
export type ReviewResult = Infer<typeof ReviewResultSchema>;
export type ReviewResponse = Infer<typeof ReviewResponseSchema>;
