// @jobleft/static-data: data shipped with the app and the lookups over it.
//   * companyKey(): the one company-name key every package uses to match companies
//   * the H-1B sponsor index (US Department of Labor LCA disclosure data, about 84K employers)
//   * the place dictionary (cities, regions, countries; GeoNames CC BY 4.0 with attribution)
//   * the skill dictionary (canonical names and aliases: "k8s" -> "Kubernetes")
//   * the board directory file that @jobleft/boards loads
//   * company facts (sourced, dated, kept per company; paid lookups only with consent)
// Status: interface stubs (foundation). Bodies throw until the static-data lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/static-data".

import type { DatabaseSync } from 'node:sqlite';
import type { Company, CrawlAtsId, DatasetInfo, H1bLookup, Place, PlaceLookup } from '@jobleft/contracts';

export const PACKAGE_NAME = '@jobleft/static-data';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/static-data)`);
}

/** Where datasets live. Shipped copies sit in `bundledDir`; updated releases are written to `dataDir`. */
export interface StaticDataOptions {
  /** $JOBLEFT_HOME/datasets (updated releases, verified before use). */
  dataDir: string;
  /** Defaults to this package's data/ folder (the copies that ship with the app). */
  bundledDir?: string;
}

/**
 * The company match key. Lower case; accents removed; "&" and "+" become "and"; a leading "the" and legal suffixes
 * (inc, llc, l.l.c., corp, corporation, co, ltd, llp, plc, pbc, gmbh) are removed; punctuation and spaces are removed.
 * It NEVER removes ordinary words such as "technologies", "group", "services" or "holdings" (static-data O5).
 * Examples: "Stripe, Inc." -> "stripe"; "The Home Depot" -> "homedepot"; "Ramp Business Corporation" -> "rampbusiness".
 */
export function companyKey(name: string): string {
  return notImplemented(`companyKey(${JSON.stringify(name)})`);
}

/** Brand to legal filer names that are known to be the same company (a reviewed alias table, never a guess). */
export interface CompanyAliases {
  /** The keys of every name known for this company, including the input's own key. */
  keysFor(name: string): string[];
}

export interface H1bIndex {
  /** found with a summary, or unknown. Never a "no" (static-data O2). */
  lookup(companyName: string): H1bLookup;
  dataset(): DatasetInfo;
}

export interface PlaceIndex {
  /** Resolves "Austin, TX", "SF", "Remote - US", "New York, NY; Austin, TX". Unresolved text stays as written. */
  resolve(text: string): PlaceLookup;
  /** Great-circle distance in miles, or null when either place has no coordinates. */
  distanceMiles(a: Place, b: Place): number | null;
  /** Place ids within the radius of a place id (for the "within 25 miles" filter). */
  within(placeId: string, radiusMiles: number): Set<string>;
  dataset(): DatasetInfo;
}

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

export function loadAliases(opts: StaticDataOptions): CompanyAliases { return notImplemented('loadAliases'); }
export function loadH1bIndex(opts: StaticDataOptions): H1bIndex { return notImplemented('loadH1bIndex'); }
export function loadPlaceIndex(opts: StaticDataOptions): PlaceIndex { return notImplemented('loadPlaceIndex'); }
export function loadSkills(opts: StaticDataOptions): SkillDictionary { return notImplemented('loadSkills'); }
export function loadDirectoryRows(opts: StaticDataOptions): DirectoryRow[] { return notImplemented('loadDirectoryRows'); }
/** Every dataset with its date, licence and attribution (GET /api/v1/data-sources). */
export function listDatasets(opts: StaticDataOptions): DatasetInfo[] { return notImplemented('listDatasets'); }

/** Downloads, verifies (size and sha256 from the release manifest) and swaps in newer releases. A bad release changes nothing. */
export async function updateDatasets(
  opts: StaticDataOptions & { releaseManifestUrl: string; fetchImpl?: typeof fetch },
): Promise<DatasetInfo[]> {
  return notImplemented('updateDatasets');
}

/** A paid lookup the facts service may use only when the person allowed it (see @jobleft/sources-other). */
export interface PaidSearch {
  priceMicros(kind: 'search' | 'page'): number;
  search(query: string, opts: { maxPriceMicros: number; signal?: AbortSignal }): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

export interface CompanyFactsOptions {
  db: DatabaseSync;
  h1b: H1bIndex;
  aliases: CompanyAliases;
  /** Free public sources (Wikidata, SEC, GLEIF) through the polite HTTP client. */
  fetchText: (url: string) => Promise<string>;
  /** null = paid lookups are off. */
  paid: PaidSearch | null;
  now?: () => number;
  /** Kept facts expire after this long (default 30 days). */
  freshForMs?: number;
}

/** Company facts, kept per company key in the `company_facts` table (owned by this package). */
export class CompanyFacts {
  constructor(opts: CompanyFactsOptions) { void opts; }
  /** The kept company, or a company with no facts (never invented ones). */
  get(key: string): Company { return notImplemented('CompanyFacts.get'); }
  /** Reads facts again. A failed refresh keeps the old facts. Paid lookups only with allowPaid and within the cap. */
  async refresh(key: string, opts: { allowPaid: boolean; maxPriceMicros?: number }): Promise<Company> {
    return notImplemented('CompanyFacts.refresh');
  }
  /** Marks every kept fact expired (the documented option to expire kept facts). */
  expireAll(): number { return notImplemented('CompanyFacts.expireAll'); }
}
