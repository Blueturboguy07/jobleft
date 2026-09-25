// The company facts panel (plan D3, outcome O2). It shows what jobleft KNOWS about a company, each fact with its source
// and the date it was read, and it says plainly what is not known. Sources, in order:
//   1. the stored company record (`getCompany`: free public sources such as Wikidata, SEC and GLEIF, cached with dates);
//   2. the H-1B filing history from the shipped Department of Labor data (`h1bLookup`), always hedged, never a "no";
//   3. facts from the person's own job store (how many open jobs, where): counted from the records;
//   4. optional LLM enrichment through a HOOK (`CompanyEnricher`). It runs only when the person asks for it, states
//      its price first, never runs in the background, and every fact it returns must carry a source link and a quote
//      that is really in the fetched text. A fact without both is dropped.
// A fact nobody states is left out and named under `notKnown`. Nothing is guessed from the company name.

import { formatDollars, type Company, type H1bSummary, type Job } from '@jobleft/contracts';
import type { Data } from './data.ts';
import { plainError, statusOf } from './data.ts';
import { localDate } from './views.ts';

export interface PanelFact { label: string; value: string; source: string; sourceUrl: string | null; retrievedOn: string }

export interface CompanyPanel {
  name: string;
  companyKey: string | null;
  facts: PanelFact[];
  /** Facts nobody has stated: shown as "not known", never as a guess. */
  notKnown: string[];
  sponsorship: {
    /** What the POSTING says, when a job is given: yes, no or null (says nothing). */
    postingSays: 'yes' | 'no' | null;
    /** The hedged history line, or null when the shipped data has no record. */
    history: string | null;
    text: string;
  };
  isStaffingAgency: boolean | null;
  openJobs: number | null;
  enrichment: { available: boolean; priceText: string | null; how: string };
  note: string;
}

/** A fact from an enricher. `quote` must be a piece of `sourceText`; without a source link and a real quote it is dropped. */
export interface EnrichedFact { label: string; value: string; sourceName: string; sourceUrl: string; quote: string }
export interface CompanyEnricher {
  /** A short description of how it works and what it costs, shown before the person asks. */
  describe(): { priceText: string | null; how: string };
  /** Reads more about the company. `sourceText` holds the text each fact was read from, so the caller can check the quote. */
  enrich(input: { name: string; website: string | null; maxPriceMicros: number; signal?: AbortSignal }): Promise<{ facts: EnrichedFact[]; sourceText: Record<string, string>; costMicros: number | null }>;
}

const LABELS: Array<[keyof Company['facts'], string]> = [
  ['website', 'Website'], ['description', 'What it does'], ['founded', 'Founded'], ['headquarters', 'Headquarters'], ['size', 'Size'],
  ['industries', 'Industries'], ['stage', 'Stage'], ['totalFundingUsd', 'Total funding'], ['investors', 'Investors'], ['leaders', 'Leaders'], ['news', 'Recent news'],
];

function valueText(key: keyof Company['facts'], v: unknown): string {
  if (Array.isArray(v)) {
    if (key === 'leaders') return (v as Array<{ name: string; title: string }>).map((l) => `${l.name} (${l.title})`).join('; ');
    if (key === 'news') return (v as Array<{ title: string; outlet: string | null }>).slice(0, 5).map((n) => n.title + (n.outlet ? ` (${n.outlet})` : '')).join('; ');
    return (v as unknown[]).map(String).join(', ');
  }
  if (key === 'totalFundingUsd') return formatDollars(Number(v) * 1_000_000);
  return String(v);
}

export function h1bLine(h: H1bSummary): string {
  return `${h.certifiedFilings} certified H-1B filings between ${h.window.from} and ${h.window.to} (US Department of Labor data through ${h.dataThrough}). ${h.note}`;
}

export function sponsorshipText(postingSays: 'yes' | 'no' | null, history: string | null): string {
  if (postingSays === 'no') return 'The posting itself says it does not sponsor visas. That statement counts, whatever the filing history shows.';
  if (postingSays === 'yes') return 'The posting itself says the company sponsors visas.' + (history ? ` Filing history: ${history}` : '');
  if (history) return `The posting says nothing about sponsorship. Filing history: ${history}`;
  return 'The posting says nothing about sponsorship, and the shipped filing data has no record of this company. That does not mean the company does not sponsor: it means jobleft does not know.';
}

