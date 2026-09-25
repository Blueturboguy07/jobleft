// Messages inside the extension (popup <-> service worker <-> content script). Nothing here crosses to the page:
// content scripts run in their own world, and the service worker accepts messages only from this extension.

import type { AtsId, DraftOffer, FormField, FillResponse, PageInfo } from '@jobleft/contracts';
import type { SupportInfo } from './support.ts';

export type ConnState =
  | { state: 'unpaired'; appRunning: boolean; appVersion: string | null }
  | { state: 'app_not_running' }
  | { state: 'paired'; appVersion: string; profileComplete: boolean; missingProfileFields: string[] }
  | { state: 'refused'; message: string };

/** What a probe of the page found: markers only, never page text. */
export interface ProbeResult {
  ats: AtsId | null;
  /** Frames from another site that look like an application form ("the form is inside a frame"). */
  blockedFrames: string[];
}

export interface PopupState {
  conn: ConnState;
  url: string | null;
  support: SupportInfo;
  page: PageInfo | null;
  pageError: string | null;
}

/** One field in the report, as the person sees it. */
export type ItemStatus = 'filled' | 'kept' | 'needs_you' | 'failed' | 'draft_ready' | 'inserted' | 'cleared' | 'edited' | 'ok';

export interface ReportItem {
  fieldId: string;
  label: string;
  required: boolean;
  section: string | null;
  status: ItemStatus;
  /** The value jobleft wrote (filled), or the value the field kept. */
  value: string | null;
  /** The profile item the value came from. */
  item: string | null;
  /** Why the field needs the person, or why a write failed. */
  reason: string | null;
}

export interface DraftItem {
  fieldId: string;
  label: string;
  maxLength: number | null;
  text: string | null;
  provider: string | null;
  state: 'offered' | 'ready' | 'inserted' | 'discarded' | 'failed';
  message: string | null;
}

export interface Report {
  fillId: string;
  phase: 'reading' | 'asking' | 'filling' | 'checking' | 'done' | 'stopped' | 'error' | 'undone';
  progress: { done: number; total: number } | null;
  support: SupportInfo;
  job: { title: string | null; company: string | null; appliedAt: string | null } | null;
  items: ReportItem[];
  drafts: DraftItem[];
  draftOffer: DraftOffer | null;
  draftCostNote: string | null;
  resume: { fileName: string; status: 'attached' | 'failed' | 'none' | 'kept'; message: string | null } | null;
  notices: string[];
  otherForms: Array<{ name: string; fields: number }>;
  hiddenIgnored: number;
  error: string | null;
  applied: { at: string } | null;
  appliedMessage: string | null;
}

/** What a frame found when asked to read its form. */
export interface CollectResult {
  frameUrl: string;
  /** How sure the frame is that it holds the application form (0 = no application form). */
  score: number;
  fields: FormField[];
  captcha: 'visible' | 'invisible' | null;
  account: boolean;
  ambiguous: boolean;
  otherForms: Array<{ name: string; fields: number }>;
  hiddenIgnored: number;
  blockedFrames: string[];
  ats: AtsId | null;
  step: number | null;
}

export interface ApplyInput {
  fillId: string;
  response: FillResponse;
  support: SupportInfo;
  job: Report['job'];
  notices: string[];
  otherForms: Report['otherForms'];
  hiddenIgnored: number;
  resumeName: string | null;
}

export type ToWorker =
  | { type: 'popup:state'; tabId: number }
  | { type: 'popup:pair'; code: string }
  | { type: 'popup:unpair' }
  | { type: 'popup:fill'; tabId: number; resumeId: string | null }
  | { type: 'popup:addJob'; tabId: number }
  | { type: 'panel:addJob' }
  | { type: 'panel:fillAgain' }
  | { type: 'panel:undo' }
  | { type: 'panel:stop' }
  | { type: 'panel:makeDrafts'; fieldIds: string[]; maxCostMicros: number }
  | { type: 'panel:markApplied' }
  | { type: 'panel:insertDraft'; fieldId: string; text: string }
  | { type: 'panel:discardDraft'; fieldId: string }
  | { type: 'panel:close' }
  | { type: 'panel:locate'; fieldId: string }
  | { type: 'panel:report'; report: Report };

export type ToContent =
  | { type: 'probe' }
  | { type: 'collect'; fillId: string }
  | { type: 'apply'; input: ApplyInput }
  | { type: 'stop' }
  | { type: 'undo' }
  | { type: 'insertDraft'; fieldId: string; text: string }
  | { type: 'discardDraft'; fieldId: string }
  | { type: 'drafts'; drafts: Array<{ fieldId: string; text: string; provider: string }>; skipped: Array<{ fieldId: string; message: string }>; costNote: string | null }
  | { type: 'close' }
  | { type: 'locate'; fieldId: string }
  | { type: 'panel:show'; report: Report }
  | { type: 'panel:message'; kind: 'applied' | 'error' | 'info'; text: string; appliedAt?: string; job?: Report['job'] };
