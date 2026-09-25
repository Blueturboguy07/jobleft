// NetworkContact: one row of the user's own LinkedIn Connections.csv, plus the user's outreach tracking.
// Network data never leaves the laptop, except the few fields of ONE draft sent to the AI provider the user chose.

import { HttpUrlSchema, IdSchema, IsoDateSchema, IsoDateTimeSchema, MicrosSchema } from './common.ts';
import { arr, bool, enm, int, named, nullable, num, obj, str, type Infer } from './schema.ts';

export const OUTREACH_STAGES = ['to_contact', 'messaged', 'replied', 'met', 'follow_up_due'] as const;
export const OutreachStageSchema = enm(OUTREACH_STAGES);
export const OUTREACH_STAGE_LABELS = {
  to_contact: 'To contact', messaged: 'Messaged', replied: 'Replied', met: 'Met', follow_up_due: 'Follow-up due',
} as const;

export const NetworkContactSchema = named(obj({
  id: IdSchema,
  firstName: str(),
  lastName: str(),
  /** As in the file. Opened only when the user clicks it, one link per click. */
  profileUrl: nullable(HttpUrlSchema),
  /** As in the file. Many are blank. Never guessed. */
  email: nullable(str()),
  company: nullable(str()),
  /** companyKey of `company`; null when the company is blank. */
  companyKey: nullable(str()),
  position: nullable(str()),
  connectedOn: nullable(IsoDateSchema),
  /** The name may be garbled by the export (some non-Latin scripts). Shown as in the file, never "fixed". */
  maybeGarbled: bool(),
  stage: OutreachStageSchema,
  note: nullable(str({ maxLength: 20000 })),
  followUpOn: nullable(IsoDateSchema),
  inPlan: bool(),
  importedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}), 'NetworkContact', 'One of the user\'s own connections');

export const NetworkImportSummarySchema = named(obj({
  imported: int({ minimum: 0 }),
  updated: int({ minimum: 0 }),
  unchanged: int({ minimum: 0 }),
  /** Contacts from an earlier import that this file no longer has. They are kept, with their notes, and listed. */
  missingFromFile: int({ minimum: 0 }),
  skipped: arr(obj({ line: int({ minimum: 1 }), reason: str() })),
  /** true = the file is not a connections export; nothing was imported. */
  notAConnectionsFile: bool(),
  warnings: arr(str()),
}), 'NetworkImportSummary');

export const ContactRankSchema = named(obj({
  contactId: IdSchema,
  score: num(),
  /** Every reason is true for this contact's row. */
  reasons: arr(obj({ code: str(), text: str() })),
}), 'ContactRank');

export const CompanyCoverageSchema = named(obj({
  companyKey: str(),
  companyName: str(),
  /** 0 = a target company where the user knows nobody yet. */
  count: int({ minimum: 0 }),
  topContactIds: arr(IdSchema),
}), 'CompanyCoverage');

export const OutreachDraftSchema = named(obj({
  contactId: IdSchema,
  jobId: nullable(IdSchema),
  variant: enm(['short', 'long']),
  text: str(),
  /** The character limit the short variant must fit. */
  charLimit: nullable(int({ minimum: 1 })),
  /** Claims the inputs do not support, or other problems. A draft with warnings is not "ready". */
  warnings: arr(str()),
  ready: bool(),
  provider: str(),
  costMicros: nullable(MicrosSchema),
}), 'OutreachDraft');

export type OutreachStage = Infer<typeof OutreachStageSchema>;
export type NetworkContact = Infer<typeof NetworkContactSchema>;
export type NetworkImportSummary = Infer<typeof NetworkImportSummarySchema>;
export type ContactRank = Infer<typeof ContactRankSchema>;
export type CompanyCoverage = Infer<typeof CompanyCoverageSchema>;
export type OutreachDraft = Infer<typeof OutreachDraftSchema>;
