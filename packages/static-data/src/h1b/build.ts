// Builds the shipped H-1B sponsor table from official DOL LCA disclosure files (.xlsx).
//
// What counts (static-data O1): a row counts only when CASE_STATUS is exactly "Certified" and VISA_CLASS is exactly
// "H-1B". "Certified - Withdrawn", "Withdrawn", "Denied", E-3 and H-1B1 rows never count. Rows are counted per
// filer entity: the exact EMPLOYER_NAME text plus the EMPLOYER_FEIN, per source file, so a stranger can repeat any
// number by filtering the public file. Only the employer columns name the filer: a company that appears only in
// SECONDARY_ENTITY_BUSINESS_NAME (a client site of a staffing firm) is never indexed (static-data O6).

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { COMPANY_KEY_VERSION } from '../company-key.ts';
import { DOL_PERFORMANCE_PAGE, OFFICIAL_LCA_FILES, fiscalQuarterFromName, fiscalQuarterOf, fiscalQuarterRange, fiscalYearOf, type LcaFileSpec } from './lca-files.ts';
import { normalizeTitle, socMajorOf, TITLE_MIN_FILINGS, type TitleRow } from './role-family.ts';
import { excelDate, readSheetRows } from './xlsx.ts';

export const H1B_FORMAT = 'jobleft-h1b/1';
export const H1B_DATASET_ID = 'h1b-lca';

export interface H1bFileMeta {
  name: string;
  url: string | null;
  fiscalYear: number;
  quarters: number[];
  coverage: { from: string; to: string };
  bytes: number;
  sha256: string;
  official: boolean;
  rows: number;
  certifiedH1b: number;
  statusCounts: Record<string, number>;
  decisionDates: { min: string | null; max: string | null };
  rowsOutsideCoverage: number;
}

export interface H1bTableMeta {
  id: string;
  name: string;
  version: string;
  /** Grows with every release; an update with a lower or equal number is refused (a downgrade). */
  sequence: number;
  builtAt: string;
  keyVersion: number;
  dataThrough: string;
  window: { from: string; to: string };
  quarters: string[];
  fiscalYears: Array<{ year: number; from: string; to: string; partial: boolean }>;
  files: H1bFileMeta[];
  source: string;
  sourceUrl: string;
  licence: string;
  attribution: string;
  counting: string;
  /** Set on synthetic test releases only. */
  test?: boolean;
}

/**
 * One filer entity:
 * [name, fein, city, state, naics, certified, perFile[], perQuarter[], newHire, clientSite, h1bDependent, soc{}, tradeNames[], first, last]
 */
export type EntityRow = [
  name: string, fein: string | null, city: string | null, state: string | null, naics: string | null,
  certified: number, perFile: number[], perQuarter: number[], newHire: number, clientSite: number, dependent: number,
  soc: Record<string, number>, tradeNames: string[], first: string | null, last: string | null,
];

export interface H1bTable {
  format: typeof H1B_FORMAT;
  meta: H1bTableMeta;
  entities: EntityRow[];
  titles: TitleRow[];
}

interface Agg {
  name: string;
  fein: string | null;
  places: Map<string, number>;
  naics: Map<string, number>;
  certified: number;
  perFile: number[];
  perQuarter: Map<string, number>;
  newHire: number;
  clientSite: number;
  dependent: number;
  soc: Map<string, number>;
  trade: Map<string, number>;
  first: string | null;
  last: string | null;
}

function bump<K>(m: Map<K, number>, k: K, n = 1): void { m.set(k, (m.get(k) ?? 0) + n); }
function top<K>(m: Map<K, number>): K | null {
  let best: K | null = null;
  let bestN = -1;
  for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
  return best;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Digits of a FEIN as "12-3456789", or null. */
export function normalizeFein(v: string | undefined): string | null {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length !== 9 || /^0+$/.test(d)) return null;
  return `${d.slice(0, 2)}-${d.slice(2)}`;
}

