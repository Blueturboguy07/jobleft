// @jobleft/sources-ats: ATS adapters beyond the crawler's built-ins (Greenhouse, Lever, Ashby), the ATS source
// list (crawled or not, why, checked when), and ATS detection from any URL.
// Phase 1 adds Workable, Recruitee and Personio. Never: SmartRecruiters, LinkedIn, Indeed, Glassdoor. Never without
// the owner's approval: Workday, iCIMS, Oracle, UKG, Taleo.
// Status: interface stubs (foundation). Bodies throw until the sources-ats lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/sources-ats".

import type { AtsId, CrawlAtsId, SourceInfo } from '@jobleft/contracts';
import type { SourceRegistry } from '@jobleft/crawler';

export const PACKAGE_NAME = '@jobleft/sources-ats';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/sources-ats)`);
}

/** The lane's adapters (workable, recruitee, personio, ...). Merge with @jobleft/crawler SOURCES: { ...SOURCES, ...ATS_SOURCES }. */
export const ATS_SOURCES: SourceRegistry = {};

/** What a URL says about the ATS behind it. Pure string work: it sends no request. */
export interface AtsDetection {
  ats: AtsId;
  /** The board token, when the URL names one. */
  board: string | null;
  region: string | null;
  /** The posting id, when the URL is a single job page (for example a Greenhouse gh_jid). */
  jobId: string | null;
  /** true only for CrawlAtsId families; false for workday, icims, smartrecruiters and the rest. */
  crawlable: boolean;
}

/** Recognises board and job URLs of known ATS families (case, tracking parameters and trailing slashes ignored). */
export function detectAts(url: string): AtsDetection | null { return notImplemented('detectAts'); }

/** The public API host of an ATS board (regional hosts included). */
export function atsHost(ats: CrawlAtsId, region: string | null): string { return notImplemented('atsHost'); }

/**
 * The ATS source list: every family jobleft crawls (with evidence that the feed is public) and every family it does
 * not (with a reason and the date the reason was checked). Status fields are filled by the server at run time.
 */
export const ATS_SOURCE_LIST: ReadonlyArray<Omit<SourceInfo, 'enabled' | 'keySet' | 'status'>> = [];
