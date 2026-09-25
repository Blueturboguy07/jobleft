// The H-1B sponsor lookup over the shipped table (static-data O1 to O8).
//
// Matching, in order, and nothing else (no similarity score, no prefix, no dropped ordinary words):
//   1. a reviewed alias entry for the name's companyKey -> exactly the entry's filers;
//   2. filers whose legal EMPLOYER_NAME has the same companyKey;
//   3. filers whose trade name (TRADE_NAME_DBA or a "d/b/a" part of EMPLOYER_NAME) has the same companyKey.
// Within one key, filings of a different FEIN in a different state are a different company and are left out
// (for example "DATA BRICKS INC" of Columbia, MD is not Databricks). When no FEIN clearly dominates, the answer is
// "unknown". A name that is not found is "unknown", never "no".

import { gunzipSync } from 'node:zlib';
import type { DatasetInfo, H1bLookup, H1bSummary } from '@jobleft/contracts';
import { LEGAL_SUFFIXES, companyKey, isJunkTradeName, nameTokens, splitDba } from '../company-key.ts';
import { loadAliasIndex, type AliasIndex } from '../aliases.ts';
import { activeStamp, loadDataset, writeStateFor, type DatasetRecord, type StaticDataOptions } from '../datasets/store.ts';
import { H1B_DATASET_ID, H1B_FORMAT, type EntityRow, type H1bTable, type H1bTableMeta } from './build.ts';
import { roleFamilyOf, type TitleRow } from './role-family.ts';

/** "likely" needs at least this many certified filings in the window... */
export const LIKELY_MIN_FILINGS = 10;
/** ...at least this many in the newest 12 months of the data... */
export const LIKELY_MIN_RECENT = 3;
/** ...and at least one filing for a new hire or a transfer from another employer (not only extensions). */
export const LIKELY_MIN_NEW_HIRE = 1;
/** An excluded same-name company this large (relative to the kept one) makes the name ambiguous. */
const AMBIGUOUS_SHARE = 1 / 3;

const PLACEHOLDER_FEINS = new Set(['12-3456789', '98-7654321', '01-2345678', '12-1234567', '11-1111111', '99-9999999', '00-0000000', '22-2222222', '33-3333333', '44-4444444', '55-5555555', '66-6666666', '77-7777777', '88-8888888']);

export interface H1bEntityDetail {
  name: string;
  fein: string | null;
  city: string | null;
  state: string | null;
  certifiedFilings: number;
  byFile: Array<{ file: string; count: number }>;
}

/** The contract summary plus the details a person (or an evaluator) needs to check the numbers. */
export interface H1bSummaryDetail extends H1bSummary {
  /** Short tag text: "H-1B sponsor likely" or "Some H-1B history". Never a promise. */
  label: string;
  matchedBy: 'alias' | 'name' | 'trade_name';
  aliasBasis: string | null;
  /** Certified filings decided in the newest 12 months of the data. */
  recentFilings: number;
  recentWindow: { from: string; to: string };
  /** Filings for a new hire, a concurrent job or a transfer from another employer. */
  newHireFilings: number;
  /** Share of filings that place the worker at another company's site (staffing and consulting). */
  clientSiteShare: number;
  entities: H1bEntityDetail[];
  /** Same-name filers left out because they are a different company (different FEIN and state). */
  excludedEntities: Array<H1bEntityDetail & { reason: string }>;
  files: Array<{ name: string; url: string | null; coverage: { from: string; to: string }; certifiedFilings: number }>;
  sourceUrl: string;
  counting: string;
  statusRule: string;
}

export interface H1bLookupDetail extends H1bLookup {
  summary: H1bSummaryDetail | null;
  /** Why the answer is unknown (never a "no"). */
  reason: string | null;
  dataThrough: string | null;
}

