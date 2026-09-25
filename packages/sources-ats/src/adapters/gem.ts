// Gem: the Job Board API.
//   GET https://api.gem.com/job_board/v0/{vanity_url_path}/job_posts/     (api.gem.com/job_board/v0/reference)
// Gem: "Most endpoints in the Job Board API are public and do not require authentication — job board information can
// be read by anyone using your job board's vanity URL path." and "The Job Board API does not use pagination."
// Evidence and field map: docs/sources/gem.md.

import { arr, obj, str } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, RawJob, Source, WorkMode } from '@jobleft/crawler';
import { FeedFormatError } from '../errors.ts';
import { boardHost } from '../hosts.ts';
import { escapeHtml, httpUrl, joinDistinct, pathBoard, postedIso, textField, unreadableJob, cleanDescription } from '../util.ts';
import { polishSource } from '../polish.ts';

export const GEM_HOST = 'api.gem.com';

export function gemUrl(board: string): string {
  return `https://${GEM_HOST}/job_board/v0/${encodeURIComponent(pathBoard('gem', board))}/job_posts/`;
}

function workMode(t: string): WorkMode {
  switch (t.trim().toLowerCase()) {
    case 'in_office': case 'onsite': case 'on_site': return 'onsite';
    case 'hybrid': return 'hybrid';
    case 'remote': return 'remote';
    default: return '';
  }
}

function employmentType(t: string): string {
  switch (t.trim().toLowerCase()) {
    case 'full_time': return 'full_time';
    case 'part_time': return 'part_time';
    case 'intern': case 'internship': return 'internship';
    case 'contract': case 'temporary': return 'contract';
    default: return '';
  }
}

export function mapGem(p: Record<string, unknown>, board: BoardRef): RawJob {
  const id = typeof p.id === 'number' || typeof p.id === 'string' ? String(p.id).trim() : '';
  const title = textField(p.title);
  if (!id) return unreadableJob(board, 'no id');
  if (!title) return unreadableJob(board, 'no title');
  const offices = arr(p.offices).map(obj);
  const location = textField(obj(p.location).name)
    || joinDistinct(offices.map((o) => textField(obj(o.location).name) || textField(o.name)), '; ');
  const mode = workMode(str(p.location_type));
  const html = str(p.content);
  const plain = str(p.content_plain);
  const departments = arr(p.departments).map((d) => textField(obj(d).name)).filter(Boolean);
  return {
    externalId: id,
    url: httpUrl(p.absolute_url),
    applyUrl: '',
    title,
    company: board.company,
    location,
    descriptionHtml: cleanDescription(html) || (plain ? escapeHtml(plain).replace(/\n/g, '<br>') : ''),
    remote: mode === 'remote',
    workMode: mode,
    countries: [],
    postedAt: postedIso(p.first_published_at),
    employmentType: employmentType(str(p.employment_type)),
    department: departments[0] ?? '',
    pay: null,
  };
}

export const gem: Source = polishSource({
  ats: 'gem',
  fullBoardListing: true,
  host: (b: BoardRef) => boardHost(b),
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const url = gemUrl(board.board);
    const resp = await http.getJson(url);
    if (!Array.isArray(resp)) {
      throw new FeedFormatError(url, 'the Gem answer is not a list of job posts; the feed format may have changed, so nothing was read');
    }
    return resp.map((p) => mapGem(obj(p), board));
  },
});
