// Workable: the public account endpoint that Workable documents for building a careers page.
//   Documented:  GET https://www.workable.com/api/accounts/{subdomain}?details=true   (workable.readme.io, help.workable.com)
//   That URL answers 302 to the host below, and jobleft never follows redirects, so the adapter asks it directly:
//   GET https://apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true
// One request returns the whole board (no paging). Evidence and field map: docs/sources/workable.md.
// robots.txt (apply.workable.com): "Content-Signal: search=yes, ai-input=yes, ai-train=no" -> never train a model on it.

import { arr, countryFromCode, employmentTypeFromText, obj, str } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, RawJob, Source, WorkMode } from '@jobleft/crawler';
import { FeedFormatError } from '../errors.ts';
import { boardHost } from '../hosts.ts';
import { countryCodes, httpUrl, joinDistinct, pathBoard, placeText, postedIso, textField, unreadableJob, cleanDescription } from '../util.ts';
import { polishSource } from '../polish.ts';

export const WORKABLE_HOST = 'apply.workable.com';

export function workableUrl(board: string): string {
  return `https://${WORKABLE_HOST}/api/v1/widget/accounts/${encodeURIComponent(pathBoard('workable', board))}?details=true`;
}

function workMode(workplaceType: string, telecommuting: unknown): WorkMode {
  switch (workplaceType.trim().toLowerCase()) {
    case 'remote': return 'remote';
    case 'hybrid': return 'hybrid';
    case 'on_site': case 'onsite': case 'on-site': return 'onsite';
    default: return telecommuting === true ? 'remote' : '';
  }
}

/** One Workable job as the widget endpoint lists it. `account` is the top-level answer (its `name` is the employer). */
export function mapWorkable(j: Record<string, unknown>, board: BoardRef, account: Record<string, unknown> = {}): RawJob {
  const shortcode = str(j.shortcode).trim() || (typeof j.id === 'number' || typeof j.id === 'string' ? String(j.id).trim() : '');
  const title = textField(j.title);
  if (!shortcode) return unreadableJob(board, 'no shortcode');
  if (!title) return unreadableJob(board, 'no title');
  const slug = board.board.trim();

  // A location marked hidden shows only its country: the employer chose not to publish the city.
  const locs = arr(j.locations).map(obj);
  const places = locs.map((l) => (l.hidden === true
    ? placeText(l.country)
    : placeText(l.city, l.region ?? l.state, l.country)));
  let location = joinDistinct(places, '; ');
  if (!location && locs.length === 0) location = placeText(j.city, j.state, j.country);
  let countries = countryCodes(locs.map((l) => l.countryCode ?? l.country_code));
  if (countries.length === 0 && str(j.country)) countries = countryFromCode(str(j.country));

  const mode = workMode(str(j.workplace_type), j.telecommuting);
  const remote = mode === 'remote';

  let description = str(j.description);
  if (str(j.requirements)) description += `<h3>Requirements</h3>${str(j.requirements)}`;
  if (str(j.benefits)) description += `<h3>Benefits</h3>${str(j.benefits)}`;

  return {
    externalId: shortcode,
    url: httpUrl(j.url) || httpUrl(j.shortlink) || `https://${WORKABLE_HOST}/${encodeURIComponent(slug)}/j/${encodeURIComponent(shortcode)}/`,
    applyUrl: httpUrl(j.application_url),
    title,
    company: textField(account.name) || board.company,
    location,
    descriptionHtml: cleanDescription(description),
    remote,
    workMode: mode,
    countries,
    postedAt: postedIso(j.published_on),
    employmentType: employmentTypeFromText(str(j.employment_type) || str(j.type)),
    department: textField(j.department),
    // The widget endpoint has no pay field. Pay stated in the text is read by the crawler (paySource "text").
    pay: null,
  };
}

export const workable: Source = polishSource({
  ats: 'workable',
  fullBoardListing: true,
  host: (b: BoardRef) => boardHost(b),
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const url = workableUrl(board.board);
    const resp = await http.getJson(url);
    if (!resp || typeof resp !== 'object' || Array.isArray(resp) || !Array.isArray((resp as { jobs?: unknown }).jobs)) {
      throw new FeedFormatError(url, 'the Workable answer has no "jobs" list; the feed format may have changed, so nothing was read');
    }
    const account = resp as Record<string, unknown>;
    return mergeByShortcode(arr(account.jobs).map((j) => mapWorkable(obj(j), board, account)));
  },
});

/**
 * Workable lists a job once per location, with the same shortcode each time (seen live on 2026-09-25: one
 * "Management Trainee" row each for College Station, Dallas, San Antonio and Austin). That is ONE posting with
 * several places, so the rows are merged: the first row's fields, every row's places and countries.
 */
export function mergeByShortcode(jobs: RawJob[]): RawJob[] {
  const out: RawJob[] = [];
  const byId = new Map<string, RawJob>();
  for (const j of jobs) {
    if (j.unreadable || !j.externalId) { out.push(j); continue; }
    const first = byId.get(j.externalId);
    if (!first) { const copy = { ...j, countries: [...j.countries] }; byId.set(j.externalId, copy); out.push(copy); continue; }
    first.location = joinDistinct([...first.location.split('; '), ...j.location.split('; ')].filter(Boolean), '; ');
    for (const c of j.countries) if (!first.countries.includes(c)) first.countries.push(c);
    if (first.workMode !== j.workMode) first.workMode = first.workMode || j.workMode;
    first.remote = first.remote || j.remote;
  }
  return out;
}