export interface H1bIndex {
  /** found with a summary, or unknown. Never a "no" (static-data O2). */
  lookup(companyName: string, opts?: { jobTitle?: string }): H1bLookupDetail;
  dataset(): DatasetInfo;
}

interface Prepared {
  meta: H1bTableMeta;
  entities: EntityRow[];
  legal: Map<string, number[]>;
  trade: Map<string, number[]>;
  titles: Map<string, TitleRow>;
  record: DatasetRecord;
  origin: 'bundled' | 'installed';
  recentQuarterIdx: number[];
  recentWindow: { from: string; to: string };
  fyQuarters: Map<number, number[]>;
}

function push(m: Map<string, number[]>, k: string, i: number): void {
  const a = m.get(k);
  if (a) { if (a[a.length - 1] !== i) a.push(i); } else m.set(k, [i]);
}

export function parseH1bTable(bytes: Buffer): H1bTable {
  const t = JSON.parse(gunzipSync(bytes).toString('utf8')) as H1bTable;
  if (t.format !== H1B_FORMAT || !t.meta || !Array.isArray(t.entities)) throw new Error('not a jobleft H-1B table');
  if (t.meta.id !== H1B_DATASET_ID) throw new Error(`the table is "${t.meta.id}", not ${H1B_DATASET_ID}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.meta.dataThrough)) throw new Error('the table has no data date');
  return t;
}

function quarterEnd(q: string): string {
  const fy = Number(q.slice(0, 4));
  const n = Number(q.slice(-1));
  const endMonth = [12, 3, 6, 9][n - 1]!;
  const year = n === 1 ? fy - 1 : fy;
  const last = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return `${year}-${String(endMonth).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function prepare(t: H1bTable, record: DatasetRecord, origin: 'bundled' | 'installed'): Prepared {
  const legal = new Map<string, number[]>();
  const trade = new Map<string, number[]>();
  t.entities.forEach((e, i) => {
    const { legal: l, others } = splitDba(e[0]);
    const lk = companyKey(l);
    if (lk) push(legal, lk, i);
    for (const tn of [...others, ...e[12]]) {
      if (isJunkTradeName(tn)) continue;
      const tk = companyKey(tn);
      if (tk && tk !== lk) push(trade, tk, i);
    }
  });
  const titles = new Map<string, TitleRow>(t.titles.map((r) => [r[0], r]));
  // The newest 12 months: quarters that end after dataThrough minus one year.
  const through = t.meta.dataThrough;
  const yearBefore = `${Number(through.slice(0, 4)) - 1}${through.slice(4)}`;
  const recentQuarterIdx: number[] = [];
  t.meta.quarters.forEach((q, i) => { if (quarterEnd(q) > yearBefore) recentQuarterIdx.push(i); });
  const firstRecent = t.meta.quarters[recentQuarterIdx[0] ?? 0] ?? t.meta.quarters[0]!;
  const fromDate = (() => {
    const fy = Number(firstRecent.slice(0, 4));
    const n = Number(firstRecent.slice(-1));
    const m = [10, 1, 4, 7][n - 1]!;
    return `${n === 1 ? fy - 1 : fy}-${String(m).padStart(2, '0')}-01`;
  })();
  const fyQuarters = new Map<number, number[]>();
  t.meta.quarters.forEach((q, i) => {
    const fy = Number(q.slice(0, 4));
    const a = fyQuarters.get(fy) ?? [];
    a.push(i);
    fyQuarters.set(fy, a);
  });
  return { meta: t.meta, entities: t.entities, legal, trade, titles, record, origin, recentQuarterIdx, recentWindow: { from: fromDate, to: through }, fyQuarters };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

function isPlaceholder(fein: string | null): boolean {
  return !fein || PLACEHOLDER_FEINS.has(fein);
}

interface Resolved { kept: number[]; excluded: number[]; ambiguous: boolean }

/** Applies the one-company rule inside one key: keep the dominant FEIN and same-state filers, drop the rest. */
function resolveKey(p: Prepared, idx: number[] | undefined): Resolved {
  if (!idx || idx.length === 0) return { kept: [], excluded: [], ambiguous: false };
  const byFein = new Map<string, number[]>();
  for (const i of idx) {
    const f = p.entities[i]![1];
    const k = isPlaceholder(f) ? '?' : f!;
    const a = byFein.get(k) ?? [];
    a.push(i);
    byFein.set(k, a);
  }
  const total = (is: number[]) => is.reduce((s, i) => s + p.entities[i]![5], 0);
  let dom: string | null = null;
  let domN = -1;
  for (const [f, is] of byFein) {
    if (f === '?') continue;
    const n = total(is);
    if (n > domN) { dom = f; domN = n; }
  }
  if (dom === null) return { kept: [...idx], excluded: [], ambiguous: false };
  const domStates = new Set(byFein.get(dom)!.map((i) => p.entities[i]![3]).filter((s): s is string => !!s));
  const kept: number[] = [...byFein.get(dom)!];
  const excluded: number[] = [];
  for (const [f, is] of byFein) {
    if (f === dom) continue;
    for (const i of is) {
      const st = p.entities[i]![3];
      if (st && domStates.has(st)) kept.push(i); else excluded.push(i);
    }
  }
  // Excluded filers of one other FEIN that are a sizeable share make the name ambiguous.
  const exclByFein = new Map<string, number>();
  for (const i of excluded) {
    const f = p.entities[i]![1] ?? '?';
    exclByFein.set(f, (exclByFein.get(f) ?? 0) + p.entities[i]![5]);
  }
  const keptN = total(kept);
  let ambiguous = false;
  for (const n of exclByFein.values()) if (n >= 3 && n >= keptN * AMBIGUOUS_SHARE) ambiguous = true;
  return { kept, excluded, ambiguous };
}

function entityDetail(p: Prepared, i: number): H1bEntityDetail {
  const e = p.entities[i]!;
  return {
    name: e[0], fein: e[1], city: e[2], state: e[3], certifiedFilings: e[5],
    byFile: p.meta.files.map((f, fi) => ({ file: f.name, count: e[6][fi] ?? 0 })).filter((x) => x.count > 0),
  };
}

function datasetInfoFor(p: Prepared | null, rec: DatasetRecord | null, error: string | null): DatasetInfo {
  if (!p || !rec) {
    return {
      id: H1B_DATASET_ID, name: 'H-1B employer filings (US Department of Labor LCA disclosure data)', version: 'none',
      dataThrough: null, licence: 'US government work (public domain in the US)', attribution: null,
      sourceUrl: 'https://www.dol.gov/agencies/eta/foreign-labor/performance', bytes: 0,
      updatedAt: new Date(0).toISOString(), lastUpdateError: error ?? 'The sponsor data is missing. Every company shows as unknown until it is restored.',
    };
  }
  return {
    id: rec.id, name: p.meta.test ? `${p.meta.name} (TEST RELEASE: synthetic data)` : p.meta.name, version: rec.version,
    dataThrough: p.meta.dataThrough, licence: rec.licence, attribution: rec.attribution, sourceUrl: rec.sourceUrl,
    bytes: rec.bytes, updatedAt: rec.installedAt ?? rec.builtAt, lastUpdateError: error,
  };
}

const STATUS_RULE = `"likely" needs at least ${LIKELY_MIN_FILINGS} certified filings in the window, at least ${LIKELY_MIN_RECENT} of them in the newest 12 months of the data, and at least ${LIKELY_MIN_NEW_HIRE} filing for a new hire or a transfer. Anything less is "some history".`;

export function summarize(p: Prepared, kept: number[], excluded: number[], matchedBy: H1bSummaryDetail['matchedBy'], aliasBasis: string | null, jobTitle: string | undefined): H1bSummaryDetail {
  const uniq = [...new Set(kept)];
  const quarters = new Array(p.meta.quarters.length).fill(0) as number[];
  const perFile = new Array(p.meta.files.length).fill(0) as number[];
  const soc = new Map<string, number>();
  let certified = 0;
  let newHire = 0;
  let clientSite = 0;
  for (const i of uniq) {
    const e = p.entities[i]!;
    certified += e[5];
    e[7].forEach((n, qi) => { quarters[qi] = (quarters[qi] ?? 0) + n; });
    e[6].forEach((n, fi) => { perFile[fi] = (perFile[fi] ?? 0) + n; });
    newHire += e[8];
    clientSite += e[9];
    for (const [k, n] of Object.entries(e[11])) soc.set(k, (soc.get(k) ?? 0) + n);
  }
  const recent = p.recentQuarterIdx.reduce((s, qi) => s + (quarters[qi] ?? 0), 0);
  const byYear = p.meta.fiscalYears.map((fy) => ({
    year: fy.year,
    count: (p.fyQuarters.get(fy.year) ?? []).reduce((s, qi) => s + (quarters[qi] ?? 0), 0),
    partial: fy.partial,
    yearKind: 'fiscal' as const,
  }));
  const likely = certified >= LIKELY_MIN_FILINGS && recent >= LIKELY_MIN_RECENT && newHire >= LIKELY_MIN_NEW_HIRE;
  const entities = uniq.map((i) => entityDetail(p, i)).sort((a, b) => b.certifiedFilings - a.certifiedFilings);
  const names = [...new Set(entities.map((e) => e.name))];
  const who = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  const from = humanDate(p.meta.window.from);
  const to = humanDate(p.meta.window.to);
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  const note = likely
    ? `Based on ${plural(certified, 'certified H-1B filing')} (Labor Condition Applications) by ${who} from ${from} to ${to}, ${recent.toLocaleString('en-US')} of them in the newest 12 months. Past filings do not guarantee that this employer will sponsor a visa for this role.`
    : `${plural(certified, 'certified H-1B filing')} by ${who} from ${from} to ${to} (${recent.toLocaleString('en-US')} in the newest 12 months). A short or old filing history does not show that this employer sponsors often, and past filings do not guarantee sponsorship for this role.`;
  let similarRoleShare: number | null = null;
  let roleFamily: string | null = null;
  if (jobTitle && certified > 0) {
    const fam = roleFamilyOf(jobTitle, p.titles);
    if (fam) {
      roleFamily = fam.label;
      similarRoleShare = Math.round(((soc.get(fam.major) ?? 0) / certified) * 1000) / 1000;
    }
  }
  return {
    status: likely ? 'likely' : 'some_history',
    label: likely ? 'H-1B sponsor likely' : 'Some H-1B history',
    certifiedFilings: certified,
    window: { ...p.meta.window },
    byYear,
    similarRoleShare,
    roleFamily,
    filerEntities: names,
    dataThrough: p.meta.dataThrough,
    source: p.meta.test && !p.meta.source.startsWith('TEST RELEASE') ? `TEST RELEASE (synthetic data): ${p.meta.source}` : p.meta.source,
    note,
    matchedBy,
    aliasBasis,
    recentFilings: recent,
    recentWindow: { ...p.recentWindow },
    newHireFilings: newHire,
    clientSiteShare: certified > 0 ? Math.round((clientSite / certified) * 1000) / 1000 : 0,
    entities,
    excludedEntities: [...new Set(excluded)].filter((i) => !uniq.includes(i)).map((i) => ({ ...entityDetail(p, i), reason: 'Same name, but a different FEIN in a different state: a different company.' })),
    files: p.meta.files.map((f, fi) => ({ name: f.name, url: f.url, coverage: f.coverage, certifiedFilings: perFile[fi] ?? 0 })),
    sourceUrl: p.meta.sourceUrl,
    counting: p.meta.counting,
    statusRule: STATUS_RULE,
  };
}

/** Loads the sponsor index. It works offline, and it reloads when a newer release is installed. */
export function loadH1bIndex(opts: StaticDataOptions & { aliases?: AliasIndex }): H1bIndex {
  let stamp = '';
  let prepared: Prepared | null = null;
  let error: string | null = null;
  let checkedAt = 0;
  const aliases = opts.aliases ?? loadAliasIndex();

  const refresh = () => {
    const now = Date.now();
    if (prepared && now - checkedAt < 1000) return;
    checkedAt = now;
    const s = activeStamp(opts);
    if (s === stamp && (prepared || error)) return;
    stamp = s;
    let table: H1bTable | null = null;
    const loaded = loadDataset(opts, H1B_DATASET_ID, (bytes, rec) => {
      const t = parseH1bTable(bytes);
      if (t.meta.version !== rec.version || t.meta.sequence !== rec.sequence) throw new Error('the table does not match its release record');
      table = t;
    });
    if (loaded && table) {
      prepared = prepare(table, loaded.record, loaded.origin);
      error = loaded.warning;
      if (loaded.warning) writeStateFor(opts, H1B_DATASET_ID, { lastError: loaded.warning, lastErrorAt: new Date().toISOString() });
    } else {
      prepared = null;
      error = loaded?.warning ?? 'The sponsor data is missing or damaged. Every company shows as unknown until it is restored.';
    }
  };

  const unknown = (input: string, key: string | null, reason: string): H1bLookupDetail => ({
    input, companyKey: key, status: 'unknown', summary: null, reason, dataThrough: prepared?.meta.dataThrough ?? null,
  });

  return {
    lookup(companyName: string, lookupOpts: { jobTitle?: string } = {}): H1bLookupDetail {
      refresh();
      const input = String(companyName ?? '');
      const key = companyKey(input);
      if (!prepared) return unknown(input, key || null, error ?? 'The sponsor data is not available.');
      const window = `${humanDate(prepared.meta.window.from)} to ${humanDate(prepared.meta.window.to)}`;
      if (key.length < 2) return unknown(input, key || null, 'The name is too short to match safely. Sponsorship is unknown.');
      if (nameTokens(input).every((t) => LEGAL_SUFFIXES.has(t) || t === 'the')) return unknown(input, key, 'The text is only a legal form (such as "Inc."), not a company name. Sponsorship is unknown.');
      const entry = aliases.entryForKey(key);
      let kept: number[] = [];
      let excluded: number[] = [];
      let ambiguous = false;
      let matchedBy: H1bSummaryDetail['matchedBy'] = 'name';
      if (entry) {
        matchedBy = 'alias';
        for (const fk of entry.filerKeys) {
          const r = resolveKey(prepared, prepared.legal.get(fk));
          kept.push(...r.kept);
          excluded.push(...r.excluded);
        }
      } else {
        const r = resolveKey(prepared, prepared.legal.get(key));
        if (r.kept.length > 0) ({ kept, excluded, ambiguous } = r);
        else {
          const t = resolveKey(prepared, prepared.trade.get(key));
          ({ kept, excluded, ambiguous } = t);
          matchedBy = 'trade_name';
        }
      }
      if (ambiguous) {
        return unknown(input, key, `Several different employers file under this name, and jobleft cannot tell which one this is. Sponsorship is unknown, not ruled out.`);
      }
      if (kept.length === 0) {
        return unknown(input, key, `Not found as an employer in the H-1B filing data for ${window}. Sponsorship is unknown, not ruled out.`);
      }
      const summary = summarize(prepared, kept, excluded, matchedBy, entry?.basis ?? null, lookupOpts.jobTitle);
      return { input, companyKey: key, status: 'found', summary, reason: null, dataThrough: prepared.meta.dataThrough };
    },
    dataset(): DatasetInfo {
      refresh();
      return datasetInfoFor(prepared, prepared?.record ?? null, error);
    },
  };
}
