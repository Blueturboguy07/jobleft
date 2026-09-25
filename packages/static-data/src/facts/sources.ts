// Free company-fact sources: Wikidata (CC0), SEC EDGAR (public domain) and GLEIF (CC0).
// Every request carries only what names the company: a Wikidata item id, an SEC CIK, or a legal entity name.
// Every source is checked for identity before any fact is used (static-data O11).

import { companyKey } from '../company-key.ts';

export interface SourceRef { name: string; url: string | null; retrievedAt: string; licence?: string }
export interface FactValue<V> { value: V; source: SourceRef }

export interface FreeFacts {
  website?: FactValue<string>;
  description?: FactValue<string>;
  founded?: FactValue<number>;
  headquarters?: FactValue<string>;
  size?: FactValue<string>;
  industries?: FactValue<string[]>;
  stage?: FactValue<'public'>;
  leaders?: FactValue<Array<{ name: string; title: string }>>;
}

export interface Identity {
  /** Every companyKey that names this company (input, aliases, H-1B filer names). */
  keys: Set<string>;
  /** FEINs of the H-1B filers behind this company ("12-3456789"). */
  feins: Set<string>;
  /** Legal filer names from the H-1B data, most filings first. */
  legalNames: string[];
  /** State of the main H-1B filer, when known ("CA"). */
  state: string | null;
}

export const WIKIDATA_LICENCE = 'CC0 1.0';
export const SEC_LICENCE = 'US government data, public domain';
export const GLEIF_LICENCE = 'CC0 1.0';

export function wikidataEntityUrl(qid: string): string { return `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`; }
export function wikidataPageUrl(qid: string): string { return `https://www.wikidata.org/wiki/${qid}`; }
export function secSubmissionsUrl(cik: string): string { return `https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`; }
export function secCompanyPageUrl(cik: string): string { return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik.padStart(10, '0')}`; }
export function gleifByNameUrl(legalName: string): string { return `https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=${encodeURIComponent(legalName)}&page%5Bsize%5D=10`; }
export function gleifByLeiUrl(lei: string): string { return `https://api.gleif.org/api/v1/lei-records/${encodeURIComponent(lei)}`; }
export function gleifPageUrl(lei: string): string { return `https://search.gleif.org/#/record/${lei}`; }

// ---------------------------------------------------------------------------------------------------------------
// Wikidata

interface WdSnak { snaktype?: string; datavalue?: { value: unknown; type: string } }
interface WdClaim { mainsnak: WdSnak; rank?: string; qualifiers?: Record<string, WdSnak[]> }
export interface WdEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  aliases?: Record<string, Array<{ value: string }>>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, WdClaim[]>;
}

export function parseWikidataEntity(json: string, qid: string): WdEntity {
  const j = JSON.parse(json) as { entities?: Record<string, WdEntity> };
  const e = j.entities?.[qid] ?? Object.values(j.entities ?? {})[0];
  if (!e) throw new Error(`Wikidata returned no item for ${qid}`);
  return e;
}

/** Claims that are not deprecated; the preferred ones when any are preferred. */
function claims(e: WdEntity, p: string): WdClaim[] {
  const all = (e.claims?.[p] ?? []).filter((c) => c.rank !== 'deprecated' && c.mainsnak?.snaktype === 'value');
  const pref = all.filter((c) => c.rank === 'preferred');
  return pref.length > 0 ? pref : all;
}

function timeOf(v: unknown): { year: number; iso: string } | null {
  const t = (v as { time?: string })?.time;
  const m = t ? /^([+-]\d{4,})-(\d{2})-(\d{2})/.exec(t) : null;
  if (!m) return null;
  return { year: Number(m[1]), iso: `${Number(m[1])}-${m[2]}-${m[3]}` };
}

function ended(c: WdClaim, nowIso: string): boolean {
  const end = c.qualifiers?.P582?.[0]?.datavalue?.value;
  const t = timeOf(end);
  return t !== null && t.iso <= nowIso.slice(0, 10);
}

function idOf(c: WdClaim): string | null {
  const v = c.mainsnak.datavalue?.value as { id?: string } | undefined;
  return v?.id ?? null;
}

