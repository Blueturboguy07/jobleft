// Recruitee (Tellent Recruitee): the Careers Site API.
//   GET https://{company}.recruitee.com/api/offers/      (docs.recruitee.com/reference/offers, security: none)
// One request returns every published offer (no paging). Evidence and field map: docs/sources/recruitee.md.
// Change announced by Recruitee: "Deadline for introducing the token to calls is 10 February 2027. Calls without the
// authorization header will return the 401 Unauthorized error." jobleft has no token, so a 401 becomes a plain reason.

import { arr, countryFromCode, HttpError, makePay, num, obj, str } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, PayPeriod, RawJob, RawPay, Source, WorkMode } from '@jobleft/crawler';
import { FeedFormatError, SourceChangedError } from '../errors.ts';
import { boardHost } from '../hosts.ts';
import { countryCodes, httpUrl, joinDistinct, placeText, postedIso, subdomainBoard, textField, unreadableJob, unwrapEscapedHtml } from '../util.ts';

export function recruiteeUrl(board: string): string {
  return `https://${subdomainBoard('recruitee', board)}.recruitee.com/api/offers/`;
}

function payPeriod(p: string): PayPeriod | '' {
  switch (p.trim().toLowerCase()) {
    case 'hour': case 'hourly': case 'per_hour': return 'hour';
    case 'day': case 'daily': case 'per_day': return 'day';
    case 'week': case 'weekly': case 'per_week': return 'week';
    case 'month': case 'monthly': case 'per_month': return 'month';
    case 'year': case 'yearly': case 'annual': case 'annually': case 'per_year': return 'year';
    default: return '';
  }
}

/** Recruitee states pay as plain amounts in strings ("100", "1000"), never in cents. No currency, no pay. */
export function recruiteePay(salary: unknown): RawPay | null {
  const s = obj(salary);
  const currency = str(s.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return makePay(num(s.min), num(s.max), currency, payPeriod(str(s.period)));
}

function employmentType(code: string): string {
  const c = code.toLowerCase();
  if (!c) return '';
  if (c.includes('intern') || c.includes('trainee') || c.includes('apprentice')) return 'internship';
  if (c.includes('part')) return 'part_time';
  if (c.includes('full')) return 'full_time';
  if (c.includes('freelance') || c.includes('contract') || c.includes('temporary') || c.includes('fixed') || c.includes('seasonal')) return 'contract';
  return '';
}

function workMode(o: Record<string, unknown>): WorkMode {
  if (o.hybrid === true) return 'hybrid';
  if (o.remote === true && o.on_site !== true) return 'remote';
  if (o.on_site === true && o.remote !== true) return 'onsite';
  return '';
}

export function mapRecruitee(o: Record<string, unknown>, board: BoardRef): RawJob {
  const id = typeof o.id === 'number' || typeof o.id === 'string' ? String(o.id).trim() : '';
  const title = textField(o.title);
  if (!id) return unreadableJob(board, 'no id');
  if (!title) return unreadableJob(board, 'no title');
  const slug = board.board.trim().toLowerCase();

  const locs = arr(o.locations).map(obj);
  let location = joinDistinct(locs.map((l) => placeText(str(l.city) || str(l.name), l.state_name ?? l.state, l.country)), '; ');
  if (!location) location = textField(o.location) || placeText(o.city, o.state_name, o.country);
  let countries = countryCodes(locs.map((l) => l.country_code));
  if (countries.length === 0) countries = countryCodes([o.country_code]);
  if (countries.length === 0 && str(o.country)) countries = countryFromCode(str(o.country));

  const mode = workMode(o);
  let description = str(o.description);
  if (str(o.requirements)) description += `<p></p>${str(o.requirements)}`;

  return {
    externalId: id,
    url: httpUrl(o.careers_url) || (str(o.slug) ? `https://${slug}.recruitee.com/o/${encodeURIComponent(str(o.slug))}` : ''),
    applyUrl: httpUrl(o.careers_apply_url),
    title,
    company: textField(o.company_name) || board.company,
    location,
    descriptionHtml: unwrapEscapedHtml(description),
    remote: o.remote === true,
    workMode: mode,
    countries,
    postedAt: postedIso(o.published_at),
    employmentType: employmentType(str(o.employment_type_code)),
    department: textField(o.department),
    pay: recruiteePay(o.salary),
  };
}

export const recruitee: Source = {
  ats: 'recruitee',
  fullBoardListing: true,
  host: (b: BoardRef) => boardHost(b),
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const url = recruiteeUrl(board.board);
    let resp: unknown;
    try {
      resp = await http.getJson(url);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        throw new SourceChangedError('Recruitee refused the request (HTTP 401). Recruitee announced that its Careers Site API needs a token from 10 February 2027, and jobleft has none, so this board cannot be read');
      }
      throw e;
    }
    if (!resp || typeof resp !== 'object' || Array.isArray(resp) || !Array.isArray((resp as { offers?: unknown }).offers)) {
      throw new FeedFormatError(url, 'the Recruitee answer has no "offers" list; the feed format may have changed, so nothing was read');
    }
    return arr((resp as { offers: unknown[] }).offers).map((o) => mapRecruitee(obj(o), board));
  },
};
