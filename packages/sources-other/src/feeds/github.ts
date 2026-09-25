// Community job lists on GitHub (raw.githubusercontent.com):
//   * JSON lists (SimplifyJobs, vanshb03): .github/scripts/listings.json, one conditional GET per refresh
//   * speedyapply markdown tables: four files per repository, columns found by the header row
// jobleft keeps facts only (company, title, places, dates, links, the list's sponsorship note), never the prose.
// Notes, licences and the repository renames: docs/sources/github-lists.md.

import { createHash } from 'node:crypto';
import type { Place, PostingStatements } from '@jobleft/contracts';
import { canonicalizeUrl } from '@jobleft/crawler';
import { decodeEntities } from '@jobleft/parsers';
import type { FeedContext, FeedFacts, FeedPosting, FeedResult, JobFeed } from '../types.ts';
import { FeedError, parseJsonBody, shapeError } from '../http.ts';
import { employmentTypeOf, parseRemoteScope, payFromSalaryField, placeFromText, plainLine, safeHttpUrl, scopeOpenToUs } from '../text.ts';
import { HOUR, arr, countriesOf, creditFor, emptyFacts, ev, formatProblem, isoFrom, missingFields, obj, rawJob, rawPayOf, result, str } from './common.ts';

export interface GithubList {
  id: string;
  name: string;
  repo: string;
  branch: string;
  format: 'json' | 'markdown';
  /** For markdown lists: the files to read (all must be read for the answer to be complete). */
  files: string[];
  licence: string | null;
  /** The name the plan used, when the repository was renamed since. */
  formerly: string | null;
}

export const GITHUB_LISTS: readonly GithubList[] = [
  { id: 'gh-simplify-internships', name: 'SimplifyJobs Summer 2027 internships (GitHub)', repo: 'SimplifyJobs/Summer2027-Internships', branch: 'dev', format: 'json', files: ['.github/scripts/listings.json'], licence: null, formerly: 'SimplifyJobs/Summer2026-Internships' },
  { id: 'gh-vanshb03-internships', name: 'vanshb03 Summer 2027 internships (GitHub)', repo: 'vanshb03/Summer2027-Internships', branch: 'dev', format: 'json', files: ['.github/scripts/listings.json'], licence: 'MIT', formerly: 'vanshb03/Summer2026-Internships' },
  { id: 'gh-vanshb03-newgrad', name: 'vanshb03 New Grad 2027 (GitHub)', repo: 'vanshb03/New-Grad-2027', branch: 'dev', format: 'json', files: ['.github/scripts/listings.json'], licence: 'MIT', formerly: 'vanshb03/New-Grad-2026' },
  { id: 'gh-speedyapply-swe', name: 'speedyapply 2027 SWE college jobs (GitHub)', repo: 'speedyapply/2027-SWE-College-Jobs', branch: 'main', format: 'markdown', files: ['README.md', 'NEW_GRAD_USA.md', 'INTERN_INTL.md', 'NEW_GRAD_INTL.md'], licence: null, formerly: 'speedyapply/2026-SWE-College-Jobs' },
  { id: 'gh-speedyapply-ai', name: 'speedyapply 2027 AI/ML college jobs (GitHub)', repo: 'speedyapply/2027-AI-College-Jobs', branch: 'main', format: 'markdown', files: ['README.md', 'NEW_GRAD_USA.md', 'INTERN_INTL.md', 'NEW_GRAD_INTL.md'], licence: null, formerly: 'speedyapply/2026-AI-College-Jobs' },
];

export const rawUrl = (l: GithubList, file: string): string => `https://raw.githubusercontent.com/${l.repo}/${l.branch}/${file}`;

function listCredit(l: GithubList) {
  return creditFor(`Listed in ${l.repo} on GitHub${l.licence ? ` (${l.licence} licence)` : ''}`, `https://github.com/${l.repo}`);
}

function statementsOf(v: string): { statements: PostingStatements; text: string } | null {
  const t = v.trim();
  if (/^offers sponsorship$/i.test(t)) return { statements: { sponsorship: 'yes', clearanceRequired: null, usCitizenOnly: null }, text: t };
  if (/^does not offer sponsorship$/i.test(t)) return { statements: { sponsorship: 'no', clearanceRequired: null, usCitizenOnly: null }, text: t };
  if (/citizenship is required/i.test(t)) return { statements: { sponsorship: null, clearanceRequired: null, usCitizenOnly: true }, text: t };
  return null;
}