export async function buildCompanyPanel(data: Data, input: { companyKey?: string | null; name?: string | null; job?: Job | null; tz: string; enricher?: CompanyEnricher | null }): Promise<CompanyPanel> {
  const name = input.name?.trim() || input.job?.company || input.companyKey || 'This company';
  const key = input.companyKey || input.job?.companyKey || null;
  let company: Company | null = null;
  let problem: string | null = null;
  if (key) {
    try { company = await data.api.call('getCompany', { params: { companyKey: key } }); } catch (e) {
      if (statusOf(e) !== 404) problem = plainError(e);
    }
  }
  const facts: PanelFact[] = [];
  const known = new Set<string>();
  if (company) {
    for (const [k, label] of LABELS) {
      const f = company.facts[k] as { value: unknown; source: { name: string; url: string | null; retrievedAt: string } } | undefined;
      if (!f) continue;
      known.add(label);
      facts.push({ label, value: valueText(k, f.value), source: f.source.name, sourceUrl: f.source.url, retrievedOn: localDate(f.source.retrievedAt, input.tz) });
    }
  }
  const notKnown = LABELS.map(([, l]) => l).filter((l) => !known.has(l));

  let history: string | null = company?.h1b ? h1bLine(company.h1b) : null;
  if (!history && (company?.name || name)) {
    try {
      const h = await data.api.call('h1bLookup', { query: { company: company?.name ?? name } });
      if (h.status === 'found' && h.summary) history = h1bLine(h.summary);
    } catch { /* unknown stays unknown */ }
  }
  const postingSays = input.job?.statements.sponsorship ?? null;

  let openJobs: number | null = null;
  if (key) {
    try {
      const r = await data.api.call('searchJobs', { body: { sort: 'most_recent', filter: { companies: [key], status: 'open' }, limit: 1 } });
      openJobs = r.total;
    } catch { openJobs = null; }
  }

  const desc = input.enricher?.describe() ?? null;
  return {
    name: company?.name ?? name, companyKey: key, facts, notKnown,
    sponsorship: { postingSays, history, text: sponsorshipText(postingSays, history) },
    isStaffingAgency: company?.isStaffingAgency ?? null,
    openJobs,
    enrichment: desc
      ? { available: true, priceText: desc.priceText, how: desc.how }
      : { available: false, priceText: null, how: 'No enrichment source is set up. The facts above are all that jobleft stores.' },
    note: problem
      ? `The stored company facts could not be read: ${problem}`
      : facts.length ? 'Each fact shows its source and the date it was read. A fact that is not listed is not known.' : `No facts are stored for ${name}. jobleft does not guess funding, investors, leaders or size from a name.`,
  };
}

/** Runs the enrichment hook (only ever on the person's request) and keeps only facts that carry a source link and a real quote. */
export async function runEnrichment(enricher: CompanyEnricher, input: { name: string; website: string | null; maxPriceMicros: number; signal?: AbortSignal; tz: string }): Promise<{ facts: PanelFact[]; dropped: number; costMicros: number | null }> {
  const r = await enricher.enrich({ name: input.name, website: input.website, maxPriceMicros: input.maxPriceMicros, signal: input.signal });
  const facts: PanelFact[] = [];
  let dropped = 0;
  const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const f of r.facts) {
    const text = r.sourceText[f.sourceUrl];
    const okUrl = /^https?:\/\//.test(f.sourceUrl);
    const okQuote = typeof text === 'string' && f.quote.trim().length >= 8 && normalise(text).includes(normalise(f.quote));
    if (!okUrl || !okQuote || !f.value.trim()) { dropped++; continue; }
    facts.push({ label: f.label, value: f.value, source: f.sourceName, sourceUrl: f.sourceUrl, retrievedOn: localDate(Date.now(), input.tz) });
  }
  return { facts, dropped, costMicros: r.costMicros };
}
