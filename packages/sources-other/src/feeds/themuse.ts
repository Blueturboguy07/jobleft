// The Muse: the remote-jobs slice of GET https://www.themuse.com/api/public/jobs, 20 per page, with the person's own
// key (terms 2.2 require a registered app). The key travels only as the api_key URL parameter (the only way The Muse
// documents) and only to www.themuse.com; every text jobleft writes has it redacted. Notes: docs/sources/themuse.md.

import type { Level } from '@jobleft/contracts';
import type { FeedContext, FeedPosting, FeedResult, JobFeed } from '../types.ts';
import { FeedError, parseJsonBody, shapeError } from '../http.ts';
import { fixMojibake, placeFromText, safeHttpUrl } from '../text.ts';
import { HOUR, arr, countriesOf, creditFor, emptyFacts, ev, isoFrom, obj, rawJob, result, str } from './common.ts';

export const MUSE_BASE = 'https://www.themuse.com/api/public/jobs';
export const MUSE_SLICE = 'Flexible / Remote';
export const MUSE_CREDIT = creditFor('Job listing from The Muse', 'https://www.themuse.com/');
export const MUSE_MAX_PAGES = 400;

const LEVELS: Record<string, Level> = {
  internship: 'intern', 'entry level': 'entry', entry: 'entry', 'mid level': 'mid', mid: 'mid',
  'senior level': 'senior', senior: 'senior', management: 'manager',
};

export function museUrl(page: number, key: string): string {
  const q = new URLSearchParams({ page: String(page), location: MUSE_SLICE, api_key: key });
  return `${MUSE_BASE}?${q.toString()}`;
}

/** One page of The Muse answer. */
export interface MusePage { page: number; pageCount: number; postings: FeedPosting[]; unreadableIds: string[]; unreadableWithoutId: number }

export function parseMusePage(data: unknown, now: number): MusePage {
  const root = obj(data);
  const results = root ? arr(root.results) : null;
  if (!root || !results) throw shapeError('the answer has no "results" list');
  const pageCount = typeof root.page_count === 'number' ? root.page_count : NaN;
  const page = typeof root.page === 'number' ? root.page : NaN;
  if (!Number.isInteger(pageCount) || pageCount < 0 || !Number.isInteger(page)) throw shapeError('the answer has no page numbers');
  const postings: FeedPosting[] = [];
  const unreadableIds: string[] = [];
  let unreadableWithoutId = 0;
  for (const it of results) {
    const j = obj(it);
    const id = j ? str(j.id).trim() : '';
    if (!j || !id) { unreadableWithoutId++; continue; }
    const title = fixMojibake(str(j.name)).trim();
    const company = fixMojibake(str(obj(j.company)?.name)).trim();
    const url = safeHttpUrl(obj(j.refs)?.landing_page);
    if (!title || !company || !url) { unreadableIds.push(id); continue; }
    const facts = emptyFacts();
    const locs = (arr(j.locations) ?? []).map((l) => str(obj(l)?.name).trim()).filter(Boolean);
    const remote = locs.some((l) => /flexible\s*\/\s*remote|\bremote\b/i.test(l));
    const places = locs.map((l) => placeFromText(l)).filter((p): p is NonNullable<typeof p> => p !== null);
    facts.places = places;
    if (places.length) facts.evidence.places = ev('board_field', `locations: ${locs.join('; ')}`);
    if (remote) {
      facts.workModel = 'remote';
      facts.evidence.workModel = ev('board_field', `locations: ${locs.join('; ')}`);
      facts.remoteScope = { regions: [], text: MUSE_SLICE };
    }
    const countries = places.map((p) => p.country).filter((c): c is string => Boolean(c));
    if (countries.length && countries.length === places.length) facts.isUs = countries.includes('US');
    else if (countries.includes('US')) facts.isUs = true;
    const levels = (arr(j.levels) ?? []).map((l) => str(obj(l)?.name).trim()).filter(Boolean);
    // Several levels ("Entry Level" and "Mid Level") state a span, not one level: keep the lowest named.
    const mapped = levels.map((l) => LEVELS[l.toLowerCase()]).filter((l): l is Level => Boolean(l));
    if (mapped.length) {
      const order: Level[] = ['intern', 'entry', 'mid', 'senior', 'manager'];
      facts.level = order.find((o) => mapped.includes(o)) ?? mapped[0]!;
      facts.evidence.level = ev('board_field', `levels: ${levels.join(', ')}`);
    }
    if (facts.level === 'intern') { facts.employmentType = 'internship'; facts.evidence.employmentType = ev('board_field', 'levels: Internship'); }
    facts.postedAt = isoFrom(j.publication_date, now);
    postings.push({
      sourceUrl: url,
      facts,
      raw: rawJob({
        externalId: id, url, title, company, location: locs.join('; '), descriptionHtml: fixMojibake(str(j.contents)),
        remote, workMode: remote ? 'remote' : '', countries: countriesOf(facts), postedAt: facts.postedAt,
        employmentType: facts.employmentType ?? '',
        department: (arr(j.categories) ?? []).map((c) => str(obj(c)?.name)).filter(Boolean)[0] ?? '',
      }),
    });
  }
  if (results.length > 0 && postings.length === 0) throw shapeError(`none of the ${results.length} postings had an id, a title, a company and a link`);
  return { page, pageCount, postings, unreadableIds, unreadableWithoutId };
}

