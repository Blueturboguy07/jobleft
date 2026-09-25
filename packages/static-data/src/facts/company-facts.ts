// Company facts, kept per company key (static-data O10, O11, O12).
//
//   * get(key) never sends a request. It returns the kept facts, or a company with no facts.
//   * refresh(key) reads the free sources only when the kept facts are missing or past their freshness period
//     (30 days by default), or when `force` is set; several refreshes of one company at once share one set of requests.
//   * A refresh that fails keeps the old facts and records the error.
//   * A paid lookup runs only with allowPaid, only when a paid client is configured, and only within the price cap;
//     its cost is recorded and shown in dollars ("balance", never "credits").
//   * Every fact names its source, a link that states it, and when jobleft read it. No fact is ever guessed.

import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDollars, nowMs, type Company, type H1bSummary } from '@jobleft/contracts';
import { companyKey, splitDba } from '../company-key.ts';
import type { AliasIndex, CompanyAliases } from '../aliases.ts';
import type { H1bIndex, H1bSummaryDetail } from '../h1b/index.ts';
import { DATA_DIR } from '../paths.ts';
import {
  gleifByLeiUrl, gleifByNameUrl, gleifFacts, labelOf, parseGleif, parseWikidataEntity, pickGleif, secFacts, secIdentityProblem,
  secSubmissionsUrl, wikidataEntityUrl, wikidataFacts, wikidataIdentityProblem, type FactValue, type FreeFacts, type Identity,
  type SecSubmissions, type SourceRef,
} from './sources.ts';
import { checkProposed, ruleEnricher, type PaidEnricher, type ProposedFact } from './enrich.ts';

export const FACTS_OWNER = 'static-data';
export const FACTS_SCHEMA_VERSION = 1;
export const DEFAULT_FRESH_MS = 30 * 24 * 3600 * 1000;
const RETRY_AFTER_FAILURE_MS = 3600 * 1000;

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
  /** Reads paid search results into proposed facts (default: a small rule-based reader). Every fact is checked. */
  enricher?: PaidEnricher;
  /** Reviewed Wikidata ids (default: data/company-identifiers.json). */
  identifiers?: Record<string, { wikidata?: string }>;
}

export type FactField = keyof Company['facts'];

export interface SourceStatus { name: string; status: 'used' | 'no_facts' | 'not_same_company' | 'not_found' | 'failed' | 'skipped'; note: string }

/** The contract Company plus what the person needs to judge the facts. */
export interface CompanyDetail extends Company {
  factsStatus: { fetchedAt: string | null; lastAttemptAt: string | null; lastError: string | null; sources: SourceStatus[] };
  paidLookup: { lastCostMicros: number; lastCostText: string; at: string; totalMicros: number; note: string | null; ran?: boolean } | null;
}

interface Row {
  key: string; name: string; facts: string; status: string | null; fetched_at: string | null; fresh_until: string | null;
  last_attempt_at: string | null; last_error: string | null; retry_after: string | null; paid: string | null; updated_at: string;
}

const NAICS_SECTORS: Readonly<Record<string, string>> = {
  '11': 'Agriculture, Forestry, Fishing and Hunting', '21': 'Mining, Quarrying, and Oil and Gas Extraction', '22': 'Utilities',
  '23': 'Construction', '31': 'Manufacturing', '32': 'Manufacturing', '33': 'Manufacturing', '42': 'Wholesale Trade',
  '44': 'Retail Trade', '45': 'Retail Trade', '48': 'Transportation and Warehousing', '49': 'Transportation and Warehousing',
  '51': 'Information', '52': 'Finance and Insurance', '53': 'Real Estate and Rental and Leasing',
  '54': 'Professional, Scientific, and Technical Services', '55': 'Management of Companies and Enterprises',
  '56': 'Administrative and Support and Waste Management and Remediation Services', '61': 'Educational Services',
  '62': 'Health Care and Social Assistance', '71': 'Arts, Entertainment, and Recreation', '72': 'Accommodation and Food Services',
  '81': 'Other Services (except Public Administration)', '92': 'Public Administration',
};

