// The place lookup (static-data O13, O14). Exact rules only: a place resolves when its name matches exactly (after
// normalization) inside the state or country the text gives; with no state or country, only when one candidate
// clearly dominates. Otherwise the answer lists the candidates as "ambiguous" and resolves nothing. Text that names
// a work model or a country ("Remote - US", "United States") is marked notACity. Unresolved text is left as written.

import { lines } from '../datasets/lines.ts';
import type { DatasetInfo, Place, PlaceLookup } from '@jobleft/contracts';
import { activeStamp, loadDataset, writeStateFor, type DatasetRecord, type StaticDataOptions } from '../datasets/store.ts';
import { PLACES_DATASET_ID, PLACES_FORMAT, type PlaceRow, type PlacesHeader, type PlacesMeta, type PlacesTable } from './build.ts';
import { normPlace } from './normalize.ts';
import { PlaceStore } from './compact.ts';
import { COUNTRY_ALIASES, STATE_COUNTRY_CLASHES, US_STATE_ABBREVIATIONS } from './regions.ts';

export type WorkModel = 'remote' | 'hybrid' | 'onsite';

/** The contract answer plus the work model and remote scope the text states. */
export interface PlaceLookupDetail extends PlaceLookup {
  workModel: WorkModel | null;
  /** Where a remote job accepts people from, as the text states it (ISO codes); null when not remote. */
  remoteScope: { regions: string[]; text: string } | null;
  /** Parts of the text that did not resolve, as written. */
  unresolved: string[];
}

export interface PlaceIndex {
  resolve(text: string): PlaceLookupDetail;
  distanceMiles(a: Place, b: Place): number | null;
  within(placeId: string, radiusMiles: number): Set<string>;
  dataset(): DatasetInfo;
}

interface Prepared {
  meta: PlacesMeta;
  record: DatasetRecord;
  s: PlaceStore;
  byName: Map<string, number[]>;
  aliases: Map<string, string>;
  countryByText: Map<string, string>;
  countryName: Map<string, string>;
  /** "US" -> (normalized name or code -> code). */
  regionByText: Map<string, Map<string, string>>;
  regionName: Map<string, string>;
  grid: Map<string, number[]>;
}

const CELL = 0.5;
const cellKey = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

function checkPlacesHeader(h: PlacesHeader): PlacesHeader {
  if (!h || h.format !== PLACES_FORMAT || !h.meta || !(h.counts?.places > 0)) throw new Error('not a jobleft place table');
  if (h.meta.id !== PLACES_DATASET_ID) throw new Error('the place table has the wrong id');
  return h;
}

/** Reads every line of a place table file and checks the row count (for release checks). */
export function validatePlacesFile(bytes: Buffer): PlacesHeader {
  let header: PlacesHeader | null = null;
  let rows = 0;
  for (const line of lines(bytes)) {
    const v = JSON.parse(line) as unknown;
    if (!header) { header = checkPlacesHeader(v as PlacesHeader); continue; }
    if (!Array.isArray(v)) throw new Error('the place table has a damaged row');
    rows += 1;
  }
  if (!header || rows !== header.counts.places) throw new Error('the place table is cut short');
  return header;
}

/** The whole table as objects (for tools and tests). */
export function parsePlacesTable(bytes: Buffer): PlacesTable {
  let header: PlacesHeader | null = null;
  const places: PlaceRow[] = [];
  for (const line of lines(bytes)) {
    if (!header) { header = checkPlacesHeader(JSON.parse(line) as PlacesHeader); continue; }
    places.push(JSON.parse(line) as PlaceRow);
  }
  if (!header || places.length !== header.counts.places) throw new Error('the place table is cut short');
  return { format: PLACES_FORMAT, meta: header.meta, countries: header.countries, regions: header.regions, aliases: header.aliases, places };
}

