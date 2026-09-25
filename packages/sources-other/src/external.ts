// Add a job by URL or by pasted text (the External tab; route addExternalJob). The store saves the draft.
//   jobFromUrl:  one plain GET through the given client (the crawler's polite HttpClient in the app), then the page's
//                JSON-LD JobPosting (the markup employers publish for search engines), then the page text
//   jobFromText: the pasted text; facts the text does not state stay unknown
// Never a never-crawl host (checked before any request). Nothing is guessed: a missing company or title is a warning.

import { createHash } from 'node:crypto';
import type { PayPeriod } from '@jobleft/contracts';
import { canonicalizeUrl } from '@jobleft/crawler';
import type { RawJob, RawPay } from '@jobleft/crawler';
import { decodeEntities, htmlToText, parsePayFromText } from '@jobleft/parsers';
import type { FeedHttp } from './types.ts';
import { FeedError, NEVER_CRAWL } from './http.ts';
import { employmentTypeOf, safeHttpUrl } from './text.ts';
import { rawJob } from './feeds/common.ts';

/** A job the person adds by URL or by text, before the store saves it. */
export interface ExternalJobDraft {
  raw: RawJob;
  sourceId: 'external:url' | 'external:text';
  warnings: string[];
}

function hashId(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 24);
}

function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]; }
function o(v: unknown): Record<string, unknown> | null { return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null; }
function s(v: unknown): string { return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''; }

/** Every JSON-LD object of type JobPosting in a page (top level, arrays and @graph). */
export function jobPostingsFromHtml(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6) return;
    for (const x of asArray(v)) {
      const ob = o(x);
      if (!ob) continue;
      const t = asArray(ob['@type']).map(s);
      if (t.some((y) => /^JobPosting$/i.test(y))) out.push(ob);
      if (ob['@graph']) visit(ob['@graph'], depth + 1);
    }
  };
  while ((m = re.exec(html)) !== null) {
    try { visit(JSON.parse(m[1]!.trim()), 0); } catch { /* a damaged block is skipped */ }
  }
  return out;
}

const UNIT: Record<string, PayPeriod> = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };

function payOf(jp: Record<string, unknown>): RawPay | null {
  const bs = o(jp.baseSalary);
  if (!bs) return null;
  const currency = s(bs.currency).toUpperCase();
  const v = o(bs.value) ?? bs;
  const unit = UNIT[s(v.unitText).toUpperCase()];
  const num = (x: unknown): number | null => { const n = typeof x === 'number' ? x : Number(s(x)); return Number.isFinite(n) && n > 0 ? n : null; };
  const min = num(v.minValue) ?? num(v.value);
  const max = num(v.maxValue) ?? num(v.value);
  if (!/^[A-Z]{3}$/.test(currency) || !unit || (min === null && max === null)) return null;
  return { min, max, currency, period: unit };
}

function placeText(jp: Record<string, unknown>): { text: string; countries: string[] } {
  const texts: string[] = [];
  const countries: string[] = [];
  for (const loc of asArray(jp.jobLocation)) {
    const a = o(o(loc)?.address) ?? o(loc);
    if (!a) continue;
    const country = typeof a.addressCountry === 'string' ? a.addressCountry : s(o(a.addressCountry)?.name);
    const t = [s(a.addressLocality), s(a.addressRegion), country].filter(Boolean).join(', ');
    if (t) texts.push(t);
    if (/^[A-Z]{2}$/.test(country)) countries.push(country);
  }
  return { text: texts.join('; '), countries };
}

