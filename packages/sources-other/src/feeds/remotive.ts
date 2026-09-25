// Remotive: NOT CRAWLED. robots.txt on remotive.com disallows /api/* for every crawler (checked 2026-09-25), so the
// catalog marks it `crawled: false` and nothing is sent. The adapter is built and tested offline so that it is ready
// if Remotive allows the path or the owner obtains written permission. Notes: docs/sources/remotive.md.

import type { FeedContext, FeedPosting, FeedResult, JobFeed } from '../types.ts';
import { parseJsonBody, shapeError } from '../http.ts';
import { employmentTypeOf, fixMojibake, plainLine, parseRemoteScope, payFromSalaryField, safeHttpUrl, scopeOpenToUs } from '../text.ts';
import { HOUR, arr, countriesOf, creditFor, emptyFacts, ev, isoFrom, obj, rawJob, rawPayOf, result, str } from './common.ts';

export const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs';
export const REMOTIVE_CREDIT = creditFor('Found on Remotive', 'https://remotive.com/');

export function parseRemotive(data: unknown, now: number): FeedResult {
  const root = obj(data);
  const jobs = root ? arr(root.jobs) : null;
  if (!jobs) throw shapeError('the answer has no "jobs" list');
  const postings: FeedPosting[] = [];
  const unreadableIds: string[] = [];
  let unreadableWithoutId = 0;
  for (const it of jobs) {
    const j = obj(it);
    const id = j ? str(j.id).trim() : '';
    if (!j || !id) { unreadableWithoutId++; continue; }
    const title = plainLine(str(j.title));
    const company = plainLine(str(j.company_name));
    const url = safeHttpUrl(j.url);
    if (!title || !company || !url) { unreadableIds.push(id); continue; }
    const facts = emptyFacts();
    facts.workModel = 'remote';
    facts.evidence.workModel = ev('board_field', 'Remotive lists remote jobs only');
    const where = str(j.candidate_required_location).trim();
    const scope = parseRemoteScope(where);
    if (scope) {
      facts.remoteScope = scope;
      facts.evidence.remoteScope = ev('board_field', `candidate_required_location: ${where}`);
    }
    facts.isUs = scopeOpenToUs(scope);
    const salary = str(j.salary).trim();
    const pay = payFromSalaryField(salary);
    if (pay) { facts.pay = pay; facts.evidence.pay = ev('board_field', `salary: ${salary}`); }
    const et = employmentTypeOf(str(j.job_type));
    if (et) { facts.employmentType = et; facts.evidence.employmentType = ev('board_field', `job_type: ${str(j.job_type)}`); }
    // publication_date is the employer's date. Remotive's feed arrives 24 hours later; the fetch time is never used.
    facts.postedAt = isoFrom(j.publication_date, now);
    postings.push({
      sourceUrl: url,
      facts,
      raw: rawJob({
        externalId: id, url, title, company, location: where, descriptionHtml: fixMojibake(str(j.description)),
        remote: true, workMode: 'remote', countries: countriesOf(facts), postedAt: facts.postedAt,
        employmentType: et ?? '', department: str(j.category), pay: rawPayOf(facts),
      }),
    });
  }
  if (jobs.length > 0 && postings.length === 0) throw shapeError(`none of the ${jobs.length} postings had an id, a title, a company and a link`);
  return result(postings, { complete: true, unreadableIds, unreadableWithoutId });
}

export const remotive: JobFeed = {
  id: 'remotive',
  info: {
    id: 'remotive',
    name: 'Remotive',
    kind: 'job_board',
    crawled: false,
    reason: 'robots.txt on remotive.com disallows /api/* for every crawler (checked 2026-09-25); jobleft obeys robots.txt, so it sends nothing to Remotive',
    checkedOn: '2026-09-25',
    evidenceUrl: 'https://remotive.com/robots.txt',
    needsKey: false,
    credit: REMOTIVE_CREDIT,
    limits: 'Remotive asks for at most 4 fetches a day and never 2 in one minute',
  },
  credit: REMOTIVE_CREDIT,
  limits: { minIntervalMs: 6 * HOUR, maxPerDay: 4 },
  storable: true,
  hosts: ['remotive.com'],
  requestLimits: { perRun: 3, perDay: 12 },
  async fetch(ctx: FeedContext): Promise<FeedResult> {
    const body = await ctx.http.getText(REMOTIVE_URL, 'application/json');
    return parseRemotive(parseJsonBody(body, 'remotive.com'), ctx.now);
  },
};
