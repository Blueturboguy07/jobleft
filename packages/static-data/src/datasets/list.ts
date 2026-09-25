// Every dataset jobleft ships (with date, licence and attribution), and the live sources company facts are read
// from (static-data O10). GET /api/v1/data-sources returns this list.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatasetInfo } from '@jobleft/contracts';
import { ALIAS_FILE } from '../aliases.ts';
import { loadH1bIndex } from '../h1b/index.ts';
import { loadPlaceIndex } from '../places/index.ts';
import { DATA_DIR } from '../paths.ts';
import { readState, type StaticDataOptions } from './store.ts';

/** Live sources of company facts. Nothing is shipped from them; each fact names its own source and date. */
export const LIVE_FACT_SOURCES: readonly DatasetInfo[] = [
  {
    id: 'wikidata', name: 'Wikidata (company facts, read when a company block is opened)', version: 'live',
    dataThrough: null, licence: 'CC0 1.0 (public domain dedication); no attribution required',
    attribution: 'Company facts marked "Wikidata" come from https://www.wikidata.org.', sourceUrl: 'https://www.wikidata.org/wiki/Wikidata:Data_access',
    bytes: 0, updatedAt: '2026-09-25T00:00:00.000Z', lastUpdateError: null,
  },
  {
    id: 'sec-edgar', name: 'SEC EDGAR company data (public companies, read on demand)', version: 'live',
    dataThrough: null, licence: 'US government data, public domain in the US; SEC fair-access rules apply',
    attribution: 'Company facts marked "SEC EDGAR" come from the US Securities and Exchange Commission.', sourceUrl: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces',
    bytes: 0, updatedAt: '2026-09-25T00:00:00.000Z', lastUpdateError: null,
  },
  {
    id: 'gleif', name: 'GLEIF LEI records (legal entities, read on demand)', version: 'live',
    dataThrough: null, licence: 'CC0 1.0', attribution: 'Legal-entity facts marked "GLEIF" come from the Global Legal Entity Identifier Foundation.',
    sourceUrl: 'https://www.gleif.org/en/about/open-data', bytes: 0, updatedAt: '2026-09-25T00:00:00.000Z', lastUpdateError: null,
  },
];

function aliasInfo(): DatasetInfo {
  const path = join(DATA_DIR, ALIAS_FILE);
  let reviewed = '2026-09-25';
  let bytes = 0;
  let entries = 0;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { reviewed?: string; entries?: unknown[] };
    reviewed = j.reviewed ?? reviewed;
    entries = j.entries?.length ?? 0;
    bytes = statSync(path).size;
  } catch { /* reported below as missing */ }
  return {
    id: 'company-aliases', name: `Reviewed company name aliases (${entries} entries: brand to legal H-1B filer)`, version: reviewed,
    dataThrough: reviewed, licence: 'jobleft project data (company names are facts)', attribution: null, sourceUrl: null,
    bytes, updatedAt: `${reviewed}T00:00:00.000Z`, lastUpdateError: bytes === 0 ? 'The alias table is missing.' : null,
  };
}

function socInfo(): DatasetInfo {
  return {
    id: 'soc-major-groups', name: '2018 Standard Occupational Classification major groups (role families)', version: '2018',
    dataThrough: null, licence: 'US government work (US Bureau of Labor Statistics), public domain in the US', attribution: null,
    sourceUrl: 'https://www.bls.gov/soc/2018/major_groups.htm', bytes: 0, updatedAt: '2026-09-25T00:00:00.000Z', lastUpdateError: null,
  };
}

export function listDatasets(opts: StaticDataOptions, include: { live?: boolean } = { live: true }): DatasetInfo[] {
  const state = readState(opts);
  const withState = (d: DatasetInfo): DatasetInfo => {
    const s = state[d.id];
    const err = s?.lastError ?? null;
    return { ...d, lastUpdateError: err ?? d.lastUpdateError };
  };
  const out: DatasetInfo[] = [
    withState(loadH1bIndex(opts).dataset()),
    withState(loadPlaceIndex(opts).dataset()),
    aliasInfo(),
    socInfo(),
  ];
  if (include.live !== false) out.push(...LIVE_FACT_SOURCES);
  return out;
}