function prepare(bytes: Buffer, record: DatasetRecord): Prepared {
  const byName = new Map<string, number[]>();
  const grid = new Map<string, number[]>();
  const otherRegions: Array<[string, string]> = [];
  let header: PlacesHeader | null = null;
  let store: PlaceStore | null = null;
  let i = 0;
  for (const line of lines(bytes)) {
    if (!header) { header = checkPlacesHeader(JSON.parse(line) as PlacesHeader); store = new PlaceStore(header.counts.places); continue; }
    const p = JSON.parse(line) as PlaceRow;
    store!.add(i, p);
    const n = normPlace(p[1]);
    const a = byName.get(n);
    if (a) a.push(i); else byName.set(n, [i]);
    const g = cellKey(p[4], p[5]);
    const ga = grid.get(g);
    if (ga) ga.push(i); else grid.set(g, [i]);
    if (p[2] !== 'US' && p[2] !== 'CA' && p[3]) otherRegions.push([p[2], p[3]]);
    i += 1;
  }
  if (!header || !store || i !== header.counts.places) throw new Error('the place table is cut short');
  const t = { meta: header.meta, countries: header.countries, regions: header.regions, aliases: header.aliases };
  const countryByText = new Map<string, string>();
  const countryName = new Map<string, string>();
  for (const [cc, name] of t.countries) { countryByText.set(normPlace(name), cc); countryName.set(cc, name); }
  for (const [k, cc] of Object.entries(COUNTRY_ALIASES)) countryByText.set(normPlace(k), cc);
  if (!countryName.has('US')) countryName.set('US', 'United States');
  const regionByText = new Map<string, Map<string, string>>();
  const regionName = new Map<string, string>();
  for (const [cc, code, name] of t.regions) {
    let m = regionByText.get(cc);
    if (!m) { m = new Map(); regionByText.set(cc, m); }
    m.set(normPlace(code), code);
    m.set(normPlace(name), code);
    regionName.set(`${cc}-${code}`, name);
  }
  const us = regionByText.get('US')!;
  for (const [k, code] of Object.entries(US_STATE_ABBREVIATIONS)) us.set(normPlace(k), code);
  // Region names of other countries, as the place rows carry them ("Karnataka", "England").
  for (const [cc, region] of otherRegions) {
    let m = regionByText.get(cc);
    if (!m) { m = new Map(); regionByText.set(cc, m); }
    m.set(normPlace(region), region);
  }
  const aliases = new Map(t.aliases);
  const s = store.finish();
  return { meta: t.meta, record, s, byName, aliases, countryByText, countryName, regionByText, regionName, grid };
}

function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing

const REMOTE_RE = /\b(remote(?:ly)?|work from home|wfh|telecommut\w*|distributed|virtual|anywhere|home[- ]based)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[- ]?site|in[- ]office|in[- ]person)\b/i;
const FILLER_RE = /\b(remote(?:ly)?|work from home|wfh|telecommut\w*|distributed|virtual|anywhere|home[- ]based|hybrid|on[- ]?site|in[- ]office|in[- ]person|friendly|first|only|based|eligible|option(?:al)?|within|in the|in|the|from|of|position|role|work)\b/gi;

interface Parsed { places: Place[]; ambiguous: Place[]; notACity: boolean; workModel: WorkModel | null; remoteRegions: string[] | null; unresolved: string | null }

