// Downloads the place sources (USGS GNIS and Natural Earth) politely: robots.txt obeyed, one request per second
// per host, the fixed User-Agent. About 14 MB in total. GeoNames is never fetched (its robots.txt forbids it).

import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PoliteFetch } from '../net/polite-fetch.ts';

export const PLACE_DOWNLOADS: ReadonlyArray<{ url: string; file: string }> = [
  { url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/Topical/PopulatedPlaces_National_Text.zip', file: 'PopulatedPlaces_National_Text.zip' },
  { url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/FederalCodes/FedCodes_National_Text.zip', file: 'FedCodes_National_Text.zip' },
  { url: 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip', file: 'ne_10m_populated_places_simple.zip' },
];

export async function fetchPlaceSourcesV2(dir: string, log: (s: string) => void = () => {}, pf: PoliteFetch = new PoliteFetch({ timeoutMs: 180_000 })): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const d of PLACE_DOWNLOADS) {
    const path = join(dir, d.file);
    if (existsSync(path) && statSync(path).size > 0) { log(`using ${path}`); out.push(path); continue; }
    log(`downloading ${d.url}`);
    const res = await pf.request(d.url, { accept: '*/*' });
    const buf = Buffer.from(await res.arrayBuffer());
    const expected = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(expected) && buf.length !== expected) throw new Error(`${d.file}: download cut short (${buf.length} of ${expected} bytes)`);
    const tmp = `${path}.part`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, buf);
    renameSync(tmp, path);
    out.push(path);
  }
  return out;
}
