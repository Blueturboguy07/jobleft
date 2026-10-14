// Widening a web search with the person's AI provider (Jobs > Web jobs > Widen with AI): titles that mean the same
// job as the words given, the way job postings in that country write them ("SOC analyst" in the Netherlands:
// "security analist", "SOC medewerker", ...). One small call; the answer is checked, cleaned and kept for a day, so
// the same search again costs nothing. Only the search words and the country go to the provider.

import type { AiClient } from '@jobleft/ai-engine';
import { arr, obj, str } from '@jobleft/contracts';

const DAY_MS = 24 * 3600_000;
const MAX_TITLES = 5;
const cache = new Map<string, { at: number; titles: string[] }>();

const SCHEMA = obj({ titles: arr(str({ maxLength: 60 }), { maxItems: 8 }) });

const LANG: Record<string, string> = { NL: 'Dutch and English', BE: 'Dutch, French and English', DE: 'German and English', FR: 'French and English' };
const COUNTRY = new Intl.DisplayNames(['en'], { type: 'region' });

/** Cleans what the model wrote: short job titles only, without the words given, places or duplicates. */
export function cleanTitles(raw: unknown[], given: string[]): string[] {
  const seen = new Set(given.map((g) => g.toLowerCase()));
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const t = r.replace(/^[\s\-*\d.)"']+|["'.]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 50 || t.split(' ').length > 5 || /[:/@]|https?/i.test(t)) continue;
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}

/** Titles that mean the same job as `titles`, for postings in `country`. Throws when the provider fails. */
export async function widenTitles(client: AiClient, titles: string[], country: string | null, signal?: AbortSignal): Promise<string[]> {
  const key = `${client.provider}|${client.model}|${country ?? ''}|${titles.map((t) => t.toLowerCase()).join(',')}`;
  const hit = cache.get(key);
  if (hit && hit.at + DAY_MS > Date.now()) return hit.titles;
  const where = country ? ` in ${COUNTRY.of(country) ?? country}` : '';
  const lang = country ? LANG[country] ?? 'English and the local language' : 'English';
  const r = await client.json({
    schema: SCHEMA,
    temperature: 0.2,
    signal,
    messages: [
      { role: 'system', content: 'You help search job postings. Answer only with JSON.' },
      { role: 'user', content: `Job postings${where} for this job may use other titles. Give up to ${MAX_TITLES} other job titles that mean the same job or a very close one, as postings${where} write them, in ${lang}. Short titles only: no places, no company names, no levels unless the given title has one.\nThe job: ${titles.join(', ')}\nAnswer as {"titles": ["...", "..."]}.` },
    ],
    lineFallback: (text: string) => ({ titles: text.split('\n').map((l) => l.trim()).filter(Boolean) }),
  });
  const out = cleanTitles(r.titles, titles);
  cache.set(key, { at: Date.now(), titles: out });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return out;
}