export const theMuse: JobFeed = {
  id: 'themuse',
  info: {
    id: 'themuse',
    name: 'The Muse',
    kind: 'job_board',
    crawled: true,
    reason: null,
    checkedOn: '2026-09-25',
    evidenceUrl: 'https://www.themuse.com/developers/api/v2/terms',
    needsKey: true,
    credit: MUSE_CREDIT,
    limits: 'Remote jobs only; at most 2 refreshes a day, at least 6 hours apart, at most 400 pages each (The Muse allows 3,600 requests an hour with a key)',
  },
  credit: MUSE_CREDIT,
  limits: { minIntervalMs: 6 * HOUR, maxPerDay: 2 },
  storable: true,
  hosts: ['www.themuse.com'],
  requestLimits: { perRun: MUSE_MAX_PAGES + 4, perDay: 900 },
  keyHelp: 'Register a free app at https://www.themuse.com/developers/api/v2/apps (The Muse terms 2.2 require it), copy its API key, and save it for The Muse in Settings > Sources (CLI: set JOBLEFT_SOURCE_KEY_THEMUSE).',
  checkKey(key: string): string | null {
    const k = key.trim();
    if (k.length < 8 || k.length > 200) return 'The Muse key should be 8 to 200 characters long';
    if (/\s/.test(k)) return 'The Muse key has no spaces';
    return null;
  },
  async fetch(ctx: FeedContext): Promise<FeedResult> {
    const key = (ctx.key ?? '').trim();
    if (!key) throw new FeedError('key_refused', 'The Muse needs a key');
    const postings: FeedPosting[] = [];
    const unreadableIds: string[] = [];
    let unreadableWithoutId = 0;
    let pageCount = 1;
    let read = 0;
    for (let page = 0; page < pageCount && page < MUSE_MAX_PAGES; page++) {
      let p: MusePage;
      try {
        const body = await ctx.http.getText(museUrl(page, key), 'application/json');
        p = parseMusePage(parseJsonBody(body, 'www.themuse.com'), ctx.now);
      } catch (e) {
        if (page === 0 || !(e instanceof FeedError)) throw e;
        // Later page failed: keep what was read, close nothing (complete: false), and say which page.
        return result(postings, {
          complete: false, unreadableIds, unreadableWithoutId,
          problem: `page ${page + 1} of ${pageCount} failed: ${e.message}`,
          notes: [`${read} of ${pageCount} pages were read; their jobs were kept and nothing was closed`],
        });
      }
      if (page === 0) pageCount = p.pageCount;
      postings.push(...p.postings);
      unreadableIds.push(...p.unreadableIds);
      unreadableWithoutId += p.unreadableWithoutId;
      read++;
    }
    const complete = read >= pageCount;
    const notes = complete ? [] : [`read ${read} of ${pageCount} pages (the limit per refresh is ${MUSE_MAX_PAGES}); nothing was closed`];
    return result(postings, { complete, unreadableIds, unreadableWithoutId, notes });
  },
};
