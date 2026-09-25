// Personio: the positions XML feed of the company career site.
//   GET https://{company}.jobs.personio.de/xml       (developer.personio.de/docs/retrieving-open-job-positions)
//   The same feed also answers on {company}.jobs.personio.com (region "com").
// One request returns every open position (no paging). The default-language feed lists every position; a position
// published only in another language can have empty description blocks, so the adapter reads the English feed
// once, only then, to fill those bodies (idea from freehire, MIT; see THIRD_PARTY_NOTICES.md).
// The job page is https://{company}.jobs.personio.de/job/{id} (Personio's own integration example).
// Evidence and field map: docs/sources/personio.md.

import type { BoardRef, HttpGetter, RawJob, Source } from '@jobleft/crawler';
import { FeedFormatError } from '../errors.ts';
import { atsHost, boardHost, normalRegion } from '../hosts.ts';
import { escapeHtml, joinDistinct, postedIso, subdomainBoard, textField, textGetter, unreadableJob, cleanDescription } from '../util.ts';
import { polishSource } from '../polish.ts';
import { child, childText, children, parseXml, text } from '../xml.ts';
import type { XmlElement } from '../xml.ts';

const ACCEPT = 'application/xml, text/xml;q=0.9, */*;q=0.1';

export function personioOrigin(board: string, region: string | null | undefined): string {
  return `https://${subdomainBoard('personio', board)}.${atsHost('personio', normalRegion('personio', region))}`;
}
export function personioUrl(board: string, region?: string | null, language?: string): string {
  return `${personioOrigin(board, region)}/xml${language ? `?language=${encodeURIComponent(language)}` : ''}`;
}

function employmentType(type: string, schedule: string): string {
  const t = type.trim().toLowerCase();
  const s = schedule.trim().toLowerCase();
  if (t === 'intern' || t === 'trainee' || t === 'working_student' || t === 'apprentice') return 'internship';
  if (t === 'freelance') return 'contract';
  if (s === 'part-time' || s === 'part_time') return 'part_time';
  if (s === 'full-time' || s === 'full_time') return 'full_time';
  return '';
}

/** The description blocks of one position as HTML, each under its own heading (the feed's own block names). */
export function personioBody(pos: XmlElement): string {
  let html = '';
  for (const d of children(child(pos, 'jobDescriptions'), 'jobDescription')) {
    const name = textField(childText(d, 'name'));
    const value = text(child(d, 'value'));
    if (!value) continue;
    if (name) html += `<h3>${escapeHtml(name)}</h3>`;
    html += value;
    html += '\n';
  }
  return html;
}

export function mapPersonio(pos: XmlElement, board: BoardRef, origin: string, bodyOverride?: string): RawJob {
  const id = childText(pos, 'id');
  const title = textField(childText(pos, 'name'));
  if (!id) return unreadableJob(board, 'no id');
  if (!title) return unreadableJob(board, 'no name');
  const offices = [childText(pos, 'office'), ...children(child(pos, 'additionalOffices'), 'office').map((o) => text(o))]
    .map(textField);
  const location = joinDistinct(offices, '; ');
  const body = personioBody(pos) || bodyOverride || '';
  return {
    externalId: id,
    url: `${origin}/job/${encodeURIComponent(id)}`,
    applyUrl: '',
    title,
    // The subcompany is the employing entity when the board has several; otherwise the board's employer.
    company: textField(childText(pos, 'subcompany')) || board.company,
    location,
    descriptionHtml: cleanDescription(body),
    remote: false, // the feed has no remote field; the crawler still reads "Remote" in the office text
    workMode: '',
    countries: [],
    // The feed's only date. Personio calls it createdAt (when the position was created).
    postedAt: postedIso(childText(pos, 'createdAt')),
    employmentType: employmentType(childText(pos, 'employmentType'), childText(pos, 'schedule')),
    department: textField(childText(pos, 'department')),
    pay: null,
  };
}

function positionsOf(root: XmlElement, url: string): XmlElement[] {
  const positions = children(root, 'position');
  if (root.name !== 'workzag-jobs' && positions.length === 0) {
    throw new FeedFormatError(url, `the answer is XML but not the Personio positions feed (root <${root.name}>), so nothing was read`);
  }
  return positions;
}

export const personio: Source = polishSource({
  ats: 'personio',
  fullBoardListing: true,
  host: (b: BoardRef) => boardHost(b),
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const origin = personioOrigin(board.board, board.region);
    const url = `${origin}/xml`;
    const t = textGetter(http, 'personio');
    const positions = positionsOf(parseXml(await t.getText(url, ACCEPT), url), url);

    // Fill empty bodies from the English feed, once, best effort. The position list itself never depends on it.
    let english: Map<string, string> | null = null;
    if (positions.some((p) => childText(p, 'id') && !personioBody(p))) {
      try {
        const enUrl = `${origin}/xml?language=en`;
        const en = positionsOf(parseXml(await t.getText(enUrl, ACCEPT), enUrl), enUrl);
        english = new Map(en.map((p) => [childText(p, 'id'), personioBody(p)]));
      } catch {
        english = null;
      }
    }
    return positions.map((p) => mapPersonio(p, board, origin, english?.get(childText(p, 'id'))));
  },
});
