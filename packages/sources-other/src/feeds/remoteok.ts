// Remote OK: one GET of https://remoteok.com/api returns the whole feed. The first element is the legal notice.
// Terms (in the feed): link back to the job's URL on Remote OK and mention Remote OK as the source.
// Notes: docs/sources/remoteok.md.

import type { FeedContext, FeedPosting, FeedResult, JobFeed } from '../types.ts';
import { parseJsonBody, shapeError } from '../http.ts';
import { fixMojibake, makePay, plainLine, parseRemoteScope, placeFromText, safeHttpUrl, scopeOpenToUs } from '../text.ts';
import { HOUR, countriesOf, creditFor, emptyFacts, ev, isoFrom, obj, rawJob, rawPayOf, result, str } from './common.ts';

export const REMOTEOK_URL = 'https://remoteok.com/api';
export const REMOTEOK_CREDIT = creditFor('Found on Remote OK', 'https://remoteok.com/');

function salaryPart(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Maps a parsed Remote OK answer. Pure. Throws a shape error when the answer is not the feed. */
export function parseRemoteOk(data: unknown, now: number): FeedResult {
  if (!Array.isArray(data)) throw shapeError('the answer is not a list of postings');
  const first = obj(data[0]);
  const hasNotice = first !== null && typeof first.legal === 'string';
  const items = hasNotice ? data.slice(1) : data;
  const postings: FeedPosting[] = [];
  const unreadableIds: string[] = [];
  let unreadableWithoutId = 0;
  for (const it of items) {
    const j = obj(it);
    if (!j) { unreadableWithoutId++; continue; }
    const id = str(j.id).trim() || str(j.slug).trim();
    const title = plainLine(str(j.position));
    const company = plainLine(str(j.company));
    const url = safeHttpUrl(j.url) ?? safeHttpUrl(j.apply_url);
    if (!id) { unreadableWithoutId++; continue; }
    if (!title || !company || !url) { unreadableIds.push(id); continue; }
    const apply = safeHttpUrl(j.apply_url);
    const location = fixMojibake(str(j.location)).trim();
    const facts = emptyFacts();
    facts.workModel = 'remote';
    facts.evidence.workModel = ev('board_field', 'Remote OK lists remote jobs only');
    const scope = parseRemoteScope(location);
    if (scope) {
      facts.remoteScope = scope;
      facts.evidence.remoteScope = ev('board_field', `Remote OK "Job is restricted to locations?": ${location}`);
      const pl = placeFromText(location);
      if (pl && (pl.city || pl.region || pl.country)) facts.places = [pl];
    }
    facts.isUs = scopeOpenToUs(scope);
    const min = salaryPart(j.salary_min), max = salaryPart(j.salary_max);
    if (min !== null || max !== null) {
      const lo = min ?? max, hi = max ?? min;
      facts.pay = makePay(lo, hi, 'USD', 'year', 'board_field');
      facts.evidence.pay = ev('board_field', `salary_min ${min ?? 'not stated'}, salary_max ${max ?? 'not stated'} (Remote OK asks for annual pay in USD or USD equivalent)`);
    }
    facts.postedAt = isoFrom(j.date, now) ?? isoFrom(j.epoch, now);
    const description = fixMojibake(str(j.description));
    postings.push({
      sourceUrl: url,
      facts,
      raw: rawJob({
        externalId: id,
        url,
        applyUrl: apply && apply !== url ? apply : '',
        title,
        company,
        location,
        descriptionHtml: description,
        remote: true,
        workMode: 'remote',
        countries: countriesOf(facts),
        postedAt: facts.postedAt,
        pay: rawPayOf(facts),
      }),
    });
  }
  if (items.length > 0 && postings.length === 0) {
    throw shapeError(`none of the ${items.length} postings had an id, a title, a company and a link`);
  }
  return result(postings, { complete: true, unreadableIds, unreadableWithoutId, notes: hasNotice ? [] : ['the legal notice was missing from the answer'] });
}

export const remoteOk: JobFeed = {
  id: 'remoteok',
  info: {
    id: 'remoteok',
    name: 'Remote OK',
    kind: 'job_board',
    crawled: true,
    reason: null,
    checkedOn: '2026-09-25',
    evidenceUrl: 'https://remoteok.com/api',
    needsKey: false,
    credit: REMOTEOK_CREDIT,
    limits: 'At most 4 refreshes a day, at least 1 hour apart (Remote OK asks for a 1-second crawl delay)',
  },
  credit: REMOTEOK_CREDIT,
  limits: { minIntervalMs: 1 * HOUR, maxPerDay: 4 },
  storable: true,
  hosts: ['remoteok.com'],
  requestLimits: { perRun: 4, perDay: 16 },
  async fetch(ctx: FeedContext): Promise<FeedResult> {
    const body = await ctx.http.getText(REMOTEOK_URL, 'application/json');
    return parseRemoteOk(parseJsonBody(body, 'remoteok.com'), ctx.now);
  },
};