function cleanText(v: string | undefined): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function num(v: string | undefined): number {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function yes(v: string | undefined): boolean {
  return /^(y|yes|true|1)$/i.test(String(v ?? '').trim());
}

const REQUIRED = ['CASE_NUMBER', 'CASE_STATUS', 'DECISION_DATE', 'VISA_CLASS', 'EMPLOYER_NAME'] as const;
const OPTIONAL = [
  'EMPLOYER_FEIN', 'TRADE_NAME_DBA', 'EMPLOYER_CITY', 'EMPLOYER_STATE', 'NAICS_CODE', 'SOC_CODE', 'JOB_TITLE',
  'NEW_EMPLOYMENT', 'CHANGE_EMPLOYER', 'NEW_CONCURRENT_EMPLOYMENT', 'SECONDARY_ENTITY', 'H_1B_DEPENDENT', 'H-1B_DEPENDENT',
] as const;

export interface BuildH1bOptions {
  files: string[];
  outDir: string;
  /** Build time (RFC 3339). Defaults to now. */
  builtAt?: string;
  /** Overrides for test releases. */
  sequence?: number;
  version?: string;
  log?: (line: string) => void;
}

export interface BuildH1bResult {
  path: string;
  bytes: number;
  sha256: string;
  meta: H1bTableMeta;
  report: Record<string, unknown>;
}

export async function buildH1bTable(opts: BuildH1bOptions): Promise<BuildH1bResult> {
  const log = opts.log ?? (() => {});
  if (opts.files.length === 0) throw new Error('give at least one LCA disclosure file (.xlsx)');
  // Files in fiscal order.
  const specs: Array<{ path: string; spec: LcaFileSpec | null; fq: { fiscalYear: number; quarters: number[] }; sha: string; bytes: number }> = [];
  for (const path of opts.files) {
    const bytes = statSync(path).size;
    log(`hashing ${basename(path)} (${(bytes / 1e6).toFixed(1)} MB)`);
    const sha = await sha256File(path);
    const spec = OFFICIAL_LCA_FILES.find((f) => f.sha256 === sha) ?? null;
    let fq: { fiscalYear: number; quarters: number[] };
    if (spec) fq = { fiscalYear: spec.fiscalYear, quarters: spec.quarters };
    else {
      const named = fiscalQuarterFromName(basename(path));
      if (!named) throw new Error(`${basename(path)}: not a known official file and its name does not say FYyyyy_Qn`);
      fq = { fiscalYear: named.fiscalYear, quarters: [named.quarter] };
      log(`warning: ${basename(path)} is not one of the official files this build knows (sha256 differs); treated as FY${named.fiscalYear} Q${named.quarter}`);
    }
    specs.push({ path, spec, fq, sha, bytes });
  }
  specs.sort((a, b) => a.fq.fiscalYear - b.fq.fiscalYear || a.fq.quarters[0]! - b.fq.quarters[0]!);

  // Quarters covered, checked for overlap (overlapping files would count a filing twice).
  const covered = new Map<string, string>();
  for (const s of specs) {
    for (const q of s.fq.quarters) {
      const k = `${s.fq.fiscalYear}Q${q}`;
      if (covered.has(k)) throw new Error(`two files cover FY${s.fq.fiscalYear} Q${q}: ${covered.get(k)} and ${basename(s.path)}`);
      covered.set(k, basename(s.path));
    }
  }

  const aggs = new Map<string, Agg>();
  const titles = new Map<string, Map<string, number>>();
  const seenCase = new Map<string, number>();
  let duplicateCases = 0;
  const files: H1bFileMeta[] = [];
  let maxDecision = '';

  for (let fi = 0; fi < specs.length; fi++) {
    const s = specs[fi]!;
    const name = s.spec?.name ?? basename(s.path);
    const qs = s.fq.quarters;
    const coverage = { from: fiscalQuarterRange(s.fq.fiscalYear, qs[0]!).from, to: fiscalQuarterRange(s.fq.fiscalYear, qs[qs.length - 1]!).to };
    const meta: H1bFileMeta = {
      name, url: s.spec?.url ?? null, fiscalYear: s.fq.fiscalYear, quarters: qs, coverage, bytes: s.bytes, sha256: s.sha,
      official: s.spec !== null, rows: 0, certifiedH1b: 0, statusCounts: {}, decisionDates: { min: null, max: null }, rowsOutsideCoverage: 0,
    };
    log(`reading ${name} (FY${s.fq.fiscalYear} Q${qs.join(',')})`);
    const t0 = Date.now();
    let col: Record<string, number> | null = null;
    for await (const r of readSheetRows(s.path)) {
      if (!col) {
        col = {};
        r.cells.forEach((h, i) => { if (h) col![h.trim().toUpperCase()] = i; });
        for (const req of REQUIRED) if (col[req] === undefined) throw new Error(`${name}: column ${req} is missing`);
        for (const o of OPTIONAL) if (col[o] === undefined && !o.includes('DEPENDENT')) log(`  note: ${name} has no ${o} column`);
        continue;
      }
      const c = r.cells;
      const caseNo = cleanText(c[col.CASE_NUMBER!]);
      if (!caseNo) continue;
      meta.rows += 1;
      const status = cleanText(c[col.CASE_STATUS!]);
      const visa = cleanText(c[col.VISA_CLASS!]);
      const sk = `${status} | ${visa}`;
      meta.statusCounts[sk] = (meta.statusCounts[sk] ?? 0) + 1;
      const decision = excelDate(c[col.DECISION_DATE!]);
      if (decision) {
        if (!meta.decisionDates.min || decision < meta.decisionDates.min) meta.decisionDates.min = decision;
        if (!meta.decisionDates.max || decision > meta.decisionDates.max) meta.decisionDates.max = decision;
        if (decision > maxDecision) maxDecision = decision;
        if (decision < coverage.from || decision > coverage.to) meta.rowsOutsideCoverage += 1;
      }
      if (status !== 'Certified' || visa !== 'H-1B') continue;
      meta.certifiedH1b += 1;

      const prev = seenCase.get(caseNo);
      if (prev !== undefined && prev !== fi) duplicateCases += 1;
      seenCase.set(caseNo, fi);

      const empName = cleanText(c[col.EMPLOYER_NAME!]);
      const fein = col.EMPLOYER_FEIN !== undefined ? normalizeFein(c[col.EMPLOYER_FEIN]) : null;
      const key = `${empName}\u0000${fein ?? ''}`;
      let a = aggs.get(key);
      if (!a) {
        a = {
          name: empName, fein, places: new Map(), naics: new Map(), certified: 0, perFile: new Array(specs.length).fill(0),
          perQuarter: new Map(), newHire: 0, clientSite: 0, dependent: 0, soc: new Map(), trade: new Map(), first: null, last: null,
        };
        aggs.set(key, a);
      }
      a.certified += 1;
      a.perFile[fi] = (a.perFile[fi] ?? 0) + 1;
      if (decision) {
        bump(a.perQuarter, `${fiscalYearOf(decision)}Q${fiscalQuarterOf(decision)}`);
        if (!a.first || decision < a.first) a.first = decision;
        if (!a.last || decision > a.last) a.last = decision;
      }
      const city = col.EMPLOYER_CITY !== undefined ? cleanText(c[col.EMPLOYER_CITY]) : '';
      const state = col.EMPLOYER_STATE !== undefined ? cleanText(c[col.EMPLOYER_STATE]).toUpperCase() : '';
      if (city || state) bump(a.places, `${city}\u0000${state}`);
      const naics = col.NAICS_CODE !== undefined ? cleanText(c[col.NAICS_CODE]).replace(/\.0+$/, '') : '';
      if (naics) bump(a.naics, naics);
      if (num(c[col.NEW_EMPLOYMENT ?? -1]) > 0 || num(c[col.CHANGE_EMPLOYER ?? -1]) > 0 || num(c[col.NEW_CONCURRENT_EMPLOYMENT ?? -1]) > 0) a.newHire += 1;
      if (col.SECONDARY_ENTITY !== undefined && yes(c[col.SECONDARY_ENTITY])) a.clientSite += 1;
      const depCol = col.H_1B_DEPENDENT ?? col['H-1B_DEPENDENT'];
      if (depCol !== undefined && yes(c[depCol])) a.dependent += 1;
      const major = col.SOC_CODE !== undefined ? socMajorOf(c[col.SOC_CODE]) : null;
      if (major) bump(a.soc, major);
      const dba = col.TRADE_NAME_DBA !== undefined ? cleanText(c[col.TRADE_NAME_DBA]) : '';
      if (dba) bump(a.trade, dba);
      if (major && col.JOB_TITLE !== undefined) {
        const t = normalizeTitle(c[col.JOB_TITLE] ?? '');
        if (t) {
          let m = titles.get(t);
          if (!m) { m = new Map(); titles.set(t, m); }
          bump(m, major);
        }
      }
    }
    log(`  ${meta.rows} rows, ${meta.certifiedH1b} certified H-1B, decisions ${meta.decisionDates.min} to ${meta.decisionDates.max}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    files.push(meta);
  }

  // Fiscal quarters and years in order.
  const quarters: string[] = [];
  for (const s of specs) for (const q of s.fq.quarters) quarters.push(`${s.fq.fiscalYear}Q${q}`);
  const qIndex = new Map(quarters.map((q, i) => [q, i]));
  const windowFrom = files[0]!.coverage.from;
  const dataThrough = maxDecision || files[files.length - 1]!.coverage.to;
  const years = [...new Set(specs.map((s) => s.fq.fiscalYear))].sort();
  const fiscalYears = years.map((y) => {
    const qs = quarters.filter((q) => q.startsWith(`${y}Q`)).map((q) => Number(q.slice(-1)));
    const full = [1, 2, 3, 4].every((q) => qs.includes(q));
    const from = fiscalQuarterRange(y, Math.min(...qs)).from;
    const end = fiscalQuarterRange(y, Math.max(...qs)).to;
    const to = end < dataThrough ? end : dataThrough;
    return { year: y, from, to, partial: !full || to < fiscalQuarterRange(y, 4).to };
  });

  const entities: EntityRow[] = [];
  let outsideQuarter = 0;
  for (const a of aggs.values()) {
    const place = top(a.places);
    const [city, state] = place ? place.split('\u0000') : ['', ''];
    const perQuarter = new Array(quarters.length).fill(0);
    for (const [q, n] of a.perQuarter) {
      const i = qIndex.get(q);
      if (i === undefined) outsideQuarter += n; else perQuarter[i] += n;
    }
    const trade = [...a.trade.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([t]) => t);
    entities.push([
      a.name, a.fein, city || null, state || null, top(a.naics), a.certified, a.perFile, perQuarter,
      a.newHire, a.clientSite, a.dependent, Object.fromEntries([...a.soc.entries()].sort((x, y) => y[1] - x[1])), trade, a.first, a.last,
    ]);
  }
  entities.sort((x, y) => y[5] - x[5] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

  const titleRows: TitleRow[] = [];
  for (const [t, m] of titles) {
    let total = 0;
    for (const n of m.values()) total += n;
    if (total < TITLE_MIN_FILINGS) continue;
    const major = top(m)!;
    titleRows.push([t, major, Math.round((m.get(major)! / total) * 1000) / 1000, total]);
  }
  titleRows.sort((a, b) => b[3] - a[3]);

  const last = specs[specs.length - 1]!;
  const lastQ = last.fq.quarters[last.fq.quarters.length - 1]!;
  const fileList = files.map((f) => `FY${f.fiscalYear} ${f.quarters.length === 1 ? `Q${f.quarters[0]}` : `Q${f.quarters[0]}-Q${f.quarters[f.quarters.length - 1]}`}`).join(', ');
  const meta: H1bTableMeta = {
    id: H1B_DATASET_ID,
    name: 'H-1B employer filings (US Department of Labor LCA disclosure data)',
    version: opts.version ?? `FY${last.fq.fiscalYear}Q${lastQ}`,
    sequence: opts.sequence ?? last.fq.fiscalYear * 100 + lastQ * 10,
    builtAt: opts.builtAt ?? new Date().toISOString(),
    keyVersion: COMPANY_KEY_VERSION,
    dataThrough,
    window: { from: windowFrom, to: dataThrough },
    quarters,
    fiscalYears,
    files,
    source: `US Department of Labor, Office of Foreign Labor Certification, LCA disclosure data (${fileList})`,
    sourceUrl: DOL_PERFORMANCE_PAGE,
    licence: 'US government work: public domain in the United States (17 U.S.C. 105). No licence terms are stated by the source.',
    attribution: 'Source: US Department of Labor, Employment and Training Administration, Office of Foreign Labor Certification, LCA Programs (H-1B, H-1B1, E-3) disclosure data. jobleft counts certified H-1B rows only; DOL does not endorse jobleft.',
    counting: 'Rows with CASE_STATUS = "Certified" and VISA_CLASS = "H-1B", counted per exact EMPLOYER_NAME and EMPLOYER_FEIN, per file. Withdrawn, denied and certified-withdrawn rows, E-3 and H-1B1 rows never count. Client-site names (SECONDARY_ENTITY_BUSINESS_NAME) are never indexed.',
  };
  const table: H1bTable = { format: H1B_FORMAT, meta, entities, titles: titleRows };
  mkdirSync(opts.outDir, { recursive: true });
  const outPath = join(opts.outDir, `${H1B_DATASET_ID}.json.gz`);
  const gz = gzipSync(Buffer.from(JSON.stringify(table)), { level: 9 });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, gz);
  renameSync(tmp, outPath);
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const report = {
    files: files.map((f) => ({ name: f.name, rows: f.rows, certifiedH1b: f.certifiedH1b, decisionDates: f.decisionDates, rowsOutsideCoverage: f.rowsOutsideCoverage, statusCounts: f.statusCounts })),
    entities: entities.length,
    certifiedH1bTotal: entities.reduce((s, e) => s + e[5], 0),
    uniqueCertifiedCases: seenCase.size,
    caseNumbersInTwoFiles: duplicateCases,
    rowsWithDecisionOutsideTheQuarters: outsideQuarter,
    titles: titleRows.length,
    output: { path: outPath, bytes: gz.length, sha256 },
  };
  return { path: outPath, bytes: gz.length, sha256, meta, report };
}
