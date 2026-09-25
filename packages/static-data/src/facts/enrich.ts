// The paid enrichment hook (funding, investors, stage, news) and the gate every proposed fact must pass.
//
// Free sources do not state funding, investors or news. A paid web search (publik metered route, later) can find
// them, and a model or a rule can read the results. Whatever proposes a fact, jobleft keeps it only when:
//   1. its link is one of the search results;
//   2. its quote appears word for word in that result's title or snippet;
//   3. that result names this company AND shows who it is (its website domain, or its headquarters city);
//   4. every number or name in the value appears in the quote ("$40M" never becomes "$400M").
// With no results, or results about a different company with a similar name, nothing is kept (static-data O11).

import { companyKey } from '../company-key.ts';

export interface SearchResult { title: string; url: string; snippet: string }

export type ProposedField = 'totalFundingUsd' | 'investors' | 'stage' | 'news' | 'leaders' | 'founded';

export interface ProposedFact {
  field: ProposedField;
  /** totalFundingUsd: number; investors: string[]; stage: 'early'|'growth'|'late'|'public'; news: {title,url,publishedAt,outlet}[]; leaders: {name,title}[]; founded: number */
  value: unknown;
  url: string;
  quote: string;
}

export interface EnrichTarget {
  name: string;
  keys: string[];
  /** The company's website host, when a free source states it ("stripe.com"). */
  websiteHost: string | null;
  /** The company's headquarters city, when a free source states it ("South San Francisco"). */
  hqCity: string | null;
}

/** Reads search results and proposes facts. A model-backed extractor plugs in here later. */
export interface PaidEnricher {
  extract(target: EnrichTarget, results: SearchResult[]): Promise<ProposedFact[]>;
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** Does the text name the company? Checks every run of 1 to 6 words against the company's keys. */
export function namesCompany(text: string, keys: ReadonlySet<string>): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 6 && i + n <= words.length; n++) {
      const k = companyKey(words.slice(i, i + n).join(' '));
      if (k && keys.has(k)) return true;
    }
  }
  return false;
}

/** Money amounts written in a text, in dollars ("$40M", "$1.2 billion", "40 million dollars"). */
export function moneyIn(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?([\d][\d,]*(?:\.\d+)?)\s*(billion|million|thousand|bn|b|m|k)?\b|([\d][\d,]*(?:\.\d+)?)\s*(billion|million)\s+(?:us\s+)?dollars/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const num = Number((m[1] ?? m[3] ?? '').replace(/,/g, ''));
    const unit = (m[2] ?? m[4] ?? '').toLowerCase();
    const mult = unit.startsWith('b') ? 1e9 : unit.startsWith('m') ? 1e6 : unit.startsWith('t') || unit === 'k' ? 1e3 : 1;
    if (Number.isFinite(num)) out.push(num * mult);
  }
  return out;
}

export function checkProposed(p: ProposedFact, results: SearchResult[], target: EnrichTarget): string | null {
  const r = results.find((x) => x.url === p.url);
  if (!r) return 'the link is not one of the search results';
  if (!/^https?:\/\//.test(p.url)) return 'the link is not http or https';
  const hay = norm(`${r.title} ${r.snippet}`);
  const quote = norm(p.quote ?? '');
  if (quote.length < 8 || !hay.includes(quote)) return 'the quote is not in the search result';
  const keys = new Set(target.keys);
  if (!namesCompany(`${r.title} ${r.snippet}`, keys)) return 'the search result does not name this company';
  const host = hostOf(r.url);
  const siteOk = target.websiteHost !== null && (host === target.websiteHost || host?.endsWith(`.${target.websiteHost}`) || hay.includes(target.websiteHost));
  const cityOk = target.hqCity !== null && hay.includes(norm(target.hqCity));
  if (!siteOk && !cityOk) return target.websiteHost || target.hqCity ? 'the search result does not show it is the same company (no website or headquarters match)' : 'jobleft knows no website or headquarters for this company, so it cannot confirm the result is about it';
  switch (p.field) {
    case 'totalFundingUsd': {
      const v = Number(p.value);
      if (!Number.isFinite(v) || v <= 0) return 'the amount is not a number';
      if (!moneyIn(p.quote).some((m) => Math.abs(m - v) <= v * 0.005)) return 'the amount is not the one in the quote';
      return null;
    }
    case 'investors':
    case 'leaders': {
      const list = Array.isArray(p.value) ? p.value : [];
      if (list.length === 0) return 'no names';
      for (const item of list) {
        const name = typeof item === 'string' ? item : (item as { name?: string })?.name;
        if (!name || !quote.includes(norm(name))) return `"${String(name)}" is not in the quote`;
        const title = typeof item === 'string' ? null : (item as { title?: string })?.title;
        if (title && !quote.includes(norm(title))) return `the title "${title}" is not in the quote`;
      }
      return null;
    }
    case 'stage': {
      const v = String(p.value);
      const round = /\bseries\s+([a-h])\b/i.exec(p.quote)?.[1]?.toUpperCase() ?? null;
      const ok = (v === 'public' && /\b(ipo|publicly traded|went public|nasdaq|nyse)\b/i.test(p.quote))
        || (v === 'early' && (/\b(pre-seed|seed)\b/i.test(p.quote) || round === 'A'))
        || (v === 'growth' && (round === 'B' || round === 'C'))
        || (v === 'late' && round !== null && round >= 'D');
      return ok ? null : 'the stage is not what the quote says';
    }
    case 'founded': {
      const y = Number(p.value);
      return /\bfounded\b/i.test(p.quote) && p.quote.includes(String(y)) ? null : 'the year is not in a "founded" quote';
    }
    case 'news': {
      const items = Array.isArray(p.value) ? p.value as Array<{ title?: string; url?: string }> : [];
      return items.length === 1 && items[0]!.url === r.url && items[0]!.title && norm(r.title).includes(norm(items[0]!.title!)) ? null : 'the headline is not the search result';
    }
  }
  return 'unknown field';
}

const sentenceWith = (text: string, re: RegExp): string | null => {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.find((s) => re.test(s)) ?? null;
};

/** A small rule-based extractor: headlines as news, "raised $X" as total funding, "Series X" as stage. */
export const ruleEnricher: PaidEnricher = {
  async extract(_target, results) {
    const out: ProposedFact[] = [];
    for (const r of results) {
      out.push({ field: 'news', value: [{ title: r.title, url: r.url, publishedAt: null, outlet: hostOf(r.url) }], url: r.url, quote: r.title });
      const raised = sentenceWith(r.snippet, /\braised\b[^.]*\$\s?\d/i);
      if (raised) {
        const amounts = moneyIn(raised);
        if (amounts.length === 1) out.push({ field: 'totalFundingUsd', value: amounts[0], url: r.url, quote: raised });
      }
      const series = sentenceWith(r.snippet, /\bseries\s+[a-h]\b/i);
      if (series) {
        const round = /\bseries\s+([a-h])\b/i.exec(series)![1]!.toUpperCase();
        out.push({ field: 'stage', value: round === 'A' ? 'early' : round <= 'C' ? 'growth' : 'late', url: r.url, quote: series });
      }
    }
    return out;
  },
};