function splitParts(text: string): string[] {
  return text.split(/\s*(?:;|\||\n|•|·|\s\/\s)\s*|\s+or\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function loadPlaceIndex(opts: StaticDataOptions): PlaceIndex {
  let stamp = '';
  let prepared: Prepared | null = null;
  let error: string | null = null;
  let checkedAt = 0;

  const refresh = () => {
    const now = Date.now();
    if (prepared && now - checkedAt < 1000) return;
    checkedAt = now;
    const s = activeStamp(opts);
    if (s === stamp && (prepared || error)) return;
    stamp = s;
    let ready: Prepared | null = null;
    const loaded = loadDataset(opts, PLACES_DATASET_ID, (bytes, rec) => { ready = prepare(bytes, rec); });
    if (loaded && ready) {
      prepared = ready;
      error = loaded.warning;
      if (loaded.warning) writeStateFor(opts, PLACES_DATASET_ID, { lastError: loaded.warning, lastErrorAt: new Date().toISOString() });
    } else {
      prepared = null;
      error = loaded?.warning ?? 'The place data is missing or damaged. Places show as written until it is restored.';
    }
  };

  const toPlace = (p: Prepared, i: number, text: string): Place => {
    const s = p.s;
    return { text, city: s.name(i), region: s.region(i), country: s.cc(i), placeId: s.id(i), lat: s.lat(i), lon: s.lon(i) };
  };
  const regionPlace = (cc: string, code: string, text: string): Place => ({ text, city: null, region: code, country: cc, placeId: `region:${cc}-${code}` });
  const countryPlace = (cc: string, text: string): Place => ({ text, city: null, region: null, country: cc, placeId: `country:${cc}` });

  /** The best place among candidates in one area: city rank first, then population. Null when two tie. */
  const best = (p: Prepared, idx: number[]): { pick: number | null; others: number[] } => {
    if (idx.length === 0) return { pick: null, others: [] };
    const s = p.s;
    const sorted = [...idx].sort((a, b) => s.rank(a) - s.rank(b) || (s.pop(b) ?? 0) - (s.pop(a) ?? 0));
    const top = sorted[0]!;
    const second = sorted[1];
    if (second === undefined || s.rank(second) > s.rank(top)) return { pick: top, others: sorted.slice(1) };
    const tp = s.pop(top) ?? 0;
    const sp = s.pop(second) ?? 0;
    if (tp > 0 && tp >= 5 * sp) return { pick: sorted[0]!, others: sorted.slice(1) };
    return { pick: null, others: sorted };
  };

  /** A bare city name (no state, no country). */
  const bare = (p: Prepared, idx: number[]): { pick: number | null; ambiguous: number[] } => {
    // Collapse each state or country to its best place.
    const groups = new Map<string, number[]>();
    for (const i of idx) {
      const k = `${p.s.cc(i)}|${p.s.region(i) ?? ''}`;
      const a = groups.get(k) ?? [];
      a.push(i);
      groups.set(k, a);
    }
    const reps: number[] = [];
    for (const g of groups.values()) {
      const b = best(p, g);
      reps.push(b.pick ?? b.others[0]!);
    }
    if (reps.length === 1) return { pick: reps[0]!, ambiguous: [] };
    const pop = (i: number) => p.s.pop(i) ?? 0;
    reps.sort((a, b) => pop(b) - pop(a) || p.s.rank(a) - p.s.rank(b));
    const t1 = reps[0]!;
    const t2 = reps[1]!;
    const others = (pick: number) => reps.filter((i) => i !== pick && (p.s.rank(i) <= 2 || pop(i) >= 50_000)).slice(0, 5);
    if (pop(t1) >= 100_000 && pop(t1) >= 20 * Math.max(pop(t2), 1)) return { pick: t1, ambiguous: others(t1) };
    const us = reps.filter((i) => p.s.cc(i) === 'US');
    const nonUsMax = Math.max(0, ...reps.filter((i) => p.s.cc(i) !== 'US').map(pop));
    if (us.length > 0) {
      const u1 = us[0]!;
      const restUs = us.slice(1).map(pop);
      // Another US city of 100,000 or more with the same name makes a bare name ambiguous ("Portland": OR and ME).
      if (pop(u1) >= 100_000 && restUs.every((x) => x * 20 <= pop(u1) && x < 100_000) && nonUsMax < 0.5 * pop(u1)) return { pick: u1, ambiguous: others(u1) };
    }
    // No population at all: one incorporated city among small places.
    if (reps.every((i) => pop(i) === 0)) {
      const cities = reps.filter((i) => p.s.rank(i) === 1);
      if (cities.length === 1) return { pick: cities[0]!, ambiguous: others(cities[0]!) };
    }
    return { pick: null, ambiguous: reps.filter((i) => p.s.rank(i) <= 3 || pop(i) > 0).slice(0, 6) };
  };

  const countryOf = (p: Prepared, token: string, original: string): string | null => {
    const n = normPlace(token);
    const byName = p.countryByText.get(n);
    if (byName) return byName;
    // Two-letter ISO codes only when written in capitals ("CA" is also California: handled by the caller).
    if (/^[A-Z]{2}$/.test(original.trim()) && p.countryName.has(original.trim())) return original.trim();
    return null;
  };

  const regionOf = (p: Prepared, cc: string, token: string): string | null => {
    const m = p.regionByText.get(cc);
    return m?.get(normPlace(token)) ?? null;
  };

  const stripArea = (s: string): string => normPlace(s).replace(/^greater /, '').replace(/ (metropolitan area|metro area|bay area|area|metro|region)$/, '').trim();

  const parsePart = (p: Prepared, raw: string): Parsed => {
    const text = raw.trim();
    let workModel: WorkModel | null = null;
    if (REMOTE_RE.test(text)) workModel = 'remote';
    else if (HYBRID_RE.test(text)) workModel = 'hybrid';
    else if (ONSITE_RE.test(text)) workModel = 'onsite';
    let rest = text;
    if (workModel) {
      rest = rest.replace(/\(([^)]*)\)/g, ', $1').replace(FILLER_RE, ' ').replace(/\s*[-–—:]\s*/g, ', ');
    }
    rest = rest.replace(/\b\d{5}(?:-\d{4})?\b/g, ' ').replace(/[()]/g, ' ');
    const tokens = rest.split(',').map((s) => s.trim()).filter((s) => normPlace(s).length > 0);
    const out: Parsed = { places: [], ambiguous: [], notACity: false, workModel, remoteRegions: null, unresolved: null };
    if (tokens.length === 0) {
      out.notACity = true;
      if (workModel === 'remote') out.remoteRegions = [];
      return out;
    }
    // Whole-text alias ("SF", "NYC", "Washington DC").
    const whole = normPlace(tokens.join(' '));
    const aliasId = p.aliases.get(whole);
    const aliasRow = aliasId !== undefined ? p.s.indexOf(aliasId) : undefined;
    if (aliasRow !== undefined) {
      out.places.push(toPlace(p, aliasRow, text));
      const asRegion = regionOf(p, 'US', tokens.join(' '));
      if (asRegion && tokens.length === 1 && /^[A-Z]{2}$/.test(tokens[0]!) && asRegion !== p.s.region(aliasRow)) out.ambiguous.push(regionPlace('US', asRegion, text));
      if (whole === 'new york') out.ambiguous.push(regionPlace('US', 'NY', text));
      if (workModel === 'remote') out.remoteRegions = [p.s.cc(aliasRow)];
      return out;
    }

    // Interpretations of the trailing tokens: [city tokens, country, region].
    type Interp = { cityTokens: string[]; cc: string | null; region: string | null };
    const interps: Interp[] = [];
    const lastRaw = tokens[tokens.length - 1]!;
    const lastNorm = normPlace(lastRaw);
    const pushWithRegion = (cityTokens: string[], cc: string | null) => {
      // A region token right before the city tokens end ("Austin, TX", "Toronto, Ontario").
      if (cityTokens.length >= 2) {
        const reg = cityTokens[cityTokens.length - 1]!;
        const regionCountries = cc ? [cc] : ['US', 'CA'];
        let found = false;
        for (const c of regionCountries) {
          const code = regionOf(p, c, reg);
          if (code) { interps.push({ cityTokens: cityTokens.slice(0, -1), cc: c, region: code }); found = true; }
        }
        if (found) return;
      }
      if (cityTokens.length === 1 && !cc) {
        // "Austin TX", "Portland Oregon": a trailing state code or name inside one token.
        const words = cityTokens[0]!.trim().split(/\s+/);
        for (let k = 1; k <= Math.min(3, words.length - 1); k++) {
          const tail = words.slice(words.length - k).join(' ');
          const code = (k === 1 && /^[A-Z]{2}$/.test(tail)) || k > 1 || tail.length > 2 ? regionOf(p, 'US', tail) : null;
          if (code) { interps.push({ cityTokens: [words.slice(0, words.length - k).join(' ')], cc: 'US', region: code }); return; }
        }
      }
      interps.push({ cityTokens, cc, region: null });
    };
    const lastCountry = countryOf(p, lastRaw, lastRaw);
    const lastIsUsState = regionOf(p, 'US', lastRaw) !== null && (lastRaw.trim().length > 2 ? true : /^[A-Z]{2}$/.test(lastRaw.trim()));
    if (lastCountry && tokens.length >= 1) {
      if (STATE_COUNTRY_CLASHES.has(lastNorm) || (lastIsUsState && /^[A-Z]{2}$/.test(lastRaw.trim()))) {
        // "Georgia" (US state or country), "CA" (California or Canada): try both.
        pushWithRegion(tokens, null);
        pushWithRegion(tokens.slice(0, -1), lastCountry);
      } else {
        pushWithRegion(tokens.slice(0, -1), lastCountry);
      }
    } else {
      pushWithRegion(tokens, null);
    }

    // Region or country only ("Texas", "United States", "Georgia").
    const cityless = interps.filter((it) => it.cityTokens.length === 0 || it.cityTokens.every((t) => normPlace(t) === ''));
    const withCity = interps.filter((it) => !cityless.includes(it));
    const cityCands: number[] = [];
    let anySpecified = false;
    for (const it of withCity) {
      const cityNorm = stripArea(it.cityTokens[0]!);
      let idx = p.byName.get(cityNorm) ?? [];
      if (idx.length === 0 && it.cityTokens.length === 1 && !it.cc && !it.region) {
        // A single token that is only a region or country ("Texas", "Georgia", "Canada").
        const reg = regionOf(p, 'US', it.cityTokens[0]!) ?? regionOf(p, 'CA', it.cityTokens[0]!);
        const cc = countryOf(p, it.cityTokens[0]!, it.cityTokens[0]!);
        if (reg || cc) { cityless.push({ cityTokens: [], cc: reg ? null : cc, region: null }); continue; }
      }
      if (it.cc) idx = idx.filter((i) => p.s.cc(i) === it.cc);
      if (it.region) idx = idx.filter((i) => p.s.region(i) === it.region);
      if (it.cc || it.region) anySpecified = true;
      cityCands.push(...idx);
    }

    // The single token may be a region AND a big city ("Washington", "New York").
    if (tokens.length === 1 && withCity.length > 0) {
      const t = tokens[0]!;
      const stateCode = t.trim().length > 2 || /^[A-Z]{2}$/.test(t.trim()) ? regionOf(p, 'US', t) ?? regionOf(p, 'CA', t) : null;
      const cc = countryOf(p, t, t);
      if (stateCode || cc) {
        const isCa = !regionOf(p, 'US', t) && !!regionOf(p, 'CA', t);
        const regionPl = stateCode ? regionPlace(isCa ? 'CA' : 'US', stateCode, text) : null;
        const countryPl = cc ? countryPlace(cc, text) : null;
        const bigCities = [...new Set(cityCands)].filter((i) => (p.s.pop(i) ?? 0) >= 500_000);
        const alts: Place[] = [...bigCities.map((i) => toPlace(p, i, text))];
        if (regionPl && countryPl && regionPl.country !== countryPl.country) alts.push(countryPl);
        if (alts.length > 0) {
          out.ambiguous.push(...[regionPl ?? countryPl!, ...alts]);
          out.notACity = bigCities.length === 0;
          if (workModel === 'remote') out.remoteRegions = cc ? [cc] : [];
          return out;
        }
        out.places.push(regionPl ?? countryPl!);
        out.notACity = true;
        if (workModel === 'remote') out.remoteRegions = [regionPl?.country ?? countryPl!.country!];
        return out;
      }
    }

    const uniq = [...new Set(cityCands)];
    if (uniq.length > 0) {
      let pick: number | null;
      let amb: number[];
      if (anySpecified) {
        // Group by area; several areas (from two interpretations) are resolved only when one area wins clearly.
        const areas = new Set(uniq.map((i) => `${p.s.cc(i)}|${p.s.region(i) ?? ''}`));
        if (areas.size === 1) {
          const b = best(p, uniq);
          pick = b.pick;
          amb = b.pick === null ? b.others.slice(0, 6) : [];
        } else {
          const b = bare(p, uniq);
          pick = b.pick;
          amb = b.ambiguous;
        }
      } else {
        const b = bare(p, uniq);
        pick = b.pick;
        amb = b.ambiguous;
      }
      if (pick !== null) out.places.push(toPlace(p, pick, text));
      out.ambiguous.push(...amb.filter((i) => i !== pick).map((i) => toPlace(p, i, text)));
      if (workModel === 'remote') out.remoteRegions = pick !== null ? [p.s.cc(pick)] : [];
      if (pick === null && amb.length === 0) out.unresolved = text;
      return out;
    }

    if (cityless.length > 0 && withCity.every((it) => (p.byName.get(stripArea(it.cityTokens[0]!)) ?? []).length === 0)) {
      const regionOrCountry: Place[] = [];
      for (const it of cityless) {
        if (it.region && it.cc) regionOrCountry.push(regionPlace(it.cc, it.region, text));
        else if (it.cc) regionOrCountry.push(countryPlace(it.cc, text));
      }
      // "Georgia": the US state or the country.
      if (tokens.length === 1 && STATE_COUNTRY_CLASHES.has(lastNorm)) {
        out.ambiguous.push(regionPlace('US', regionOf(p, 'US', lastRaw)!, text), countryPlace(countryOf(p, lastRaw, lastRaw)!, text));
        out.notACity = true;
        if (workModel === 'remote') out.remoteRegions = [];
        return out;
      }
      const uniqPlaces = regionOrCountry.filter((pl, i, a) => a.findIndex((x) => x.placeId === pl.placeId) === i);
      if (uniqPlaces.length === 1) out.places.push(uniqPlaces[0]!);
      else out.ambiguous.push(...uniqPlaces);
      out.notACity = true;
      if (workModel === 'remote') out.remoteRegions = uniqPlaces.map((x) => x.country!).filter((x, i, a) => a.indexOf(x) === i);
      return out;
    }

    out.unresolved = text;
    if (workModel === 'remote') out.remoteRegions = [];
    return out;
  };

  const emptyDataset = (): DatasetInfo => ({
    id: PLACES_DATASET_ID, name: 'Places', version: 'none', dataThrough: null, licence: 'Public domain (USGS GNIS; Natural Earth)',
    attribution: null, sourceUrl: null, bytes: 0, updatedAt: new Date(0).toISOString(), lastUpdateError: error ?? 'The place data is missing.',
  });

  return {
    resolve(text: string): PlaceLookupDetail {
      refresh();
      const input = String(text ?? '');
      const detail: PlaceLookupDetail = { input, places: [], ambiguous: [], notACity: false, workModel: null, remoteScope: null, unresolved: [] };
      if (!prepared || !input.trim()) {
        if (input.trim()) detail.unresolved.push(input.trim());
        return detail;
      }
      const parts = splitParts(input);
      let allNotCity = parts.length > 0;
      const remoteRegions: string[] = [];
      let remoteText: string | null = null;
      for (const part of parts) {
        const r = parsePart(prepared, part);
        for (const pl of r.places) if (!detail.places.some((x) => x.placeId === pl.placeId)) detail.places.push(pl);
        for (const pl of r.ambiguous) if (!detail.ambiguous.some((x) => x.placeId === pl.placeId) && !detail.places.some((x) => x.placeId === pl.placeId)) detail.ambiguous.push(pl);
        if (!r.notACity) allNotCity = false;
        if (r.unresolved) detail.unresolved.push(r.unresolved);
        if (r.workModel && (!detail.workModel || r.workModel === 'remote')) detail.workModel = r.workModel;
        if (r.remoteRegions) { remoteRegions.push(...r.remoteRegions); remoteText = remoteText ?? part; }
      }
      detail.notACity = allNotCity && detail.places.every((pl) => pl.city === null);
      if (detail.workModel === 'remote' && remoteText !== null) {
        detail.remoteScope = { regions: [...new Set(remoteRegions)], text: remoteText };
      }
      return detail;
    },
    distanceMiles(a: Place, b: Place): number | null {
      refresh();
      const coords = (pl: Place): [number, number] | null => {
        if (typeof pl.lat === 'number' && typeof pl.lon === 'number') return [pl.lat, pl.lon];
        const row = prepared && pl.placeId ? prepared.s.indexOf(pl.placeId) : undefined;
        if (prepared && row !== undefined) return [prepared.s.lat(row), prepared.s.lon(row)];
        return null;
      };
      const ca = coords(a);
      const cb = coords(b);
      if (!ca || !cb) return null;
      return milesBetween(ca[0], ca[1], cb[0], cb[1]);
    },
    within(placeId: string, radiusMiles: number): Set<string> {
      refresh();
      const out = new Set<string>();
      const ci = prepared ? prepared.s.indexOf(placeId) : undefined;
      if (!prepared || ci === undefined || !(radiusMiles >= 0)) return out;
      const s = prepared.s;
      const cLat = s.lat(ci);
      const cLon = s.lon(ci);
      const dLat = radiusMiles / 69 + CELL;
      const dLon = radiusMiles / (69 * Math.max(0.05, Math.cos((cLat * Math.PI) / 180))) + CELL;
      for (let la = Math.floor((cLat - dLat) / CELL); la <= Math.floor((cLat + dLat) / CELL); la++) {
        for (let lo = Math.floor((cLon - dLon) / CELL); lo <= Math.floor((cLon + dLon) / CELL); lo++) {
          for (const i of prepared.grid.get(`${la}:${lo}`) ?? []) {
            if (milesBetween(cLat, cLon, s.lat(i), s.lon(i)) <= radiusMiles) out.add(s.id(i));
          }
        }
      }
      return out;
    },
    dataset(): DatasetInfo {
      refresh();
      if (!prepared) return emptyDataset();
      const rec = prepared.record;
      return {
        id: rec.id, name: prepared.meta.test ? `${prepared.meta.name} (TEST RELEASE: synthetic data)` : prepared.meta.name, version: rec.version,
        dataThrough: prepared.meta.dataThrough, licence: rec.licence, attribution: rec.attribution, sourceUrl: rec.sourceUrl,
        bytes: rec.bytes, updatedAt: rec.installedAt ?? rec.builtAt, lastUpdateError: error,
      };
    },
  };
}
