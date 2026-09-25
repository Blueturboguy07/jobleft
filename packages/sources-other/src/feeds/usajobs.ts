// USAJOBS: NOT CRAWLED until the owner decides. robots.txt on data.usajobs.gov says "Disallow: /" for every crawler
// (checked 2026-09-25). The adapter, the key format and the fixtures are ready. When allowed, the person's secret is
// "<registered email> <API key>": the key goes only in the Authorization-Key header and the email only in the
// User-Agent header, and only to data.usajobs.gov (the source's own documented requirement, sources-other O11).
// Notes: docs/sources/usajobs.md.

import type { EmploymentType, PayPeriod, Place } from '@jobleft/contracts';
import type { FeedContext, FeedPosting, FeedResult, JobFeed } from '../types.ts';
import { FeedError, parseJsonBody, shapeError } from '../http.ts';
import { countryCode, makePay, plainLine, safeHttpUrl } from '../text.ts';
import { HOUR, arr, countriesOf, emptyFacts, ev, formatProblem, isoFrom, missingFields, obj, rawJob, rawPayOf, result, str } from './common.ts';

export const USAJOBS_BASE = 'https://data.usajobs.gov/api/Search';
export const USAJOBS_PAGE_SIZE = 500;
export const USAJOBS_MAX_PAGES = 20; // the 10,000-row cap per query

const RATE: Record<string, PayPeriod> = { PA: 'year', PH: 'hour', PD: 'day', PW: 'week', PM: 'month' };

export function usajobsUrl(page: number): string {
  const q = new URLSearchParams({ ResultsPerPage: String(USAJOBS_PAGE_SIZE), Page: String(page), SortField: 'opendate', SortDirection: 'desc' });
  return `${USAJOBS_BASE}?${q.toString()}`;
}

/** Splits the saved secret into the registered email and the API key (either order, any whitespace). */
export function parseUsajobsSecret(secret: string | null): { email: string; key: string } | null {
  const parts = (secret ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const email = parts.find((p) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p));
  const key = parts.find((p) => p !== email);
  if (!email || !key) return null;
  return { email, key };
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/,/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function placeOf(l: Record<string, unknown>): Place | null {
  const text = str(l.LocationName).trim() || str(l.CityName).trim();
  if (!text) return null;
  if (/anywhere in the u\.?s\.?|remote job|negotiable after selection/i.test(text)) return null;
  const cityName = str(l.CityName).trim();
  const place: Place = {
    text,
    city: cityName ? cityName.split(',')[0]!.trim() || null : null,
    region: str(l.CountrySubDivisionCode).trim() || null,
    country: countryCode(str(l.CountryCode)),
    placeId: null,
  };
  const lat = typeof l.Latitude === 'number' ? l.Latitude : null;
  const lon = typeof l.Longitude === 'number' ? l.Longitude : null;
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) { place.lat = lat; place.lon = lon; }
  return place;
}

export interface UsajobsPage { countAll: number; postings: FeedPosting[]; unreadableIds: string[]; unreadableWithoutId: number; expired: number; items: number; problem?: string }