export function migrateCompanyFacts(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE owner = ?').get(FACTS_OWNER) as { v: number | null } | undefined;
  const have = row?.v ?? 0;
  if (have > FACTS_SCHEMA_VERSION) throw new Error(`The company-facts tables are from a newer jobleft (version ${have}); this build knows version ${FACTS_SCHEMA_VERSION}. Nothing was changed.`);
  if (have < 1) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS company_facts (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        facts TEXT NOT NULL DEFAULT '{}',
        status TEXT,
        fetched_at TEXT,
        fresh_until TEXT,
        last_attempt_at TEXT,
        last_error TEXT,
        retry_after TEXT,
        paid TEXT,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS company_fact_labels (
        qid TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      )`);
      db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)').run(FACTS_OWNER, 1, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function loadIdentifiers(): Record<string, { wikidata?: string }> {
  try {
    return (JSON.parse(readFileSync(join(DATA_DIR, 'company-identifiers.json'), 'utf8')) as { companies: Record<string, { wikidata?: string }> }).companies;
  } catch {
    return {};
  }
}

function titleCase(s: string): string { return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()); }

export class CompanyFacts {
  readonly #db: DatabaseSync;
  readonly #h1b: H1bIndex;
  readonly #aliases: CompanyAliases;
  readonly #fetchText: (url: string) => Promise<string>;
  readonly #paid: PaidSearch | null;
  readonly #now: () => number;
  readonly #freshMs: number;
  readonly #enricher: PaidEnricher;
  readonly #ids: Record<string, { wikidata?: string }>;
  readonly #names = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<CompanyDetail>>();

  constructor(opts: CompanyFactsOptions) {
    this.#db = opts.db;
    this.#h1b = opts.h1b;
    this.#aliases = opts.aliases;
    this.#fetchText = opts.fetchText;
    this.#paid = opts.paid;
    this.#now = opts.now ?? (() => nowMs());
    this.#freshMs = opts.freshForMs ?? DEFAULT_FRESH_MS;
    this.#enricher = opts.enricher ?? ruleEnricher;
    this.#ids = opts.identifiers ?? loadIdentifiers();
    migrateCompanyFacts(this.#db);
  }

  /** One key per company: names of one reviewed alias entry share their kept facts. */
  #canon(key: string): string {
    const a = this.#aliases as Partial<AliasIndex>;
    return a.canonicalKey ? a.canonicalKey(key) : key;
  }

  /** Tells the service how a company is written (for example the job's company name). Returns its key. */
  note(name: string): string {
    const key = this.#canon(companyKey(name));
    if (key && !this.#names.has(key)) this.#names.set(key, name.trim());
    return key;
  }

  #row(key: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM company_facts WHERE key = ?').get(key) as Row | undefined;
  }

  #iso(ms?: number): string { return new Date(ms ?? this.#now()).toISOString(); }

  #nameFor(key: string, row?: Row): string {
    const alias = (this.#aliases as Partial<AliasIndex>).entryForKey?.(key);
    if (alias) return alias.names[0]!;
    if (this.#names.has(key)) return this.#names.get(key)!;
    if (row?.name) return row.name;
    const h = this.#h1b.lookup(key);
    if (h.summary) return splitDba(h.summary.filerEntities[0]!).legal;
    return key;
  }

  #h1bFor(name: string): H1bSummaryDetail | null {
    return (this.#h1b.lookup(name).summary as H1bSummaryDetail | null) ?? null;
  }

  /** The kept company, or a company with no facts (never invented ones). Sends no request. */
  get(key: string): CompanyDetail {
    const k = this.#canon(companyKey(key) || key);
    const row = this.#row(k);
    const name = this.#nameFor(k, row);
    const h1b = this.#h1bFor(name);
    const facts = row ? (JSON.parse(row.facts) as Company['facts']) : {};
    const status = row?.status ? (JSON.parse(row.status) as SourceStatus[]) : [];
    const paid = row?.paid ? (JSON.parse(row.paid) as CompanyDetail['paidLookup']) : null;
    const aliasNames = new Set<string>();
    const entry = (this.#aliases as Partial<AliasIndex>).entryForKey?.(k);
    if (entry) for (const n of entry.names) if (n !== name) aliasNames.add(n);
    if (h1b) for (const n of h1b.filerEntities) if (n !== name) aliasNames.add(n);
    const staffing = h1b && h1b.certifiedFilings >= 20 && h1b.clientSiteShare >= 0.5 ? true : null;
    return {
      key: k,
      name,
      aliases: [...aliasNames].slice(0, 12),
      facts,
      h1b: h1b as H1bSummary | null,
      isStaffingAgency: staffing,
      factsFreshUntil: row?.fresh_until ?? null,
      updatedAt: row?.updated_at ?? this.#iso(),
      factsStatus: { fetchedAt: row?.fetched_at ?? null, lastAttemptAt: row?.last_attempt_at ?? null, lastError: row?.last_error ?? null, sources: status },
      paidLookup: paid,
    };
  }

  /** Marks every kept fact expired (the documented option to expire kept facts). Returns how many companies. */
  expireAll(): number {
    const past = this.#iso(this.#now() - 1000);
    const r = this.#db.prepare('UPDATE company_facts SET fresh_until = ?, retry_after = NULL WHERE fresh_until IS NULL OR fresh_until > ?').run(past, past);
    return Number(r.changes);
  }

  /** Reads facts again when they are missing or expired (or with force). A failed refresh keeps the old facts. */
  refresh(key: string, opts: { allowPaid: boolean; maxPriceMicros?: number; force?: boolean; name?: string }): Promise<CompanyDetail> {
    const k = this.#canon(companyKey(opts.name ?? key) || companyKey(key) || key);
    if (opts.name) this.note(opts.name);
    const running = this.#inflight.get(k);
    if (running) return running;
    const p = this.#refresh(k, opts).finally(() => this.#inflight.delete(k));
    this.#inflight.set(k, p);
    return p;
  }

  async #refresh(key: string, opts: { allowPaid: boolean; maxPriceMicros?: number; force?: boolean }): Promise<CompanyDetail> {
    const now = this.#now();
    const row = this.#row(key);
    const fresh = row?.fresh_until ? Date.parse(row.fresh_until) > now : false;
    const waiting = row?.retry_after ? Date.parse(row.retry_after) > now : false;
    const needFree = opts.force || (!fresh && !waiting);
    const prevPaid = row?.paid ? (JSON.parse(row.paid) as { at?: string; ran?: boolean }) : null;
    const paidAlready = prevPaid?.ran ? prevPaid.at ?? null : null;
    const needPaid = opts.allowPaid && this.#paid !== null && (opts.force || !paidAlready || !fresh);
    if (!needFree && !needPaid) return this.get(key);
    const name = this.#nameFor(key, row);
    if (needFree) await this.#refreshFree(key, name, row);
    if (needPaid) await this.#refreshPaid(key, name, opts.maxPriceMicros);
    return this.get(key);
  }

  #identity(key: string, name: string, h1b: H1bSummaryDetail | null): Identity {
    const keys = new Set<string>([key, ...this.#aliases.keysFor(name)]);
    const feins = new Set<string>();
    const legalNames: string[] = [];
    let state: string | null = null;
    if (h1b) {
      for (const e of h1b.entities) {
        keys.add(companyKey(splitDba(e.name).legal));
        if (e.fein && !['12-3456789', '98-7654321'].includes(e.fein)) feins.add(e.fein);
        const legal = splitDba(e.name).legal;
        if (!legalNames.some((n) => companyKey(n) === companyKey(legal))) legalNames.push(legal);
      }
      state = h1b.entities[0]?.state ?? null;
    }
    return { keys, feins, legalNames, state };
  }

  async #label(qid: string): Promise<string | null> {
    const hit = this.#db.prepare('SELECT label FROM company_fact_labels WHERE qid = ?').get(qid) as { label: string } | undefined;
    if (hit) return hit.label;
    const label = labelOf(await this.#fetchText(wikidataEntityUrl(qid)), qid);
    if (label) this.#db.prepare('INSERT OR REPLACE INTO company_fact_labels (qid, label, fetched_at) VALUES (?, ?, ?)').run(qid, label, this.#iso());
    return label;
  }

  async #refreshFree(key: string, name: string, row: Row | undefined): Promise<void> {
    const at = this.#iso();
    const h1b = this.#h1bFor(name);
    const id = this.#identity(key, name, h1b);
    const statuses: SourceStatus[] = [];
    const found: { wikidata: FreeFacts; sec: FreeFacts; gleif: FreeFacts; dol: FreeFacts } = { wikidata: {}, sec: {}, gleif: {}, dol: {} };
    let attempted = 0;
    let failed = 0;
    const errors: string[] = [];
    const tryStep = async (label: string, fn: () => Promise<SourceStatus>) => {
      attempted += 1;
      try {
        statuses.push(await fn());
      } catch (err) {
        failed += 1;
        const msg = (err as Error).message;
        errors.push(`${label}: ${msg}`);
        statuses.push({ name: label, status: 'failed', note: msg });
      }
    };

    // 1. Wikidata, by a reviewed item id only (its search API is closed to automated clients).
    const entry = (this.#aliases as Partial<AliasIndex>).entryForKey?.(key);
    const qid = this.#ids[entry?.group ?? '']?.wikidata ?? this.#ids[key]?.wikidata ?? null;
    let cik: string | null = null;
    let lei: string | null = null;
    let needLabels: ReturnType<typeof wikidataFacts>['needLabels'] | null = null;
    let wdSrc: SourceRef | null = null;
    if (qid) {
      await tryStep('Wikidata', async () => {
        const e = parseWikidataEntity(await this.#fetchText(wikidataEntityUrl(qid)), qid);
        const problem = wikidataIdentityProblem(e, id);
        if (problem) return { name: 'Wikidata', status: 'not_same_company', note: problem };
        const plan = wikidataFacts(e, at);
        found.wikidata = plan.facts;
        cik = plan.cik;
        lei = plan.lei;
        needLabels = plan.needLabels;
        wdSrc = { name: 'Wikidata', url: `https://www.wikidata.org/wiki/${qid}`, retrievedAt: at, licence: 'CC0 1.0' };
        return { name: 'Wikidata', status: 'used', note: `item ${qid}` };
      });
    } else {
      statuses.push({ name: 'Wikidata', status: 'skipped', note: 'no reviewed Wikidata id for this company (Wikidata search is closed to automated clients)' });
    }

    // 2. SEC EDGAR, when Wikidata names the CIK (public companies).
    if (cik) {
      const c = cik;
      await tryStep('SEC EDGAR', async () => {
        const s = JSON.parse(await this.#fetchText(secSubmissionsUrl(c))) as SecSubmissions;
        const problem = secIdentityProblem(s, id);
        if (problem) return { name: 'SEC EDGAR', status: 'not_same_company', note: problem };
        found.sec = secFacts(s, c, at);
        return { name: 'SEC EDGAR', status: 'used', note: `CIK ${c}` };
      });
    } else {
      statuses.push({ name: 'SEC EDGAR', status: 'skipped', note: 'no SEC company id known (only public companies file with the SEC)' });
    }

    // 3. GLEIF: by LEI when Wikidata names it, else by the exact legal name of the H-1B filer in its state.
    if (lei || id.legalNames.length > 0) {
      await tryStep('GLEIF', async () => {
        const records = lei ? parseGleif(await this.#fetchText(gleifByLeiUrl(lei))) : parseGleif(await this.#fetchText(gleifByNameUrl(id.legalNames[0]!)));
        const pick = pickGleif(records, id);
        if (!pick) return { name: 'GLEIF', status: records.length ? 'not_same_company' : 'not_found', note: records.length ? 'no single active record with this legal name in the filer\'s state' : 'no record with this legal name' };
        found.gleif = gleifFacts(pick, at);
        return { name: 'GLEIF', status: 'used', note: `LEI ${pick.attributes?.lei ?? pick.id}` };
      });
    } else {
      statuses.push({ name: 'GLEIF', status: 'skipped', note: 'no legal name known to search for' });
    }

    // 4. Wikidata labels for leaders, and for headquarters and industries when no other source states them.
    const nl = needLabels as ReturnType<typeof wikidataFacts>['needLabels'] | null;
    if (nl && wdSrc) {
      const src: SourceRef = wdSrc;
      await tryStep('Wikidata labels', async () => {
        const leaders: Array<{ name: string; title: string }> = [];
        for (const p of nl.people) {
          const n = await this.#label(p.id);
          if (n && !leaders.some((l) => l.name === n && l.title === p.title)) leaders.push({ name: n, title: p.title });
        }
        if (leaders.length) found.wikidata.leaders = { value: leaders, source: src };
        if (!found.sec.headquarters && !found.gleif.headquarters && nl.hq) {
          const hq = await this.#label(nl.hq);
          if (hq) found.wikidata.headquarters = { value: hq, source: src };
        }
        if (!found.sec.industries && nl.industries.length) {
          const labels: string[] = [];
          for (const q of nl.industries) { const l = await this.#label(q); if (l) labels.push(l); }
          if (labels.length) found.wikidata.industries = { value: labels, source: src };
        }
        return { name: 'Wikidata labels', status: 'used', note: 'names of people and places' };
      });
    }

    // 5. The company's own H-1B filings (no request): employer address and NAICS sector, as a last resort.
    if (h1b && h1b.entities[0]) {
      const src: SourceRef = { name: 'US Department of Labor LCA disclosure data (employer details on its H-1B filings)', url: h1b.sourceUrl, retrievedAt: at, licence: 'US government work, public domain' };
      const top = h1b.entities[0];
      if (top.city && top.state) found.dol.headquarters = { value: `${titleCase(top.city)}, ${top.state} (employer address on H-1B filings)`, source: src };
    }
    const naics = this.#naicsFor(name);
    if (naics && h1b) {
      const sector = NAICS_SECTORS[naics.slice(0, 2)];
      if (sector) found.dol.industries = { value: [`${sector} (NAICS ${naics})`], source: { name: 'US Department of Labor LCA disclosure data (NAICS code on the employer\'s H-1B filings)', url: h1b.sourceUrl, retrievedAt: at, licence: 'US government work, public domain' } };
    }

    const allFailed = attempted > 0 && failed === attempted;
    const old = row ? (JSON.parse(row.facts) as Company['facts']) : {};
    if (allFailed) {
      // Keep the old facts; try again later, not on every open.
      this.#upsert(key, name, old, row?.status ? JSON.parse(row.status) as SourceStatus[] : statuses, {
        fetched_at: row?.fetched_at ?? null, fresh_until: row?.fresh_until ?? null, last_attempt_at: at,
        last_error: `The refresh failed, so the facts shown are from ${row?.fetched_at ?? 'no earlier read'}: ${errors.join('; ')}`,
        retry_after: this.#iso(this.#now() + RETRY_AFTER_FAILURE_MS), paid: row?.paid ?? null,
      });
      return;
    }
    const pick = <K extends keyof FreeFacts>(k: K, order: Array<keyof typeof found>): FreeFacts[K] | undefined => {
      for (const s of order) if (found[s][k]) return found[s][k];
      return undefined;
    };
    const facts: Company['facts'] = {};
    // Facts from paid lookups are kept until the next paid lookup.
    for (const f of ['totalFundingUsd', 'investors', 'news'] as const) if (old[f]) (facts as Record<string, unknown>)[f] = old[f];
    const set = <K extends keyof FreeFacts>(k: K, v: FreeFacts[K] | undefined) => { if (v) (facts as Record<string, unknown>)[k] = v; };
    set('headquarters', pick('headquarters', ['sec', 'gleif', 'wikidata', 'dol']));
    set('industries', pick('industries', ['sec', 'wikidata', 'dol']));
    set('website', pick('website', ['wikidata', 'sec']));
    set('stage', pick('stage', ['sec', 'wikidata']));
    set('founded', pick('founded', ['wikidata']));
    set('size', pick('size', ['wikidata']));
    set('description', pick('description', ['wikidata']));
    set('leaders', pick('leaders', ['wikidata']));
    if (!facts.stage && old.stage && (old.stage.source.name.includes('search') || old.stage.source.name.includes('web'))) facts.stage = old.stage;
    this.#upsert(key, name, facts, statuses, {
      fetched_at: at, fresh_until: this.#iso(this.#now() + this.#freshMs), last_attempt_at: at,
      last_error: failed > 0 ? `Some sources failed: ${errors.join('; ')}` : null, retry_after: null, paid: row?.paid ?? null,
    });
  }

  #naicsFor(name: string): string | null {
    return this.#h1bFor(name)?.naics ?? null;
  }

  async #refreshPaid(key: string, name: string, cap: number | undefined): Promise<void> {
    const paid = this.#paid!;
    const row = this.#row(key);
    const facts = row ? (JSON.parse(row.facts) as Company['facts']) : {};
    const queries = [`${name} funding round investors`, `${name} company news`];
    const price = paid.priceMicros('search');
    const planned = price * queries.length;
    const limit = cap ?? planned;
    const at = this.#iso();
    const prevPaid = row?.paid ? (JSON.parse(row.paid) as NonNullable<CompanyDetail['paidLookup']>) : null;
    const record = (spent: number, note: string | null) => {
      const total = (prevPaid?.totalMicros ?? 0) + spent;
      const paidJson = JSON.stringify({ lastCostMicros: spent, lastCostText: `${formatDollars(spent)} from your balance`, at, totalMicros: total, note, ran: spent > 0 });
      this.#db.prepare('UPDATE company_facts SET paid = ?, facts = ?, updated_at = ? WHERE key = ?').run(paidJson, JSON.stringify(facts), at, key);
    };
    if (!this.#row(key)) this.#upsert(key, name, facts, [], { fetched_at: null, fresh_until: null, last_attempt_at: at, last_error: null, retry_after: null, paid: null });
    if (planned > limit) {
      record(0, `Not run: the lookup costs ${formatDollars(planned)} from your balance, over your limit of ${formatDollars(limit)}.`);
      return;
    }
    let spent = 0;
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    try {
      for (const q of queries) {
        if (spent + price > limit) break;
        const r = await paid.search(q, { maxPriceMicros: price });
        spent += price;
        results.push(...r);
      }
    } catch (err) {
      record(spent, `The paid lookup failed: ${(err as Error).message}. Kept facts are unchanged.`);
      return;
    }
    const detail = this.get(key);
    const websiteHost = (() => { try { return detail.facts.website ? new URL(detail.facts.website.value).hostname.replace(/^www\./, '') : null; } catch { return null; } })();
    const h = this.#h1bFor(name);
    const topCity = h?.entities[0]?.city ?? null;
    const hqCity = detail.facts.headquarters?.value.split(',')[0]?.trim() ?? (topCity ? titleCase(topCity) : null);
    const target = { name, keys: [...this.#identity(key, name, this.#h1bFor(name)).keys], websiteHost, hqCity };
    let proposed: ProposedFact[] = [];
    try { proposed = await this.#enricher.extract(target, results); } catch { proposed = []; }
    const src = (url: string): SourceRef => ({ name: `Web search result (${(() => { try { return new URL(url).hostname; } catch { return url; } })()})`, url, retrievedAt: at });
    const news: Array<{ title: string; url: string; publishedAt: string | null; outlet: string | null }> = [];
    let rejected = 0;
    for (const p of proposed) {
      if (checkProposed(p, results, target) !== null) { rejected += 1; continue; }
      if (p.field === 'news') { for (const n of p.value as typeof news) if (!news.some((x) => x.url === n.url)) news.push(n); }
      else if (p.field === 'totalFundingUsd' && !facts.totalFundingUsd) facts.totalFundingUsd = { value: Number(p.value), source: src(p.url) };
      else if (p.field === 'investors' && !facts.investors) facts.investors = { value: p.value as string[], source: src(p.url) };
      else if (p.field === 'stage' && !facts.stage) facts.stage = { value: p.value as NonNullable<Company['facts']['stage']>['value'], source: src(p.url) };
    }
    if (news.length) facts.news = { value: news.slice(0, 5), source: src(news[0]!.url) };
    record(spent, rejected > 0 ? `${rejected} proposed facts were left out because their source did not state them for this company.` : null);
  }

  #upsert(key: string, name: string, facts: Company['facts'], status: SourceStatus[], v: { fetched_at: string | null; fresh_until: string | null; last_attempt_at: string | null; last_error: string | null; retry_after: string | null; paid: string | null }): void {
    this.#db.prepare(`INSERT INTO company_facts (key, name, facts, status, fetched_at, fresh_until, last_attempt_at, last_error, retry_after, paid, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET name = excluded.name, facts = excluded.facts, status = excluded.status, fetched_at = excluded.fetched_at,
        fresh_until = excluded.fresh_until, last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
        retry_after = excluded.retry_after, paid = excluded.paid, updated_at = excluded.updated_at`)
      .run(key, name, JSON.stringify(facts), JSON.stringify(status), v.fetched_at, v.fresh_until, v.last_attempt_at, v.last_error, v.retry_after, v.paid, this.#iso());
  }
}

export type { FactValue };
