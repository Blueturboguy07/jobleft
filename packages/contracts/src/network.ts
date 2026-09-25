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
}, {
  /** false = not in the most recent file the user imported (kept, with notes, from an earlier import). */
  inLatestFile: bool(),
  /** true = the follow-up date is today or past (in the user's time zone). */
  followUpDue: bool(),
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
}, {
  /** Contacts kept after this import (all imports together). */
  total: int({ minimum: 0 }),
  /** People read from this file (rows kept, duplicates and broken rows not counted). */
  inFile: int({ minimum: 0 }),
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

/** One company in the user's network: the key, the names as written in the file, and how many people. */
export const NetworkCompanyGroupSchema = named(obj({
  /** null for the "unknown company" group (blank company) and the "no specific company" group (Self-employed, Stealth...). */
  companyKey: nullable(str()),
  kind: enm(['company', 'unknown', 'placeholder']),
  /** The names as written in the file, most people first. */
  names: arr(obj({ name: str(), count: int({ minimum: 1 }) })),
  count: int({ minimum: 0 }),
}), 'NetworkCompanyGroup');

/** How "You know N people at <Company>" was counted: the names counted and why, and near names NOT counted and why. */
export const CompanyMatchExplanationSchema = named(obj({
  companyKey: str(),
  companyName: nullable(str()),
  count: int({ minimum: 0 }),
  matched: arr(obj({ name: str(), count: int({ minimum: 1 }), how: str() })),
  notCounted: arr(obj({ name: str(), count: int({ minimum: 1 }), why: str() })),
}), 'CompanyMatchExplanation');

/** One company of the coffee-chat plan: the people in the plan, in rank order, with a next step for each. */
export const CoffeeChatPlanEntrySchema = named(obj({
  companyKey: nullable(str()),
  companyName: str(),
  contacts: arr(obj({
    contactId: IdSchema,
    firstName: str(),
    lastName: str(),
    position: nullable(str()),
    stage: OutreachStageSchema,
    nextStep: str(),
    reasons: arr(obj({ code: str(), text: str() })),
  })),
}), 'CoffeeChatPlanEntry');

/** What a draft request would send, and where, before anything is sent (network O8). */
export const DraftPreviewSchema = named(obj({
  /** null = no AI provider is set up (the template still works). */
  destination: nullable(obj({
    provider: str(),
    /** A plain name of the receiver, e.g. "the model on this computer at 127.0.0.1:11434" or "publik". */
    label: str(),
    /** true = the text leaves this computer. */
    remote: bool(),
  })),
  /** true = the user must confirm once before the first draft to this destination. */
  needsConfirmation: bool(),
  /** The facts, exactly: one contact's name, title and company, one job, a short summary of the user. */
  sends: obj({
    contact: obj({ firstName: str(), lastName: str(), title: nullable(str()), company: nullable(str()) }),
    job: nullable(obj({ title: str(), company: str() })),
    aboutMe: str(),
  }),
  /** The exact messages the provider receives. */
  messages: arr(obj({ role: enm(['system', 'user', 'assistant']), content: str() })),
  charLimit: int({ minimum: 1 }),
}), 'DraftPreview');

export type OutreachStage = Infer<typeof OutreachStageSchema>;
export type NetworkContact = Infer<typeof NetworkContactSchema>;
export type NetworkImportSummary = Infer<typeof NetworkImportSummarySchema>;
export type ContactRank = Infer<typeof ContactRankSchema>;
export type CompanyCoverage = Infer<typeof CompanyCoverageSchema>;
export type OutreachDraft = Infer<typeof OutreachDraftSchema>;
export type NetworkCompanyGroup = Infer<typeof NetworkCompanyGroupSchema>;
export type CompanyMatchExplanation = Infer<typeof CompanyMatchExplanationSchema>;
export type CoffeeChatPlanEntry = Infer<typeof CoffeeChatPlanEntrySchema>;
export type DraftPreview = Infer<typeof DraftPreviewSchema>;