export function parseUsajobsPage(data: unknown, now: number): UsajobsPage {
  const sr = obj(obj(data)?.SearchResult);
  const items = sr ? arr(sr.SearchResultItems) : null;
  if (!sr || !items) throw shapeError('the answer has no "SearchResult.SearchResultItems" list');
  const countAll = typeof sr.SearchResultCountAll === 'number' ? sr.SearchResultCountAll : Number(sr.SearchResultCountAll ?? NaN);
  const postings: FeedPosting[] = [];
  const unreadableIds: string[] = [];
  let unreadableWithoutId = 0;
  let expired = 0;
  for (const it of items) {
    const item = obj(it);
    const d = obj(item?.MatchedObjectDescriptor);
    const id = (str(item?.MatchedObjectId) || str(d?.PositionID)).trim();
    if (!d || !id) { unreadableWithoutId++; continue; }
    const title = plainLine(str(d.PositionTitle));
    const company = plainLine(str(d.OrganizationName)) || plainLine(str(d.DepartmentName));
    const url = safeHttpUrl(d.PositionURI);
    if (!title || !company || !url) { unreadableIds.push(id); continue; }
    const closes = isoFrom(d.ApplicationCloseDate, Number.POSITIVE_INFINITY);
    if (closes && Date.parse(closes) < now) { expired++; continue; } // closed by its own date: not listed any more
    const details = obj(obj(d.UserArea)?.Details) ?? {};
    const facts = emptyFacts();
    const locs = (arr(d.PositionLocation) ?? []).map((l) => obj(l)).filter((l): l is Record<string, unknown> => l !== null);
    facts.places = locs.map(placeOf).filter((p): p is Place => p !== null);
    const display = str(d.PositionLocationDisplay).trim();
    if (facts.places.length) facts.evidence.places = ev('board_field', `PositionLocation: ${display || facts.places.map((p) => p.text).join('; ')}`);
    const remoteText = /anywhere in the u\.?s\.?|remote job/i.test(display + ' ' + locs.map((l) => str(l.LocationName)).join(' '));
    const remoteFlag = typeof details.RemoteIndicator === 'boolean' ? details.RemoteIndicator : null;
    const telework = typeof details.TeleworkEligible === 'boolean' ? details.TeleworkEligible : null;
    if (remoteFlag === true || remoteText) {
      facts.workModel = 'remote';
      facts.evidence.workModel = ev('board_field', remoteFlag === true ? 'RemoteIndicator: true' : `PositionLocationDisplay: ${display}`);
      facts.remoteScope = { regions: ['US'], text: display || 'Anywhere in the U.S. (remote job)' };
      facts.evidence.remoteScope = ev('board_field', display || 'RemoteIndicator: true');
    } else if (remoteFlag === false && telework === true) {
      facts.workModel = 'hybrid';
      facts.evidence.workModel = ev('board_field', 'RemoteIndicator: false, TeleworkEligible: true');
    } else if (remoteFlag === false && telework === false) {
      facts.workModel = 'onsite';
      facts.evidence.workModel = ev('board_field', 'RemoteIndicator: false, TeleworkEligible: false');
    }
    const countries = facts.places.map((p) => p.country).filter(Boolean);
    facts.isUs = countries.includes('US') || facts.remoteScope !== null ? true : countries.length ? false : null;
    const rem = obj((arr(d.PositionRemuneration) ?? [])[0]);
    let payNote = '';
    if (rem) {
      const code = str(rem.RateIntervalCode).trim().toUpperCase();
      const period = RATE[code];
      const lo = numOrNull(rem.MinimumRange), hi = numOrNull(rem.MaximumRange);
      if (period && (lo !== null || hi !== null)) {
        facts.pay = makePay(lo ?? hi, hi ?? lo, 'USD', period, 'board_field');
        facts.evidence.pay = ev('board_field', `PositionRemuneration: ${str(rem.MinimumRange)} to ${str(rem.MaximumRange)} ${str(rem.Description) || code}`);
      } else if (lo !== null || hi !== null) {
        payNote = `Pay: ${str(rem.MinimumRange)} to ${str(rem.MaximumRange)} ${str(rem.Description) || code}`.trim();
      }
    }
    const schedule = str(obj((arr(d.PositionSchedule) ?? [])[0])?.Name);
    const offering = str(obj((arr(d.PositionOfferingType) ?? [])[0])?.Name);
    let et: EmploymentType | null = null;
    if (/intern/i.test(offering)) et = 'internship';
    else if (/full/i.test(schedule)) et = 'full_time';
    else if (/part/i.test(schedule)) et = 'part_time';
    else if (/intermittent/i.test(schedule)) et = 'other';
    if (et) { facts.employmentType = et; facts.evidence.employmentType = ev('board_field', `PositionSchedule: ${schedule}; PositionOfferingType: ${offering}`); }
    facts.postedAt = isoFrom(d.PublicationStartDate, now);
    const plan = str(obj((arr(d.JobGrade) ?? [])[0])?.Code).trim();
    const low = str(details.LowGrade).trim(), high = str(details.HighGrade).trim();
    const lines: string[] = [];
    if (plan && (low || high)) lines.push(`Pay grade: ${plan}-${low || high}${high && high !== low ? ` to ${plan}-${high}` : ''}`);
    if (payNote) lines.push(payNote);
    if (closes) lines.push(`Applications close: ${closes.slice(0, 10)}`);
    const summary = str(details.JobSummary);
    const duties = arr(details.MajorDuties)?.map(str).join('\n') ?? str(details.MajorDuties);
    const quals = str(d.QualificationSummary);
    const html = [lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''), summary, duties, quals].filter(Boolean).join('\n\n');
    const apply = safeHttpUrl((arr(d.ApplyURI) ?? [])[0]);
    postings.push({
      sourceUrl: url,
      facts,
      raw: rawJob({
        externalId: id, url, applyUrl: apply && apply !== url ? apply : '', title, company,
        location: display, descriptionHtml: html, remote: facts.workModel === 'remote',
        workMode: facts.workModel ?? '', countries: countriesOf(facts), postedAt: facts.postedAt,
        employmentType: et ?? '', department: str(d.DepartmentName).trim(), pay: rawPayOf(facts),
      }),
    });
  }
  const problem = formatProblem(missingFields(items.map((i) => obj(i)?.MatchedObjectDescriptor), ['PositionTitle', 'PositionURI', 'OrganizationName', 'PositionLocation', 'PublicationStartDate', 'PositionRemuneration']));
  return { countAll: Number.isFinite(countAll) ? countAll : NaN, postings, unreadableIds, unreadableWithoutId, expired, items: items.length, ...(problem ? { problem } : {}) };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const usajobs: JobFeed = {
  id: 'usajobs',
  info: {
    id: 'usajobs',
    name: 'USAJOBS',
    kind: 'government',
    crawled: false,
    reason: 'robots.txt on data.usajobs.gov disallows every path for every crawler (checked 2026-09-25); the adapter is ready, but turning it on needs the owner\'s decision',
    checkedOn: '2026-09-25',
    evidenceUrl: 'https://data.usajobs.gov/robots.txt',
    needsKey: true,
    credit: null,
    limits: 'At most 4 refreshes a day, at least 6 hours apart; at most 10,000 rows (20 pages of 500) each',
  },
  credit: null,
  limits: { minIntervalMs: 6 * HOUR, maxPerDay: 4 },
  storable: true,
  hosts: ['data.usajobs.gov'],
  requestLimits: { perRun: USAJOBS_MAX_PAGES + 4, perDay: 100 },
  keyHelp: 'Request a free API key at https://developer.usajobs.gov/apirequest/ with your email, then save "<that email> <the key>" (two words) for USAJOBS in Settings > Sources (CLI: set JOBLEFT_SOURCE_KEY_USAJOBS). USAJOBS asks for that email in every request; jobleft sends it only to data.usajobs.gov.',
  checkKey(key: string): string | null {
    return parseUsajobsSecret(key) ? null : 'USAJOBS needs two words: the email you registered with and the API key, for example "you@example.com ABCD1234"';
  },
  async fetch(ctx: FeedContext): Promise<FeedResult> {
    const secret = parseUsajobsSecret(ctx.key);
    if (!secret) throw new FeedError('key_refused', 'USAJOBS needs the registered email and the API key');
    if (!ctx.http.request) throw new FeedError('network', 'this network client cannot send the headers USAJOBS requires');
    const postings: FeedPosting[] = [];
    const unreadableIds: string[] = [];
    let unreadableWithoutId = 0, skipped = 0, rows = 0, countAll = NaN;
    let problem: string | undefined;
    for (let page = 1; page <= USAJOBS_MAX_PAGES; page++) {
      let p: UsajobsPage;
      try {
        const res = await ctx.http.request(usajobsUrl(page), {
          accept: 'application/json',
          headers: { 'authorization-key': secret.key },
          userAgent: secret.email,
        });
        p = parseUsajobsPage(parseJsonBody(res.body, 'data.usajobs.gov'), ctx.now);
      } catch (e) {
        if (page === 1 || !(e instanceof FeedError)) throw e;
        return result(postings, { complete: false, unreadableIds, unreadableWithoutId, skipped, problem: `page ${page} failed: ${e.message}` });
      }
      if (page === 1) countAll = p.countAll;
      problem ??= p.problem;
      postings.push(...p.postings);
      unreadableIds.push(...p.unreadableIds);
      unreadableWithoutId += p.unreadableWithoutId;
      skipped += p.expired;
      rows += p.items;
      if (p.items < USAJOBS_PAGE_SIZE || (Number.isFinite(countAll) && rows >= countAll)) break;
    }
    const complete = (Number.isFinite(countAll) ? rows >= countAll : false) && !problem;
    return result(postings, {
      complete, unreadableIds, unreadableWithoutId, skipped, problem,
      notes: complete ? [] : [`read ${rows} of ${Number.isFinite(countAll) ? countAll : 'an unknown number of'} rows; nothing was closed`],
    });
  },
};
