// Builds the shipped place table (dist/places.json.gz).
//
// Sources (every one allows automated download; all are public domain):
//   * USGS GNIS "Populated Places" and "Federal Codes" national files: every US populated place with its state and
//     coordinates, and which of them are Census places (incorporated places and CDPs);
//   * Natural Earth 1:10m populated places: about 7,300 places worldwide with a population figure.
// Optional: GeoNames cities (CC BY 4.0) files that a person downloaded in a browser replace Natural Earth outside the
// US; GeoNames forbids automated download in robots.txt, so this package never fetches them.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { encodeLines } from '../datasets/lines.ts';
import { entryChunks, readZipDirectory } from '../h1b/xlsx.ts';
import { readDbf } from './dbf.ts';
import { CA_PROVINCES, US_STATES } from './regions.ts';
import { normPlace } from './normalize.ts';
import { DATA_DIR } from '../paths.ts';
import { writeFileAtomic } from '../datasets/store.ts';
import { buildTime } from '../h1b/build.ts';

export const PLACES_FORMAT = 'jobleft-places/2';
export const PLACES_DATASET_ID = 'places';

/** [id, name, country, region, lat, lon, population|null, rank] ; rank 1 = city, 2 = CDP, 3..5 = smaller places. */
export type PlaceRow = [id: string, name: string, country: string, region: string | null, lat: number, lon: number, pop: number | null, rank: number];

export interface PlacesMeta {
  id: string;
  name: string;
  version: string;
  sequence: number;
  builtAt: string;
  dataThrough: string | null;
  sources: Array<{ id: string; name: string; url: string | null; file: string; sha256: string; bytes: number; licence: string }>;
  licence: string;
  attribution: string;
  sourceUrl: string;
  test?: boolean;
}

/** The file header line: everything but the place rows, and how many rows follow. */
export interface PlacesHeader { format: typeof PLACES_FORMAT; meta: PlacesMeta; countries: PlacesTable['countries']; regions: PlacesTable['regions']; aliases: PlacesTable['aliases']; counts: { places: number } }

/** gzip of JSON lines: the header, then one line per place. */
export function serializePlacesTable(t: PlacesTable): Buffer {
  const header: PlacesHeader = { format: PLACES_FORMAT, meta: t.meta, countries: t.countries, regions: t.regions, aliases: t.aliases, counts: { places: t.places.length } };
  return encodeLines(header, t.places);
}

export interface PlacesTable {
  format: typeof PLACES_FORMAT;
  meta: PlacesMeta;
  countries: Array<[code: string, name: string]>;
  regions: Array<[country: string, code: string, name: string]>;
  places: PlaceRow[];
  /** [normalized alias text, place id] from data/place-aliases.json. */
  aliases: Array<[string, string]>;
}

async function readZipText(path: string, match: (name: string) => boolean): Promise<string> {
  const entries = readZipDirectory(path);
  const e = entries.find((x) => match(x.name));
  if (!e) throw new Error(`${basename(path)}: no matching file inside`);
  const parts: Buffer[] = [];
  for await (const c of entryChunks(path, e)) parts.push(c);
  return Buffer.concat(parts).toString('utf8').replace(/^﻿/, '');
}

async function readZipBuffer(path: string, match: (name: string) => boolean): Promise<Buffer> {
  const entries = readZipDirectory(path);
  const e = entries.find((x) => match(x.name));
  if (!e) throw new Error(`${basename(path)}: no matching file inside`);
  const parts: Buffer[] = [];
  for await (const c of entryChunks(path, e)) parts.push(c);
  return Buffer.concat(parts);
}

const CLASS_RANK: Record<string, number> = { P1: 1, C1: 1, C4: 1, P4: 1, U1: 2, U2: 2, U5: 3, U3: 4, U4: 4 };

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BuildPlacesOptions {
  srcDir: string;
  outDir: string;
  /** A folder with GeoNames cities1000.zip (or .txt), admin1CodesASCII.txt and countryInfo.txt, downloaded by a person. */
  geonamesDir?: string | null;
  builtAt?: string;
  log?: (s: string) => void;
}

