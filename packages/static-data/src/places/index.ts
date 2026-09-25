// The place lookup (static-data O13, O14). Exact rules only: a place resolves when its name matches exactly (after
// normalization) inside the state or country the text gives; with no state or country, only when one candidate
// clearly dominates. Otherwise the answer lists the candidates as "ambiguous" and resolves nothing. Text that names
// a work model or a country ("Remote - US", "United States") is marked notACity. Unresolved text is left as written.

import { gunzipSync } from 'node:zlib';
import type { DatasetInfo, Place, PlaceLookup } from '@jobleft/contracts';
import { activeStamp, loadDataset, writeStateFor, type DatasetRecord, type StaticDataOptions } from '../datasets/store.ts';
import { PLACES_DATASET_ID, PLACES_FORMAT, type PlaceRow, type PlacesMeta, type PlacesTable } from './build.ts';
import { normPlace } from './normalize.ts';
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
  places: PlaceRow[];
  byId: Map<string, number>;
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

export function parsePlacesTable(bytes: Buffer): PlacesTable {
  const t = JSON.parse(gunzipSync(bytes).toString('utf8')) as PlacesTable;
  if (t.format !== PLACES_FORMAT || !Array.isArray(t.places) || t.places.length === 0) throw new Error('not a jobleft place table');
  if (t.meta?.id !== PLACES_DATASET_ID) throw new Error('the place table has the wrong id');
  return t;
}

