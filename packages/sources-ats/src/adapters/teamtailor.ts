// Teamtailor: the RSS feed of the career site.
//   GET https://{company}.teamtailor.com/jobs.rss?offset={n}&per_page=100    (support.teamtailor.com, "RSS feed: how-to guide")
//   North America: {company}.na.teamtailor.com (region "na").
// Teamtailor: "By default, the RSS feed will show the first 100 jobs", with "offset" and "per_page" to read more.
// The adapter reads page after page until a page is short or empty. It FAILS the board (and so closes nothing) when a
// page cannot be read, when a page repeats jobs already read (a feed that never ends), or after 100 pages.
// robots.txt (career.teamtailor.com): "Content-Signal: search=yes, ai-train=no, ai-input=yes".
// Evidence and field map: docs/sources/teamtailor.md.

import { countryFromCode } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, RawJob, Source, WorkMode } from '@jobleft/crawler';
import { FeedFormatError, PagingError } from '../errors.ts';
import { atsHost, boardHost, normalRegion } from '../hosts.ts';
import { httpUrl, joinDistinct, placeText, postedIso, subdomainBoard, textField, textGetter, unreadableJob, unwrapEscapedHtml } from '../util.ts';
import { child, childText, children, parseXml, text } from '../xml.ts';
import type { XmlElement } from '../xml.ts';

export const TEAMTAILOR_PAGE_SIZE = 100;
export const TEAMTAILOR_MAX_PAGES = 100;
const ACCEPT = 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1';

export function teamtailorOrigin(board: string, region: string | null | undefined): string {
  return `https://${subdomainBoard('teamtailor', board)}.${atsHost('teamtailor', normalRegion('teamtailor', region))}`;
}
export function teamtailorPageUrl(board: string, region: string | null | undefined, offset: number): string {
  return `${teamtailorOrigin(board, region)}/jobs.rss?offset=${offset}&per_page=${TEAMTAILOR_PAGE_SIZE}`;
}

function workMode(status: string): WorkMode {
  switch (status.trim().toLowerCase()) {
    case 'fully': case 'remote': case 'full': return 'remote';
    case 'hybrid': return 'hybrid';
    case 'none': case 'onsite': case 'on_site': return 'onsite';
    default: return ''; // "temporary" and unknown values say nothing certain
  }
}

/** The job id in a Teamtailor job link (/jobs/8021334-account-executive), or ''. */
export function teamtailorJobId(link: string): string {
  const m = /\/jobs\/(\d+)(?:[-/?#]|$)/.exec(link);
  return m ? m[1] : '';
}

export function mapTeamtailorItem(item: XmlElement, board: BoardRef, company: string): RawJob {
  const link = httpUrl(childText(item, 'link'));
  const id = teamtailorJobId(link) || childText(item, 'guid');
  const title = textField(childText(item, 'title'));
  if (!id) return unreadableJob(board, 'no id');
  if (!title) return unreadableJob(board, 'no title');
  const locs = children(child(item, 'tt:locations'), 'tt:location');
  const location = joinDistinct(locs.map((l) => placeText(childText(l, 'tt:city') || childText(l, 'tt:name'), childText(l, 'tt:country'))), '; ');
  const countries: string[] = [];
  for (const l of locs) for (const c of countryFromCode(childText(l, 'tt:country'))) if (!countries.includes(c)) countries.push(c);
  const mode = workMode(childText(item, 'remoteStatus'));
  return {
    externalId: id,
    url: link,
    applyUrl: '',
    title,
    company,
    location,
    descriptionHtml: unwrapEscapedHtml(text(child(item, 'description'))),
    remote: mode === 'remote',
    workMode: mode,
    countries,
    postedAt: postedIso(childText(item, 'pubDate')),
    employmentType: '',
    department: textField(childText(item, 'tt:department')),
    pay: null,
  };
}

function channelOf(root: XmlElement, url: string): XmlElement {
  const channel = root.name === 'rss' ? child(root, 'channel') : null;
  if (!channel) throw new FeedFormatError(url, `the answer is XML but not the Teamtailor RSS feed (root <${root.name}>), so nothing was read`);
  return channel;
}

export const teamtailor: Source = {
  ats: 'teamtailor',
  // Every page is read and any page problem fails the whole board, so a returned list IS the whole board.
  fullBoardListing: true,
  host: (b: BoardRef) => boardHost(b),
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const t = textGetter(http, 'teamtailor');
    const out: RawJob[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let company = '';
    for (let page = 1; ; page++) {
      if (page > TEAMTAILOR_MAX_PAGES) {
        throw new PagingError(teamtailorPageUrl(board.board, board.region, offset),
          `the feed still had jobs after ${TEAMTAILOR_MAX_PAGES} pages (${out.length} jobs); stopped, and the board was not read in full`);
      }
      const url = teamtailorPageUrl(board.board, board.region, offset);
      const channel = channelOf(parseXml(await t.getText(url, ACCEPT), url), url);
      if (page === 1) company = textField(childText(channel, 'title')) || board.company;
      const items = children(channel, 'item');
      if (items.length === 0) break;
      let fresh = 0;
      items.forEach((item, idx) => {
        const key = childText(item, 'link') || childText(item, 'guid') || `#${offset + idx}`;
        if (seen.has(key)) return;
        seen.add(key);
        fresh++;
        out.push(mapTeamtailorItem(item, board, company));
      });
      if (fresh === 0) {
        throw new PagingError(url, `page ${page} only repeated jobs already read (the feed does not advance); the board was not read in full`);
      }
      if (items.length < TEAMTAILOR_PAGE_SIZE) break;
      offset += items.length;
    }
    return out;
  },
};