/** Reads a job page with a plain GET (JSON-LD JobPosting first, then the page text). Never a never-crawl host. */
export async function jobFromUrl(url: string, http: FeedHttp): Promise<ExternalJobDraft> {
  const clean = safeHttpUrl(url);
  if (!clean) throw new FeedError('forbidden_host', 'That is not a web link (it must start with http:// or https://).');
  const host = new URL(clean).hostname.toLowerCase();
  if (NEVER_CRAWL.test(host)) throw new FeedError('never_crawl', `jobleft never reads pages on ${host}. Paste the job text instead.`);
  let html: string;
  try {
    html = await http.getText(clean, 'text/html,application/xhtml+xml');
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    const status = (e as { status?: number }).status;
    if (e instanceof FeedError) throw e;
    if (name === 'NotFoundError') throw new FeedError('not_found', `The page was not found (HTTP ${status ?? 404}). The posting may be closed.`);
    if (name === 'DeniedHostError') throw new FeedError('never_crawl', `jobleft never reads pages on ${host}. Paste the job text instead.`);
    if (name === 'RobotsError') throw new FeedError('robots', `${host} asks crawlers not to read that page (robots.txt). Paste the job text instead.`);
    if (name === 'BlockedError') throw new FeedError('blocked', `${host} refused the request (HTTP ${status ?? 403}). Paste the job text instead.`);
    if (name === 'HttpError' && status && status >= 300 && status < 400) throw new FeedError('redirect', 'The link redirects to another address. Open it in your browser and paste the final address.');
    throw new FeedError('network', `Could not read the page on ${host}.`);
  }
  const warnings: string[] = [];
  const postings = jobPostingsFromHtml(html);
  const canonical = canonicalizeUrl(clean) || clean;
  if (postings.length > 0) {
    const jp = postings[0]!;
    if (postings.length > 1) warnings.push(`The page describes ${postings.length} jobs; the first one was used.`);
    const title = decodeEntities(s(jp.title));
    const company = decodeEntities(s(o(jp.hiringOrganization)?.name) || s(jp.hiringOrganization));
    if (!title) warnings.push('The page does not state a job title.');
    if (!company) warnings.push('The page does not name the employer.');
    const where = placeText(jp);
    const remote = /TELECOMMUTE/i.test(s(jp.jobLocationType));
    const applyUrl = safeHttpUrl(jp.url) ?? '';
    return {
      sourceId: 'external:url',
      warnings,
      raw: rawJob({
        externalId: hashId(canonical), url: clean, applyUrl: applyUrl && applyUrl !== clean ? applyUrl : '', title, company,
        location: where.text, descriptionHtml: s(jp.description), remote, workMode: remote ? 'remote' : '', countries: where.countries,
        postedAt: (() => { const t = Date.parse(s(jp.datePosted)); return Number.isFinite(t) ? new Date(t).toISOString() : null; })(),
        employmentType: employmentTypeOf(asArray(jp.employmentType).map(s).join(' ')) ?? '',
        pay: payOf(jp),
      }),
    };
  }
  const text = htmlToText(html);
  if (!/\b(responsibilit|requirement|qualification|what you('|’)ll do|about the role|apply|experience with|job description)/i.test(text) || text.length < 200) {
    throw new FeedError('shape', 'This page does not look like a job posting. Paste the job text instead.');
  }
  const og = (p: string) => decodeEntities((new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']*)["']`, 'i').exec(html)?.[1] ?? '').trim());
  const title = og('title') || decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const company = og('site_name');
  warnings.push('The page has no structured job data; the title comes from the page title. Check it.');
  if (!company) warnings.push('The page does not name the employer.');
  return {
    sourceId: 'external:url',
    warnings,
    raw: rawJob({ externalId: hashId(canonical), url: clean, title, company, descriptionHtml: html, pay: null }),
  };
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Builds a job from pasted text. Facts the text does not state stay unknown. */
export function jobFromText(text: string, applyUrl: string | null): ExternalJobDraft {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const label = (re: RegExp): string => {
    for (const l of lines) { const m = re.exec(l); if (m && m[1]!.trim()) return m[1]!.trim().slice(0, 200); }
    return '';
  };
  const title = label(/^(?:job\s+)?title\s*[:\-–]\s*(.+)$/i) || label(/^position\s*[:\-–]\s*(.+)$/i) || (lines[0] && lines[0].length <= 120 ? lines[0] : '');
  if (!label(/^(?:job\s+)?title\s*[:\-–]\s*(.+)$/i) && !label(/^position\s*[:\-–]\s*(.+)$/i)) warnings.push('The title was taken from the first line. Check it.');
  const company = label(/^(?:company|employer|organization|organisation)\s*[:\-–]\s*(.+)$/i);
  if (!company) warnings.push('The text does not name the employer.');
  const location = label(/^(?:location|locations|office)\s*[:\-–]\s*(.+)$/i);
  const link = applyUrl ? safeHttpUrl(applyUrl) : null;
  if (applyUrl && !link) warnings.push('The apply link is not a web link and was left out.');
  if (!link) warnings.push('No apply link was given.');
  const p = parsePayFromText(text);
  void p; // pay from free text is parsed by the store path (paySource "text"); RawJob.pay is for board fields only
  return {
    sourceId: 'external:text',
    warnings,
    raw: rawJob({
      externalId: hashId(text.trim()), url: link ?? '', title: title ?? '', company, location,
      descriptionHtml: escapeHtml(text).replace(/\r?\n/g, '<br>'),
      remote: /\bremote\b/i.test(location), workMode: /\bremote\b/i.test(location) ? 'remote' : '',
      employmentType: employmentTypeOf(label(/^(?:employment\s+type|job\s+type|type)\s*[:\-–]\s*(.+)$/i)) ?? '',
    }),
  };
}
