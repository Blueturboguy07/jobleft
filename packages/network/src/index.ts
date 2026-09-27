// @jobleft/network: the Network tool on the person's own Connections.csv (plan section 7).
// Import, match to companies, "who to message first" with true reasons, outreach tracking with reminders, drafts
// that use only the inputs, coverage of target companies, a coffee-chat plan, and delete-all. No request ever goes
// to the professional network or a people-lookup service; nothing is sent for the person.
// Interface: docs/INTERFACES.md, section "@jobleft/network". Commands: packages/network/README.md.

import type { DatabaseSync } from 'node:sqlite';
import type {
  CompanyCoverage, ContactRank, Job, NetworkContact, NetworkImportSummary, OutreachDraft, OutreachStage,
} from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import { parseConnectionsCsv as parseCsv } from './csv.ts';
import { rankContacts as rank } from './rank.ts';
import { draftOutreach as draft } from './draft.ts';
import { NetworkService as Service, type CompanyGroup, type MatchExplanation, type PlanEntry } from './service.ts';

export const PACKAGE_NAME = '@jobleft/network';

export interface ParsedConnection {
  /** The file line (1-based) where the row starts. */
  line: number;
  firstName: string;
  lastName: string;
  profileUrl: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  /** YYYY-MM-DD, or null when blank or not readable without guessing. */
  connectedOn: string | null;
  /** The name may be garbled by the export. It is kept exactly as in the file. */
  maybeGarbled: boolean;
}

/**
 * Parses the export: skips the note lines above the header, handles a BOM, CRLF and quoted commas, and reports every
 * skipped row with a reason. A file that is not a connections export gives notAConnectionsFile: true and no rows.
 */
export function parseConnectionsCsv(text: string): {
  rows: ParsedConnection[]; skipped: Array<{ line: number; reason: string }>; notAConnectionsFile: boolean; warnings: string[];
} {
  return parseCsv(text);
}

/** Ranks contacts at one company; each reason is true for the contact's row; same data, same order. */
export function rankContacts(contacts: NetworkContact[], ctx: { companyKey: string; job: Job | null; now: number }): ContactRank[] {
  return rank(contacts, ctx);
}

/** Drafts one message from ONLY this contact's name, title and company, this job, and a short profile summary. */
export async function draftOutreach(input: {
  contact: NetworkContact; job: Job | null; profileSummary: string; variant: 'short' | 'long'; ai: AiClient;
}): Promise<OutreachDraft> {
  return draft(input);
}

export interface NetworkServiceOptions {
  db: DatabaseSync;
  /** @jobleft/static-data companyKey (the same key jobs use). */
  companyKey: (name: string) => string;
  now?: () => number;
  /** The person's time zone for "today" (default: the system zone, or JOBLEFT_TZ). */
  timeZone?: string;
}

/** Owns the tables `network_contacts` and `network_meta`. Deletes are real (rows, notes, dates; nothing left behind). */
export class NetworkService extends Service {
  constructor(opts: NetworkServiceOptions) { super(opts); }
  /** Imports the file text. Keeps stages and notes of people already there; never drops a person silently. */
  override import(csvText: string): NetworkImportSummary & { total: number; inFile: number } { return super.import(csvText); }
  override list(q: { companyKey?: string; noCompany?: boolean; stage?: OutreachStage; q?: string; due?: boolean; inPlan?: boolean; limit?: number; offset?: number } = {}): Array<NetworkContact & { inLatestFile: boolean; followUpDue: boolean }> { return super.list(q); }
  /** How many connections work at a company (null when none, so cards show nothing). */
  override countFor(companyKey: string): number | null { return super.countFor(companyKey); }
  override coverage(targetCompanies: Array<{ companyKey: string; companyName: string; jobs?: Array<{ id: string; title: string }> }>): CompanyCoverage[] { return super.coverage(targetCompanies); }
  override rank(companyKey: string, job: Job | null): ContactRank[] { return super.rank(companyKey, job); }
  override update(id: string, patch: { stage?: OutreachStage; note?: string | null; followUpOn?: string | null; inPlan?: boolean }): NetworkContact & { inLatestFile: boolean; followUpDue: boolean } { return super.update(id, patch); }
  override delete(id: string): boolean { return super.delete(id); }
  override deleteAll(): number { return super.deleteAll(); }
  /** Contacts whose follow-up date is today or past (for reminders). */
  override due(today?: string): Array<NetworkContact & { inLatestFile: boolean; followUpDue: boolean }> { return super.due(today); }
  /** One contact, or null. */
  override get(id: string): (NetworkContact & { inLatestFile: boolean; followUpDue: boolean }) | null { return super.get(id); }
  /** countFor for a whole feed page from one cached map (no query per card). */
  override countsFor(keys: Iterable<string>): Map<string, number | null> { return super.countsFor(keys); }
  /** Companies in the network with the names as written; blank ("unknown") and placeholder companies grouped apart. */
  override companies(): CompanyGroup[] { return super.companies(); }
  /** How a count was made: names counted and why; near names NOT counted and why. */
  override explain(companyKey: string, companyName?: string | null): MatchExplanation { return super.explain(companyKey, companyName ?? null); }
  /** Puts the top `count` people at a company (ranked for the job, when given) into the coffee-chat plan. */
  override addTopToPlan(companyKey: string, count: number, job: Job | null): Array<NetworkContact & { inLatestFile: boolean; followUpDue: boolean }> { return super.addTopToPlan(companyKey, count, job); }
  /** The coffee-chat plan by company, in rank order, with a next step for each person. */
  override plan(): PlanEntry[] { return super.plan(); }
  /** Due follow-ups not yet reminded for their date; marks them. The text holds a count, never a name. */
  override takeReminders(today?: string): { count: number; contactIds: string[]; text: { title: string; body: string } | null } { return super.takeReminders(today); }
  /** Today's date (YYYY-MM-DD) in the person's time zone. */
  override today(): string { return super.today(); }
}

// ---------------------------------------------------------------- more of the lane's public surface

export { decodeCsvBytes, looksGarbled, parseConnectedOn, localDate, localTimeZone } from './text.ts';
export { urlIdentity } from './csv.ts';
export {
  resolveCompanyKey, interimCompanyKey, isPlaceholderCompany, keysForCompany, howMatched, whyNotCounted,
  type CompanyKeyFn,
} from './company.ts';
export { readTitle, type Seniority, type Field, type TitleFacts } from './titles.ts';
export { scoreContact, RANK_POINTS } from './rank.ts';
export {
  profileSummary, draftFacts, draftMessages, checkDraft, redactContactDetails, cleanDraftText, templateDraft, draftFromTemplate,
  SHORT_CHAR_LIMIT, LONG_CHAR_LIMIT, type DraftFacts, type DraftVariant,
} from './draft.ts';
export { NetworkError, followUpReminderText, type NetworkContactView, type CompanyGroup, type MatchExplanation, type PlanEntry, type ListQuery } from './service.ts';
export { migrateNetwork, openNetworkDatabase, NETWORK_SCHEMA_VERSION } from './db.ts';
export {
  handleNetworkRoute, NetworkApiError, NETWORK_ROUTES, aiErrorToApi,
  type NetworkRouteName, type NetworkRouteDeps, type NetworkRouteInput, type AiDestination,
} from './routes.ts';
