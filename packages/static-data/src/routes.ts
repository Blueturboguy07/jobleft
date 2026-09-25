// Handlers for the static-data routes of the local API (docs/INTERFACES.md section 6.4). apps/server wires them:
//   GET  /api/v1/lookup/h1b?company=...           h1bLookup      -> H1bLookup (+ detail fields)
//   GET  /api/v1/lookup/place?text=...            placeLookup    -> PlaceLookup (+ workModel, remoteScope, unresolved)
//   GET  /api/v1/companies/:companyKey            getCompany     -> Company (+ factsStatus, paidLookup); no request sent
//   POST /api/v1/companies/:companyKey/refresh    refreshCompany -> Company; free sources only when expired; paid only with allowPaid
//   GET  /api/v1/data-sources                     listDatasets   -> DatasetInfo[]
//   POST /api/v1/data-sources/update              updateDatasets -> DatasetInfo[] (a bad release changes nothing)

import type { DatabaseSync } from 'node:sqlite';
import type { DatasetInfo } from '@jobleft/contracts';
import { loadAliasIndex } from './aliases.ts';
import { listDatasets } from './datasets/list.ts';
import { installReleases } from './datasets/release.ts';
import { writeStateFor, type StaticDataOptions } from './datasets/store.ts';
import { CompanyFacts, type CompanyDetail, type PaidSearch } from './facts/company-facts.ts';
import type { PaidEnricher } from './facts/enrich.ts';
import { loadH1bIndex, type H1bIndex, type H1bLookupDetail } from './h1b/index.ts';
import { loadPlaceIndex, type PlaceIndex, type PlaceLookupDetail } from './places/index.ts';

export interface StaticDataRouteOptions extends StaticDataOptions {
  /** The one database (for the company_facts table). */
  db: DatabaseSync;
  /** The polite HTTP client of the app (robots.txt, pacing, host map). Used for Wikidata, SEC and GLEIF only. */
  fetchText: (url: string) => Promise<string>;
  /** The metered search client, or null while paid lookups are off. */
  paid?: PaidSearch | null;
  enricher?: PaidEnricher;
  /** JOBLEFT_DATASET_MANIFEST_URL; null when no release location is set. */
  manifestUrl?: string | null;
  fetchImpl?: typeof fetch;
}

export interface StaticDataRoutes {
  h1b: H1bIndex;
  places: PlaceIndex;
  facts: CompanyFacts;
  h1bLookup(query: { company: string; title?: string }): H1bLookupDetail;
  placeLookup(query: { text: string }): PlaceLookupDetail;
  getCompany(params: { companyKey: string }, query?: { name?: string }): CompanyDetail;
  refreshCompany(params: { companyKey: string }, body: { allowPaid: boolean; maxPriceMicros?: number }, query?: { name?: string }): Promise<CompanyDetail>;
  listDatasets(): DatasetInfo[];
  updateDatasets(): Promise<DatasetInfo[]>;
}

export function createStaticDataRoutes(opts: StaticDataRouteOptions): StaticDataRoutes {
  const aliases = loadAliasIndex();
  const h1b = loadH1bIndex({ ...opts, aliases });
  const places = loadPlaceIndex(opts);
  const facts = new CompanyFacts({ db: opts.db, h1b, aliases, fetchText: opts.fetchText, paid: opts.paid ?? null, enricher: opts.enricher });
  return {
    h1b, places, facts,
    h1bLookup: (q) => h1b.lookup(q.company, { jobTitle: q.title }),
    placeLookup: (q) => places.resolve(q.text),
    getCompany: (p, q) => { if (q?.name) facts.note(q.name); return facts.get(p.companyKey); },
    refreshCompany: (p, b, q) => facts.refresh(p.companyKey, { allowPaid: b.allowPaid, maxPriceMicros: b.maxPriceMicros, name: q?.name }),
    listDatasets: () => listDatasets(opts),
    async updateDatasets() {
      if (!opts.manifestUrl) {
        const msg = 'No release location is set (JOBLEFT_DATASET_MANIFEST_URL), so no update was fetched. The data in use has not changed.';
        for (const id of ['h1b-lca', 'places']) writeStateFor(opts, id, { lastAttemptAt: new Date().toISOString(), lastError: msg, lastErrorAt: new Date().toISOString() });
        return listDatasets(opts);
      }
      await installReleases({ ...opts, releaseManifestUrl: opts.manifestUrl, fetchImpl: opts.fetchImpl });
      return listDatasets(opts);
    },
  };
}