const NOT_A_COMPANY = new Set(['Q5', 'Q515', 'Q6256', 'Q7397', 'Q35127', 'Q620615', 'Q1668024', 'Q2424752', 'Q7889', 'Q11424', 'Q4167836']);

/** Checks that a Wikidata item names this company; returns a reason when it does not. */
export function wikidataIdentityProblem(e: WdEntity, id: Identity): string | null {
  const names = [e.labels?.en?.value, ...(e.aliases?.en ?? []).map((a) => a.value)].filter((x): x is string => !!x);
  const keys = names.map(companyKey);
  if (!keys.some((k) => id.keys.has(k))) return `the Wikidata item ${e.id} is named "${e.labels?.en?.value ?? '?'}", which is not this company`;
  const types = claims(e, 'P31').map(idOf).filter((x): x is string => !!x);
  if (types.some((t) => NOT_A_COMPANY.has(t))) return `the Wikidata item ${e.id} is not a company`;
  return null;
}

export interface WikidataPlan {
  facts: FreeFacts;
  /** Items whose English labels are needed to finish the facts. */
  needLabels: { hq: string | null; industries: string[]; people: Array<{ id: string; title: string }> };
  cik: string | null;
  lei: string | null;
}

export function wikidataFacts(e: WdEntity, retrievedAt: string): WikidataPlan {
  const src: SourceRef = { name: 'Wikidata', url: wikidataPageUrl(e.id), retrievedAt, licence: WIKIDATA_LICENCE };
  const facts: FreeFacts = {};
  const inception = claims(e, 'P571').map((c) => timeOf(c.mainsnak.datavalue?.value)).find((t) => t !== null);
  if (inception && inception.year > 1600 && inception.year <= Number(retrievedAt.slice(0, 4))) facts.founded = { value: inception.year, source: src };
  const site = claims(e, 'P856').map((c) => c.mainsnak.datavalue?.value).find((v): v is string => typeof v === 'string' && /^https?:\/\//.test(v));
  if (site) facts.website = { value: site, source: src };
  const desc = e.descriptions?.en?.value;
  if (desc) facts.description = { value: desc, source: src };
  // Employees: the value with the latest "point in time".
  let best: { n: number; year: number | null } | null = null;
  for (const c of claims(e, 'P1128')) {
    const amount = Number(String((c.mainsnak.datavalue?.value as { amount?: string })?.amount ?? '').replace('+', ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const t = timeOf(c.qualifiers?.P585?.[0]?.datavalue?.value);
    const year = t?.year ?? null;
    if (!best || (year ?? 0) > (best.year ?? 0)) best = { n: Math.round(amount), year };
  }
  if (best) facts.size = { value: `${best.n.toLocaleString('en-US')} employees${best.year ? ` (as of ${best.year})` : ' (date not stated)'}`, source: src };
  if (claims(e, 'P414').some((c) => !ended(c, retrievedAt))) facts.stage = { value: 'public', source: src };
  const people: Array<{ id: string; title: string }> = [];
  for (const c of claims(e, 'P169')) if (!ended(c, retrievedAt)) { const id = idOf(c); if (id) people.push({ id, title: 'Chief Executive Officer' }); }
  for (const c of claims(e, 'P488')) if (!ended(c, retrievedAt)) { const id = idOf(c); if (id) people.push({ id, title: 'Chair' }); }
  for (const c of claims(e, 'P112').slice(0, 3)) { const id = idOf(c); if (id) people.push({ id, title: 'Founder' }); }
  const hq = claims(e, 'P159').filter((c) => !ended(c, retrievedAt)).map(idOf).find((x): x is string => !!x) ?? null;
  const industries = claims(e, 'P452').map(idOf).filter((x): x is string => !!x).slice(0, 3);
  const cik = claims(e, 'P5531').map((c) => c.mainsnak.datavalue?.value).find((v): v is string => typeof v === 'string' && /^\d{1,10}$/.test(v)) ?? null;
  const lei = claims(e, 'P1278').map((c) => c.mainsnak.datavalue?.value).find((v): v is string => typeof v === 'string' && /^[A-Z0-9]{20}$/.test(v)) ?? null;
  return { facts, needLabels: { hq, industries, people: people.slice(0, 6) }, cik, lei };
}

export function labelOf(json: string, qid: string): string | null {
  const e = parseWikidataEntity(json, qid);
  return e.labels?.en?.value ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// SEC EDGAR

export interface SecSubmissions {
  cik?: string; name?: string; ein?: string | null; sicDescription?: string; tickers?: string[]; exchanges?: string[]; website?: string;
  addresses?: { business?: { city?: string | null; stateOrCountry?: string | null } };
  formerNames?: Array<{ name: string }>;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function secIdentityProblem(s: SecSubmissions, id: Identity): string | null {
  const ein = String(s.ein ?? '').replace(/\D/g, '');
  if (ein.length === 9 && id.feins.size > 0) {
    const feins = new Set([...id.feins].map((f) => f.replace(/\D/g, '')));
    if (feins.has(ein)) return null;
  }
  const keys = [s.name, ...(s.formerNames ?? []).map((f) => f.name)].filter((x): x is string => !!x).map(companyKey);
  if (keys.some((k) => id.keys.has(k))) return null;
  return `the SEC record "${s.name ?? '?'}" does not match this company's name or FEIN`;
}

export function secFacts(s: SecSubmissions, cik: string, retrievedAt: string): FreeFacts {
  const src: SourceRef = { name: 'SEC EDGAR', url: secCompanyPageUrl(cik), retrievedAt, licence: SEC_LICENCE };
  const facts: FreeFacts = {};
  const b = s.addresses?.business;
  if (b?.city && b.stateOrCountry) facts.headquarters = { value: `${titleCase(b.city)}, ${b.stateOrCountry}`, source: src };
  if (s.sicDescription) facts.industries = { value: [s.sicDescription], source: src };
  if ((s.tickers ?? []).length > 0 && (s.exchanges ?? []).filter(Boolean).length > 0) facts.stage = { value: 'public', source: src };
  const w = (s.website ?? '').trim();
  if (w) facts.website = { value: /^https?:\/\//.test(w) ? w : `https://${w}`, source: src };
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------
// GLEIF

interface GleifAddress { city?: string; region?: string | null; country?: string }
interface GleifRecord { id?: string; attributes?: { lei?: string; entity?: { legalName?: { name?: string }; headquartersAddress?: GleifAddress; legalAddress?: GleifAddress; status?: string } } }

export function parseGleif(json: string): GleifRecord[] {
  const j = JSON.parse(json) as { data?: GleifRecord | GleifRecord[] };
  if (!j.data) return [];
  return Array.isArray(j.data) ? j.data : [j.data];
}

/** The one active GLEIF record with this legal name in the H-1B filer's state, or null (none, or several). */
export function pickGleif(records: GleifRecord[], id: Identity): GleifRecord | null {
  const ok = records.filter((r) => {
    const e = r.attributes?.entity;
    if (!e || e.status !== 'ACTIVE') return false;
    if (!id.keys.has(companyKey(e.legalName?.name ?? ''))) return false;
    if (id.state) {
      const want = `US-${id.state}`;
      return e.headquartersAddress?.region === want || e.legalAddress?.region === want;
    }
    return true;
  });
  return ok.length === 1 ? ok[0]! : null;
}

export function gleifFacts(r: GleifRecord, retrievedAt: string): FreeFacts {
  const lei = r.attributes?.lei ?? r.id ?? '';
  const src: SourceRef = { name: 'GLEIF (Legal Entity Identifier records)', url: gleifPageUrl(lei), retrievedAt, licence: GLEIF_LICENCE };
  const hq = r.attributes?.entity?.headquartersAddress;
  const facts: FreeFacts = {};
  if (hq?.city) {
    const region = hq.region?.startsWith(`${hq.country}-`) ? hq.region.slice(3) : hq.region ?? null;
    facts.headquarters = { value: [titleCase(hq.city), region, hq.country].filter(Boolean).join(', '), source: src };
  }
  return facts;
}
