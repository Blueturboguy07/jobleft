// @jobleft/static-data: data shipped with the app and the lookups over it.
//   * companyKey(): the one company-name key every package uses to match companies
//   * the H-1B sponsor index (US Department of Labor LCA disclosure data, FY2025 Q1 to FY2026 Q3)
//   * the place dictionary (USGS GNIS US places and Natural Earth world cities; GeoNames from a person's files)
//   * company facts (Wikidata, SEC EDGAR, GLEIF; sourced, dated, kept per company; paid lookups only with consent)
//   * signed dataset releases (a bad release changes nothing)
// Interface: docs/INTERFACES.md, section "@jobleft/static-data". The skill dictionary and the board directory rows
// are still stubs (they are outside this lane's scope).

import type { CrawlAtsId, DatasetInfo } from '@jobleft/contracts';
import { loadAliasIndex, type CompanyAliases } from './aliases.ts';
import { listDatasets as listAll } from './datasets/list.ts';
import { updateDatasets as update } from './datasets/release.ts';
import type { StaticDataOptions } from './datasets/store.ts';
import { loadH1bIndex as loadH1b, type H1bIndex } from './h1b/index.ts';
import { loadPlaceIndex as loadPlaces, type PlaceIndex } from './places/index.ts';

export const PACKAGE_NAME = '@jobleft/static-data';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/static-data)`);
}

export type { StaticDataOptions } from './datasets/store.ts';
export { companyKey, splitDba, nameTokens, COMPANY_KEY_VERSION, LEGAL_SUFFIXES } from './company-key.ts';
export type { CompanyAliases, AliasIndex, AliasEntry } from './aliases.ts';
export type { H1bIndex, H1bLookupDetail, H1bSummaryDetail, H1bEntityDetail } from './h1b/index.ts';
export { LIKELY_MIN_FILINGS, LIKELY_MIN_RECENT, LIKELY_MIN_NEW_HIRE } from './h1b/index.ts';
export type { PlaceIndex, PlaceLookupDetail, WorkModel } from './places/index.ts';
export { normPlace } from './places/normalize.ts';
export { h1bTagFor, passesH1bFilter, type H1bTag, type H1bTagResult } from './h1b/tag.ts';
export { roleFamilyOf, normalizeTitle, SOC_MAJOR_GROUPS, type RoleFamily } from './h1b/role-family.ts';
export { CompanyFacts, migrateCompanyFacts, DEFAULT_FRESH_MS, type CompanyFactsOptions, type CompanyDetail, type PaidSearch, type SourceStatus } from './facts/company-facts.ts';
export { ruleEnricher, checkProposed, type PaidEnricher, type ProposedFact, type SearchResult, type EnrichTarget } from './facts/enrich.ts';
export { installReleases, verifyEnvelope, loadReleaseKeys, type UpdateOutcome, type ReleaseKey } from './datasets/release.ts';
export { LIVE_FACT_SOURCES } from './datasets/list.ts';
export { PoliteFetch, USER_AGENT } from './net/polite-fetch.ts';

export interface SkillDictionary {
  /** The canonical name for a term ("k8s" -> "Kubernetes", "JS" -> "JavaScript"), or null when unknown. */
  canonical(term: string): string | null;
  aliases(canonical: string): string[];
  /** Skills named in a text, canonical, in order of first appearance. "Java" never matches "JavaScript". */
  extract(text: string): string[];
}

/** One row of the shipped board directory. */
export interface DirectoryRow {
  ats: CrawlAtsId;
  board: string;
  region: string | null;
  company: string;
  /** Where the row came from (for THIRD_PARTY_NOTICES and the directory header). */
  source: string;
}

/** The reviewed brand-to-filer alias table (data/company-aliases.json). */
export function loadAliases(opts: StaticDataOptions): CompanyAliases {
  void opts;
  return loadAliasIndex();
}

/** The H-1B sponsor index. Works offline; reloads when a newer verified release is installed. */
export function loadH1bIndex(opts: StaticDataOptions): H1bIndex {
  return loadH1b(opts);
}

/** The place index. Works offline; reloads when a newer verified release is installed. */
export function loadPlaceIndex(opts: StaticDataOptions): PlaceIndex {
  return loadPlaces(opts);
}

export function loadSkills(opts: StaticDataOptions): SkillDictionary { void opts; return notImplemented('loadSkills'); }
export function loadDirectoryRows(opts: StaticDataOptions): DirectoryRow[] { void opts; return notImplemented('loadDirectoryRows'); }

/** Every dataset with its date, licence and attribution (GET /api/v1/data-sources), plus the live fact sources. */
export function listDatasets(opts: StaticDataOptions): DatasetInfo[] {
  return listAll(opts);
}

/** Downloads, verifies (signature, size and sha256 from the signed release manifest) and swaps in newer releases. A bad release changes nothing. */
export async function updateDatasets(opts: StaticDataOptions & { releaseManifestUrl: string; fetchImpl?: typeof fetch }): Promise<DatasetInfo[]> {
  return update(opts);
}
export { createStaticDataRoutes, type StaticDataRoutes, type StaticDataRouteOptions } from './routes.ts';