function prepare(t: PlacesTable, record: DatasetRecord): Prepared {
  const byId = new Map<string, number>();
  const byName = new Map<string, number[]>();
  const grid = new Map<string, number[]>();
  t.places.forEach((p, i) => {
    byId.set(p[0], i);
    const n = normPlace(p[1]);
    const a = byName.get(n);
    if (a) a.push(i); else byName.set(n, [i]);
    const g = cellKey(p[4], p[5]);
    const ga = grid.get(g);
    if (ga) ga.push(i); else grid.set(g, [i]);
  });
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
  for (const p of t.places) {
    if (p[2] === 'US' || p[2] === 'CA' || !p[3]) continue;
    let m = regionByText.get(p[2]);
    if (!m) { m = new Map(); regionByText.set(p[2], m); }
    m.set(normPlace(p[3]), p[3]);
  }
  const aliases = new Map(t.aliases);
  return { meta: t.meta, record, places: t.places, byId, byName, aliases, countryByText, countryName, regionByText, regionName, grid };
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
    let table: PlacesTable | null = null;
    const loaded = loadDataset(opts, PLACES_DATASET_ID, (bytes) => { table = parsePlacesTable(bytes); });
    if (loaded && table) {
      prepared = prepare(table, loaded.record);
      error = loaded.warning;
      if (loaded.warning) writeStateFor(opts, PLACES_DATASET_ID, { lastError: loaded.warning, lastErrorAt: new Date().toISOString() });
    } else {
      prepared = null;
      error = loaded?.warning ?? 'The place data is missing or damaged. Places show as written until it is restored.';
    }
  };

  const toPlace = (p: Prepared, i: number, text: string): Place => {
    const r = p.places[i]!;
    return { text, city: r[1], region: r[3], country: r[2], placeId: r[0], lat: r[4], lon: r[5] };
  };
  const regionPlace = (cc: string, code: string, text: string): Place => ({ text, city: null, region: code, country: cc, placeId: `region:${cc}-${code}` });
  const countryPlace = (cc: string, text: string): Place => ({ text, city: null, region: null, country: cc, placeId: `country:${cc}` });

  /** The best place among candidates in one area: city rank first, then population. Null when two tie. */
  const best = (p: Prepared, idx: number[]): { pick: number | null; others: number[] } => {
    if (idx.length === 0) return { pick: null, others: [] };
    const sorted = [...idx].sort((a, b) => p.places[a]![7] - p.places[b]![7] || (p.places[b]![6] ?? 0) - (p.places[a]![6] ?? 0));
    const top = p.places[sorted[0]!]!;
    const second = sorted[1] !== undefined ? p.places[sorted[1]]! : null;
    if (!second || second[7] > top[7]) return { pick: sorted[0]!, others: sorted.slice(1) };
    const tp = top[6] ?? 0;
    const sp = second[6] ?? 0;
    if (tp > 0 && tp >= 5 * sp) return { pick: sorted[0]!, others: sorted.slice(1) };
    return { pick: null, others: sorted };
  };

  /** A bare city name (no state, no country). */
  const bare = (p: Prepared, idx: number[]): { pick: number | null; ambiguous: number[] } => {
    // Collapse each state or country to its best place.
    const groups = new Map<string, number[]>();
    for (const i of idx) {
      const r = p.places[i]!;
      const k = `${r[2]}|${r[3] ?? ''}`;
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
    const pop = (i: number) => p.places[i]![6] ?? 0;
    reps.sort((a, b) => pop(b) - pop(a) || p.places[a]![7] - p.places[b]![7]);
    const t1 = reps[0]!;
    const t2 = reps[1]!;
    const others = (pick: number) => reps.filter((i) => i !== pick && (p.places[i]![7] <= 2 || pop(i) >= 50_000)).slice(0, 5);
    if (pop(t1) >= 100_000 && pop(t1) >= 20 * Math.max(pop(t2), 1)) return { pick: t1, ambiguous: others(t1) };
    const us = reps.filter((i) => p.places[i]![2] === 'US');
    const nonUsMax = Math.max(0, ...reps.filter((i) => p.places[i]![2] !== 'US').map(pop));
    if (us.length > 0) {
      const u1 = us[0]!;
      const restUs = us.slice(1).map(pop);
      // Another US city of 100,000 or more with the same name makes a bare name ambiguous ("Portland": OR and ME).
      if (pop(u1) >= 100_000 && restUs.every((x) => x * 20 <= pop(u1) && x < 100_000) && nonUsMax < 0.5 * pop(u1)) return { pick: u1, ambiguous: others(u1) };
    }
    // No population at all: one incorporated city among small places.
    if (reps.every((i) => pop(i) === 0)) {
      const cities = reps.filter((i) => p.places[i]![7] === 1);
      if (cities.length === 1) return { pick: cities[0]!, ambiguous: others(cities[0]!) };
    }
    return { pick: null, ambiguous: reps.filter((i) => p.places[i]![7] <= 3 || pop(i) > 0).slice(0, 6) };
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
    if (aliasId !== undefined && p.byId.has(aliasId)) {
      out.places.push(toPlace(p, p.byId.get(aliasId)!, text));
      const asRegion = regionOf(p, 'US', tokens.join(' '));
      if (asRegion && tokens.length === 1 && /^[A-Z]{2}$/.test(tokens[0]!) && asRegion !== p.places[p.byId.get(aliasId)!]![3]) out.ambiguous.push(regionPlace('US', asRegion, text));
      if (whole === 'new york') out.ambiguous.push(regionPlace('US', 'NY', text));
      if (workModel === 'remote') out.remoteRegions = [p.places[p.byId.get(aliasId)!]![2]];
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
      if (it.cc) idx = idx.filter((i) => p.places[i]![2] === it.cc);
      if (it.region) idx = idx.filter((i) => p.places[i]![3] === it.region);
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
        const bigCities = [...new Set(cityCands)].filter((i) => (p.places[i]![6] ?? 0) >= 500_000);
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
        const areas = new Set(uniq.map((i) => `${p.places[i]![2]}|${p.places[i]![3] ?? ''}`));
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
      if (workModel === 'remote') out.remoteRegions = pick !== null ? [p.places[pick]![2]] : [];
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
        if (prepared && pl.placeId && prepared.byId.has(pl.placeId)) {
          const r = prepared.places[prepared.byId.get(pl.placeId)!]!;
          return [r[4], r[5]];
        }
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
      if (!prepared || !prepared.byId.has(placeId) || !(radiusMiles >= 0)) return out;
      const c = prepared.places[prepared.byId.get(placeId)!]!;
      const dLat = radiusMiles / 69 + CELL;
      const dLon = radiusMiles / (69 * Math.max(0.05, Math.cos((c[4] * Math.PI) / 180))) + CELL;
      for (let la = Math.floor((c[4] - dLat) / CELL); la <= Math.floor((c[4] + dLat) / CELL); la++) {
        for (let lo = Math.floor((c[5] - dLon) / CELL); lo <= Math.floor((c[5] + dLon) / CELL); lo++) {
          for (const i of prepared.grid.get(`${la}:${lo}`) ?? []) {
            const r = prepared.places[i]!;
            if (milesBetween(c[4], c[5], r[4], r[5]) <= radiusMiles) out.add(r[0]);
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
