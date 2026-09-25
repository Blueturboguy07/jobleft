// @jobleft/network: the Network tool on the person's own LinkedIn Connections.csv (plan section 7).
// Import, match to companies, "who to message first" with true reasons, outreach tracking with reminders, drafts
// that use only the inputs, coverage of target companies, and delete-all. No request ever goes to LinkedIn or a
// people-lookup service; nothing is sent for the person.
// Status: interface stubs (foundation). Bodies throw until the network lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/network".

import type { DatabaseSync } from 'node:sqlite';
import type {
  CompanyCoverage, ContactRank, Job, NetworkContact, NetworkImportSummary, OutreachDraft, OutreachStage,
} from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';

export const PACKAGE_NAME = '@jobleft/network';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/network)`);
}

export interface ParsedConnection {
  line: number;
  firstName: string;
  lastName: string;
  profileUrl: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  connectedOn: string | null;
  maybeGarbled: boolean;
}

/**
 * Parses the export: skips the note lines above the header, handles a BOM, CRLF and quoted commas, and reports every
 * skipped row with a reason. A file that is not a connections export gives notAConnectionsFile: true and no rows.
 */
export function parseConnectionsCsv(text: string): {
  rows: ParsedConnection[]; skipped: Array<{ line: number; reason: string }>; notAConnectionsFile: boolean; warnings: string[];
} { return notImplemented('parseConnectionsCsv'); }

/** Ranks contacts at one company; each reason is true for the contact's row; same data, same order. */
export function rankContacts(contacts: NetworkContact[], ctx: { companyKey: string; job: Job | null; now: number }): ContactRank[] {
  return notImplemented('rankContacts');
}

/** Drafts one message from ONLY this contact's name, title and company, this job, and a short profile summary. */
export async function draftOutreach(input: {
  contact: NetworkContact; job: Job | null; profileSummary: string; variant: 'short' | 'long'; ai: AiClient;
}): Promise<OutreachDraft> { return notImplemented('draftOutreach'); }

export interface NetworkServiceOptions {
  db: DatabaseSync;
  /** @jobleft/static-data companyKey (the same key jobs use). */
  companyKey: (name: string) => string;
  now?: () => number;
}

/** Owns the table `network_contacts`. Deletes are real (rows, drafts, notes; nothing left behind). */
export class NetworkService {
  constructor(opts: NetworkServiceOptions) { void opts; }
  /** Imports the file text. Keeps stages and notes of people already there; never drops a person silently. */
  import(csvText: string): NetworkImportSummary { return notImplemented('NetworkService.import'); }
  list(q: { companyKey?: string; stage?: OutreachStage; q?: string; due?: boolean; inPlan?: boolean }): NetworkContact[] { return notImplemented('NetworkService.list'); }
  /** How many connections work at a company (null when none, so cards show nothing). */
  countFor(companyKey: string): number | null { return notImplemented('NetworkService.countFor'); }
  coverage(targetCompanies: Array<{ companyKey: string; companyName: string }>): CompanyCoverage[] { return notImplemented('NetworkService.coverage'); }
  rank(companyKey: string, job: Job | null): ContactRank[] { return notImplemented('NetworkService.rank'); }
  update(id: string, patch: { stage?: OutreachStage; note?: string | null; followUpOn?: string | null; inPlan?: boolean }): NetworkContact { return notImplemented('NetworkService.update'); }
  delete(id: string): boolean { return notImplemented('NetworkService.delete'); }
  deleteAll(): number { return notImplemented('NetworkService.deleteAll'); }
  /** Contacts whose follow-up date is today or past (for reminders). */
  due(today: string): NetworkContact[] { return notImplemented('NetworkService.due'); }
}