/** Work model, remote scope and places from list locations ("Remote in USA", "New York, NY", "Remote"). */
function locationFacts(facts: FeedFacts, locs: string[], label: string): void {
  const remoteLocs = locs.filter((l) => /\bremote\b/i.test(l));
  const cityLocs = locs.filter((l) => !/\bremote\b/i.test(l));
  facts.places = cityLocs.map((l) => placeFromText(l)).filter((p): p is Place => p !== null);
  if (facts.places.length) facts.evidence.places = ev('board_field', `${label}: ${locs.join('; ')}`);
  if (remoteLocs.length) {
    const scope = parseRemoteScope(remoteLocs.join('; '));
    if (scope) { facts.remoteScope = scope; facts.evidence.remoteScope = ev('board_field', `${label}: ${remoteLocs.join('; ')}`); }
    if (!cityLocs.length) { facts.workModel = 'remote'; facts.evidence.workModel = ev('board_field', `${label}: ${remoteLocs.join('; ')}`); }
  }
  const countries = facts.places.map((p) => p.country).filter((c): c is string => Boolean(c));
  const scopeUs = scopeOpenToUs(facts.remoteScope);
  if (countries.includes('US') || scopeUs === true) facts.isUs = true;
  else if ((countries.length && countries.length === facts.places.length && !facts.remoteScope) || (scopeUs === false && !cityLocs.length)) facts.isUs = false;
}

/** Maps a listings.json answer (SimplifyJobs, vanshb03). Pure. */
export function parseListings(data: unknown, list: GithubList, now: number): FeedResult {
  const rows = Array.isArray(data) ? data : arr(obj(data)?.listings) ?? arr(obj(data)?.jobs);
  if (!rows) throw shapeError('the list file is not a list of postings');
  const postings: FeedPosting[] = [];
  const unreadableIds: string[] = [];
  let unreadableWithoutId = 0, skipped = 0;
  let sawFields = rows.length === 0;
  for (const it of rows) {
    const j = obj(it);
    if (!j) { unreadableWithoutId++; continue; }
    if ('company_name' in j && 'title' in j && 'url' in j) sawFields = true;
    const id = str(j.id).trim();
    if (!id) { unreadableWithoutId++; continue; }
    if (j.active === false || j.is_visible === false) { skipped++; continue; } // not listed any more
    const company = plainLine(str(j.company_name));
    const title = plainLine(str(j.title));
    const url = safeHttpUrl(j.url);
    if (!company || !title || !url) { unreadableIds.push(id); continue; }
    const facts = emptyFacts();
    const locs = (arr(j.locations) ?? []).map(str).map((s) => s.trim()).filter(Boolean);
    locationFacts(facts, locs, 'locations');
    const st = statementsOf(str(j.sponsorship));
    if (st) {
      facts.statements = st.statements;
      if (st.statements.sponsorship) facts.evidence.sponsorship = ev('board_field', `sponsorship: ${st.text}`);
      if (st.statements.usCitizenOnly) facts.evidence.usCitizenOnly = ev('board_field', `sponsorship: ${st.text}`);
    }
    facts.postedAt = isoFrom(j.date_posted, now);
    const seasons = (arr(j.terms) ?? []).map(str).filter(Boolean);
    if (!seasons.length && str(j.season)) seasons.push(str(j.season));
    const degrees = (arr(j.degrees) ?? []).map(str).filter(Boolean);
    const et = employmentTypeOf(title) ?? (/internship/i.test(list.repo) ? 'internship' : null);
    if (et) { facts.employmentType = et; facts.evidence.employmentType = ev(employmentTypeOf(title) ? 'title' : 'board_field', employmentTypeOf(title) ? title : `listed in ${list.repo}`); }
    const lines = [
      `Listed in ${list.repo} on GitHub.`,
      seasons.length ? `Season: ${seasons.join(', ')}` : '',
      degrees.length ? `Degrees: ${degrees.join(', ')}` : '',
      st ? `Sponsorship (as the list states it): ${st.text}` : '',
    ].filter(Boolean);
    postings.push({
      sourceUrl: url,
      facts,
      raw: rawJob({
        externalId: id, url, title, company, location: locs.join('; '),
        descriptionHtml: lines.map((l) => `<p>${l.replace(/</g, '&lt;')}</p>`).join(''),
        remote: facts.workModel === 'remote', workMode: facts.workModel ?? '', countries: countriesOf(facts),
        postedAt: facts.postedAt, employmentType: et ?? '', department: str(j.category).trim(),
      }),
    });
  }
  if (!sawFields) throw shapeError('the rows have no "company_name", "title" and "url" fields');
  if (rows.length - skipped > 0 && postings.length === 0) throw shapeError(`none of the ${rows.length - skipped} active rows had an id, a company, a title and a link`);
  const problem = formatProblem(missingFields(rows, ['id', 'company_name', 'title', 'url', 'locations', 'date_posted', 'active']));
  return result(postings, { complete: !problem, unreadableIds, unreadableWithoutId, skipped, problem });
}