export async function buildPlacesTable(opts: BuildPlacesOptions): Promise<{ path: string; bytes: number; sha256: string; meta: PlacesMeta; report: Record<string, unknown> }> {
  const log = opts.log ?? (() => {});
  const ppZip = join(opts.srcDir, 'PopulatedPlaces_National_Text.zip');
  const fcZip = join(opts.srcDir, 'FedCodes_National_Text.zip');
  const neZip = join(opts.srcDir, 'ne_10m_populated_places_simple.zip');
  for (const f of [ppZip, fcZip]) if (!existsSync(f)) throw new Error(`missing ${f} (run build-places without --src to download it)`);
  const useGeoNames = !!opts.geonamesDir;
  if (!useGeoNames && !existsSync(neZip)) throw new Error(`missing ${neZip}`);

  const stateByName = new Map(US_STATES.map(([c, n]) => [n.toLowerCase(), c]));
  const places: PlaceRow[] = [];
  const report: Record<string, unknown> = {};

  // 1. US: GNIS populated places, ranked by their Census class.
  log('reading GNIS federal codes');
  const classOf = new Map<string, string>();
  for (const line of (await readZipText(fcZip, (n) => n.endsWith('.txt'))).split(/\r?\n/).slice(1)) {
    const c = line.split('|');
    if (c[2] !== 'Populated Place') continue;
    if (!classOf.has(c[0]!)) classOf.set(c[0]!, c[4] ?? '');
  }
  log('reading GNIS populated places');
  let skippedHistorical = 0;
  let skippedBalance = 0;
  const usRows: PlaceRow[] = [];
  for (const line of (await readZipText(ppZip, (n) => n.endsWith('.txt'))).split(/\r?\n/).slice(1)) {
    const c = line.split('|');
    if (c.length < 17 || c[2] !== 'Populated Place') continue;
    const name = c[1]!.trim();
    if (/\(historical\)/i.test(name)) { skippedHistorical += 1; continue; }
    const cls = classOf.get(c[0]!) ?? '';
    if (cls === 'C8' || /\(balance\)/i.test(name)) { skippedBalance += 1; continue; }
    const st = stateByName.get(c[3]!.trim().toLowerCase());
    const lat = Number(c[15]);
    const lon = Number(c[16]);
    if (!st || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    usRows.push([`gnis:${c[0]}`, name, 'US', st, Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, null, CLASS_RANK[cls] ?? 5]);
  }
  report.usPlaces = usRows.length;
  report.skippedHistorical = skippedHistorical;
  report.skippedBalance = skippedBalance;

  // 2. The rest of the world: Natural Earth (or GeoNames when a person supplied the files).
  const countries = new Map<string, string>();
  const regions: Array<[string, string, string]> = [
    ...US_STATES.map(([c, n]) => ['US', c, n] as [string, string, string]),
    ...CA_PROVINCES.map(([c, n]) => ['CA', c, n] as [string, string, string]),
  ];
  const caByName = new Map(CA_PROVINCES.map(([c, n]) => [normPlace(n), c]));
  const worldRows: PlaceRow[] = [];
  const neUs: Array<{ name: string; st: string; lat: number; lon: number; pop: number }> = [];
  const sources: PlacesMeta['sources'] = [
    { id: 'usgs-gnis-populated-places', name: 'USGS Geographic Names Information System (GNIS), Populated Places national file', url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/Topical/PopulatedPlaces_National_Text.zip', file: basename(ppZip), sha256: sha(ppZip), bytes: statSync(ppZip).size, licence: 'US government work, public domain in the US' },
    { id: 'usgs-gnis-federal-codes', name: 'USGS GNIS Federal Codes national file (Census class of each place)', url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/FederalCodes/FedCodes_National_Text.zip', file: basename(fcZip), sha256: sha(fcZip), bytes: statSync(fcZip).size, licence: 'US government work, public domain in the US' },
  ];
  if (existsSync(neZip)) {
    log('reading Natural Earth populated places');
    const { rows } = readDbf(await readZipBuffer(neZip, (n) => n.endsWith('.dbf')));
    sources.push({ id: 'natural-earth-populated-places', name: 'Natural Earth 1:10m Populated Places (simple)', url: 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip', file: basename(neZip), sha256: sha(neZip), bytes: statSync(neZip).size, licence: 'Public domain (Natural Earth)' });
    for (const r of rows) {
      const cc = r.iso_a2 && /^[A-Z]{2}$/.test(r.iso_a2) ? r.iso_a2 : null;
      if (!cc) continue;
      if (r.adm0name && !countries.has(cc)) countries.set(cc, cc === 'US' ? 'United States' : r.adm0name);
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      const pop = Number(r.pop_max) > 0 ? Number(r.pop_max) : null;
      if (cc === 'US') {
        const st = stateByName.get((r.adm1name ?? '').toLowerCase());
        if (st && pop) {
          neUs.push({ name: normPlace(r.name ?? ''), st, lat, lon, pop });
          if ((r.name ?? '').includes(',')) neUs.push({ name: normPlace((r.name ?? '').split(',')[0]!), st, lat, lon, pop });
        }
        continue;
      }
      if (useGeoNames) continue;
      let region: string | null = r.adm1name || null;
      if (cc === 'CA' && region) region = caByName.get(normPlace(region)) ?? region;
      worldRows.push([`ne:${r.ne_id}`, r.name, cc, region, Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, pop, 1]);
    }
  }
  if (useGeoNames) {
    const g = await readGeoNames(opts.geonamesDir!, log);
    for (const [cc, name] of g.countries) if (!countries.has(cc)) countries.set(cc, name);
    for (const r of g.rows) worldRows.push(r);
    sources.push(...g.sources);
  }
  report.worldPlaces = worldRows.length;

  // 3. Population for US places: borrow the Natural Earth figure of the same city (same name and state, within 40 km).
  const usByKey = new Map<string, PlaceRow[]>();
  for (const r of usRows) {
    const k = `${normPlace(r[1])}|${r[3]}`;
    const a = usByKey.get(k) ?? [];
    a.push(r);
    usByKey.set(k, a);
  }
  let popMatched = 0;
  for (const n of neUs) {
    const cands = (usByKey.get(`${n.name}|${n.st}`) ?? []).filter((r) => haversineKm(r[4], r[5], n.lat, n.lon) < 40);
    if (cands.length === 0) continue;
    cands.sort((a, b) => a[7] - b[7] || haversineKm(a[4], a[5], n.lat, n.lon) - haversineKm(b[4], b[5], n.lat, n.lon));
    cands[0]![6] = n.pop;
    popMatched += 1;
  }
  report.usPopulationFromNaturalEarth = popMatched;
  for (const r of usRows) places.push(r);
  for (const r of worldRows) places.push(r);

  // 4. Reviewed aliases (data/place-aliases.json).
  const aliasFile = JSON.parse(readFileSync(join(DATA_DIR, 'place-aliases.json'), 'utf8')) as { aliases: Array<{ text: string; city: string; region: string | null; country: string }> };
  const aliases: Array<[string, string]> = [];
  const missing: string[] = [];
  for (const a of aliasFile.aliases) {
    const want = normPlace(a.city);
    const cands = places.filter((p) => p[2] === a.country && (a.region === null || p[3] === a.region) && normPlace(p[1]) === want);
    cands.sort((x, y) => x[7] - y[7] || (y[6] ?? 0) - (x[6] ?? 0));
    if (cands.length === 0) { missing.push(`${a.text} -> ${a.city}, ${a.region ?? ''} ${a.country}`); continue; }
    aliases.push([normPlace(a.text), cands[0]![0]]);
  }
  if (missing.length) log(`warning: aliases with no target: ${missing.join('; ')}`);
  report.aliases = aliases.length;
  report.aliasesMissing = missing;

  const builtAt = opts.builtAt ?? buildTime();
  const version = builtAt.slice(0, 10);
  const meta: PlacesMeta = {
    id: PLACES_DATASET_ID,
    name: useGeoNames ? 'Places: US places (USGS GNIS) and world cities (GeoNames)' : 'Places: US places (USGS GNIS) and world cities (Natural Earth)',
    version,
    sequence: Number(version.replace(/-/g, '')),
    builtAt,
    dataThrough: '2026-09-02',
    sources,
    licence: useGeoNames ? 'US places: public domain (USGS). World cities: GeoNames, CC BY 4.0.' : 'Public domain (USGS GNIS; Natural Earth)',
    attribution: useGeoNames
      ? 'US places: USGS Geographic Names Information System. World cities: GeoNames (https://www.geonames.org/), licensed under CC BY 4.0.'
      : 'US places: USGS Geographic Names Information System (GNIS). World cities: Made with Natural Earth (naturalearthdata.com). Both are public domain; the attribution is given as a courtesy.',
    sourceUrl: 'https://www.usgs.gov/tools/geographic-names-information-system-gnis',
  };
  const table: PlacesTable = {
    format: PLACES_FORMAT,
    meta,
    countries: [...countries.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    regions,
    places,
    aliases,
  };
  mkdirSync(opts.outDir, { recursive: true });
  const gz = serializePlacesTable(table);
  const outPath = join(opts.outDir, 'places.json.gz');
  writeFileAtomic(outPath, gz);
  return { path: outPath, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex'), meta, report };
}

/** Reads GeoNames files a person downloaded (cities1000.zip or .txt, admin1CodesASCII.txt, countryInfo.txt). */
async function readGeoNames(dir: string, log: (s: string) => void): Promise<{ rows: PlaceRow[]; countries: Array<[string, string]>; sources: PlacesMeta['sources'] }> {
  const pick = (names: string[]) => names.map((n) => join(dir, n)).find((p) => existsSync(p));
  const cities = pick(['cities1000.zip', 'cities1000.txt', 'cities5000.zip', 'cities5000.txt', 'cities15000.zip', 'cities15000.txt', 'cities500.zip', 'cities500.txt']);
  const admin1 = pick(['admin1CodesASCII.txt']);
  const countryInfo = pick(['countryInfo.txt']);
  if (!cities || !admin1 || !countryInfo) throw new Error(`${dir} needs cities1000.zip (or .txt), admin1CodesASCII.txt and countryInfo.txt from https://download.geonames.org/export/dump/`);
  log(`reading GeoNames from ${dir}`);
  const text = cities.endsWith('.zip') ? await readZipText(cities, (n) => n.endsWith('.txt')) : readFileSync(cities, 'utf8');
  const a1 = new Map<string, string>();
  for (const line of readFileSync(admin1, 'utf8').split(/\r?\n/)) { const c = line.split('\t'); if (c.length >= 2) a1.set(c[0]!, c[1]!); }
  const countries: Array<[string, string]> = [];
  for (const line of readFileSync(countryInfo, 'utf8').split(/\r?\n/)) { if (line.startsWith('#')) continue; const c = line.split('\t'); if (c.length > 4 && /^[A-Z]{2}$/.test(c[0]!)) countries.push([c[0]!, c[4]!]); }
  const caByName = new Map(CA_PROVINCES.map(([c, n]) => [normPlace(n), c]));
  const rows: PlaceRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split('\t');
    if (c.length < 15 || c[6] !== 'P') continue;
    const cc = c[8]!;
    if (cc === 'US' || !/^[A-Z]{2}$/.test(cc)) continue;
    let region: string | null = a1.get(`${cc}.${c[10]}`) ?? null;
    if (cc === 'CA' && region) region = caByName.get(normPlace(region)) ?? region;
    const pop = Number(c[14]) > 0 ? Number(c[14]) : null;
    rows.push([`geonames:${c[0]}`, c[1]!, cc, region, Math.round(Number(c[4]) * 1e5) / 1e5, Math.round(Number(c[5]) * 1e5) / 1e5, pop, c[7]!.startsWith('PPLX') ? 4 : 1]);
  }
  const sources = [cities, admin1, countryInfo].map((p) => ({ id: `geonames-${basename(p)}`, name: `GeoNames ${basename(p)}`, url: `https://download.geonames.org/export/dump/${basename(p)}`, file: basename(p), sha256: sha(p), bytes: statSync(p).size, licence: 'CC BY 4.0' }));
  return { rows, countries, sources };
}