// ---------------------------------------------------------------------------------------------------------------
// speedyapply markdown

function cellText(cell: string): string {
  return decodeEntities(cell.replace(/<[^>]+>/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '')).replace(/\s+/g, ' ').trim();
}

function cellLink(cell: string): string | null {
  const hrefs: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']|\]\((https?:\/\/[^)\s]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell)) !== null) hrefs.push(decodeEntities(m[1] ?? m[2] ?? ''));
  for (const h of hrefs) {
    if (/\.(png|jpe?g|gif|svg)(\?|$)/i.test(h) || /imgur\.com/i.test(h)) continue;
    const u = safeHttpUrl(h);
    if (u) return u;
  }
  return null;
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

export function speedyId(url: string): string {
  return createHash('sha256').update(canonicalizeUrl(url) || url).digest('hex').slice(0, 20);
}

export interface MarkdownParse { postings: FeedPosting[]; tables: number; openTables: number; unreadableWithoutId: number; missingColumns: string[] }

/** Parses one speedyapply markdown file. Pure. */
export function parseSpeedyMarkdown(text: string, list: GithubList, file: string, now: number): MarkdownParse {
  const lines = text.split(/\r?\n/);
  const postings: FeedPosting[] = [];
  let tables = 0, openTables = 0, unreadableWithoutId = 0;
  let inTable = false;
  let cols: Record<string, number> | null = null;
  const missingColumns = new Set<string>();
  const starts = (text.match(/<!--\s*TABLE[A-Z_]*_START\s*-->/g) ?? []).length;
  const ends = (text.match(/<!--\s*TABLE[A-Z_]*_END\s*-->/g) ?? []).length;
  openTables = Math.max(0, starts - ends);
  const intl = /INTL/i.test(file);
  for (const line of lines) {
    if (/<!--\s*TABLE[A-Z_]*_START\s*-->/.test(line)) { inTable = true; cols = null; tables++; continue; }
    if (/<!--\s*TABLE[A-Z_]*_END\s*-->/.test(line)) { inTable = false; cols = null; continue; }
    if (!inTable || !line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (!cols) {
      const names = cells.map((c) => cellText(c).toLowerCase());
      const find = (...ns: string[]) => names.findIndex((n) => ns.includes(n));
      const c = { company: find('company'), position: find('position', 'role', 'title'), location: find('location'), salary: find('salary'), posting: find('posting', 'apply', 'link', 'application'), age: find('age', 'date posted') };
      if (c.company < 0 || c.position < 0 || c.posting < 0) {
        throw shapeError(`${file}: a table header lacks the Company, Position or Posting column (found: ${names.join(', ')})`);
      }
      if (c.location < 0) missingColumns.add(`${file}: Location`);
      cols = c;
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // the separator row
    const company = cellText(cells[cols.company] ?? '');
    const title = cellText(cells[cols.position] ?? '');
    const url = cellLink(cells[cols.posting] ?? '');
    if (!company || !title || !url) { unreadableWithoutId++; continue; }
    const facts = emptyFacts();
    const locText = cols.location >= 0 ? cellText(cells[cols.location] ?? '') : '';
    const more = /\s\+(\d+)$/.exec(locText);
    const firstLoc = more ? locText.slice(0, more.index).trim() : locText;
    if (firstLoc) locationFacts(facts, firstLoc.split(/;\s*/), `location${more ? ` (and ${more[1]} more)` : ''}`);
    if (facts.isUs === null && !intl && /USA|README/i.test(file)) {
      // The file is the list's USA table ("USA Positions"), which is what the list states.
      facts.isUs = true;
      facts.evidence.places = ev('board_field', `listed in ${list.repo}/${file} (USA positions)`);
    }
    if (cols.salary >= 0) {
      const salary = cellText(cells[cols.salary] ?? '');
      const pay = payFromSalaryField(salary);
      if (pay) { facts.pay = pay; facts.evidence.pay = ev('board_field', `Salary: ${salary}`); }
    }
    const et = employmentTypeOf(title) ?? (/INTERN|README/i.test(file) ? 'internship' : null);
    if (et) { facts.employmentType = et; facts.evidence.employmentType = ev(employmentTypeOf(title) ? 'title' : 'board_field', employmentTypeOf(title) ? title : `listed in ${file}`); }
    const age = cols.age >= 0 ? cellText(cells[cols.age] ?? '') : '';
    postings.push({
      sourceUrl: url,
      facts,
      raw: rawJob({
        externalId: speedyId(url), url, title, company, location: locText,
        descriptionHtml: `<p>Listed in ${list.repo} on GitHub (${file}).</p>${age ? `<p>Age in the list when read: ${age.replace(/</g, '&lt;')} (the list gives no posting date)</p>` : ''}`,
        remote: facts.workModel === 'remote', workMode: facts.workModel ?? '', countries: countriesOf(facts),
        postedAt: null, employmentType: et ?? '', pay: rawPayOf(facts),
      }),
    });
  }
  if (tables === 0) throw shapeError(`${file}: no job table was found`);
  void now;
  return { postings, tables, openTables, unreadableWithoutId, missingColumns: [...missingColumns] };
}

function feedFor(list: GithubList): JobFeed {
  const credit = listCredit(list);
  return {
    id: list.id,
    info: {
      id: list.id,
      name: list.name,
      kind: 'community',
      crawled: true,
      reason: null,
      checkedOn: '2026-09-25',
      evidenceUrl: `https://github.com/${list.repo}`,
      needsKey: false,
      credit,
      limits: 'At most 4 refreshes a day, at least 1 hour apart (all GitHub lists share 1 request a second)',
    },
    credit,
    limits: { minIntervalMs: 1 * HOUR, maxPerDay: 4 },
    storable: true,
    hosts: ['raw.githubusercontent.com'],
    requestLimits: { perRun: list.files.length * 2 + 2, perDay: (list.files.length * 2 + 2) * 4 },
    async fetch(ctx: FeedContext): Promise<FeedResult> {
      if (list.format === 'json') {
        const url = rawUrl(list, list.files[0]!);
        let body: string;
        let etag: string | null = null;
        if (ctx.http.request) {
          const res = await ctx.http.request(url, { accept: 'application/json', ifNoneMatch: ctx.etag ?? null });
          if (res.status === 304) return { jobs: [], complete: true, notModified: true, etag: ctx.etag ?? res.etag, notes: ['the list has not changed since the last refresh'] };
          body = res.body;
          etag = res.etag;
        } else {
          body = await ctx.http.getText(url, 'application/json');
        }
        const r = parseListings(parseJsonBody(body, 'raw.githubusercontent.com'), list, ctx.now);
        return { ...r, etag };
      }
      const postings: FeedPosting[] = [];
      const seen = new Set<string>();
      let unreadableWithoutId = 0;
      const problems: string[] = [];
      let firstError: FeedError | null = null;
      let read = 0;
      for (const file of list.files) {
        let parsed: MarkdownParse;
        try {
          const text = await ctx.http.getText(rawUrl(list, file), 'text/plain');
          if (/^\s*</.test(text) && /<html|<!doctype/i.test(text.slice(0, 500))) throw new FeedError('web_page', 'raw.githubusercontent.com answered with a web page instead of the list');
          parsed = parseSpeedyMarkdown(text, list, file, ctx.now);
        } catch (e) {
          if (!(e instanceof FeedError)) throw e;
          firstError ??= e;
          problems.push(`${file}: ${e.message}`);
          continue;
        }
        read++;
        if (parsed.openTables > 0) problems.push(`${file} was cut off (a table has no end marker)`);
        if (parsed.missingColumns.length) problems.push(`the data format changed: no ${parsed.missingColumns.join(', ')} column`);
        unreadableWithoutId += parsed.unreadableWithoutId;
        for (const p of parsed.postings) {
          if (seen.has(p.raw.externalId)) continue;
          seen.add(p.raw.externalId);
          postings.push(p);
        }
      }
      if (read === 0 && firstError) throw firstError;
      const complete = problems.length === 0;
      return result(postings, {
        complete, unreadableWithoutId,
        ...(complete ? {} : { problem: problems.join('; ') }),
        notes: [`read ${read} of ${list.files.length} files`],
      });
    },
  };
}

export const GITHUB_FEEDS: readonly JobFeed[] = GITHUB_LISTS.map(feedFor);
