// Port of freehire internal/ingest/sources/greenhouse.go.
// One request per board: GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true.
// Differences from the Go adapter:
//   * the posted date is `first_published` only (Go uses `updated_at`, which moves on every edit); `updated_at` is kept
//     separately and is never shown as the posted date
//   * `pay_input_ranges` is read when the API includes it (needs pay_transparency=true, see PAY_QUERY); its unit is
//     taken from the range's own text, and a figure whose unit cannot be told is not shown
//   * every place: `location.name` split on ";" and "|"; the offices only when the location is empty or generic, and
//     only offices that read as places
//   * the reply must be a job list; `meta.total` larger than the list means the reply was cut short (the board fails)
//   * no second request for the company "about us" text
import type { PayPeriod } from '@jobleft/parsers';
import { NotJobDataError } from '../http.ts';
import { isGenericPlace, parsePlace, splitPlaces } from '../places.ts';
import type { BoardRef, HttpGetter, RawJob, Source } from '../types.ts';
import { arr, employmentTypeFromText, isoDate, isRemote, makePay, num, obj, str, unmappable, workModeFromRemote } from './util.ts';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

/** Set to '&pay_transparency=true' to ask the list endpoint for pay ranges (see the S1 probe). */
export const PAY_QUERY = { value: '' };

function metadataEmploymentType(metadata: unknown[]): string {
  for (const m of metadata) {
    const o = obj(m);
    if (str(o.name).trim().toLowerCase() !== 'employment type') continue;
    const v = o.value;
    return typeof v === 'string' ? employmentTypeFromText(v) : '';
  }
  return '';
}

/**
 * The unit a Greenhouse pay range states in its own words; '' when the range states none. Never guessed from the size
 * of the figures: a range with no unit is not board pay (the posting text may still state the pay with its unit).
 */
function rangePeriod(texts: string): PayPeriod | '' {
  const t = texts.toLowerCase();
  if (/\b(per hour|hourly|\/\s?h(ou)?r|an hour)\b/.test(t)) return 'hour';
  if (/\b(per year|annual|annually|yearly|\/\s?y(ea)?r|per annum)\b/.test(t)) return 'year';
  if (/\b(per month|monthly|\/\s?mo(nth)?)\b/.test(t)) return 'month';
  if (/\b(per week|weekly)\b/.test(t)) return 'week';
  if (/\b(per day|daily)\b/.test(t)) return 'day';
  return '';
}

export function mapGreenhouse(j: Record<string, unknown>, board: BoardRef): RawJob | null {
  const id = j.id;
  if (id === undefined || id === null || (typeof id !== 'string' && typeof id !== 'number')) return null;
  const locationName = str(obj(j.location).name);
  let places = splitPlaces(locationName).filter((p) => !isGenericPlace(p));
  if (places.length === 0) {
    // No usable location: the offices, but only what reads as a place (some boards use offices as categories,
    // e.g. "2026-2027 Openings"; those are never shown as places).
    places = arr(j.offices).map((o) => {
      const oo = obj(o);
      return str(oo.location) || str(oo.name);
    }).filter((o) => o && !isGenericPlace(o)).filter((o) => { const p = parsePlace(o); return p.city !== null || p.country !== null; });
  }
  const location = places.length > 0 ? places.join('; ') : locationName;
  const departments = arr(j.departments).map((d) => str(obj(d).name)).filter(Boolean);
  let pay = null;
  let payEvidence: string | undefined;
  const ranges = arr(j.pay_input_ranges).map(obj);
  for (const r of ranges) {
    const min = num(r.min_cents), max = num(r.max_cents);
    const lo = min === null ? null : min / 100, hi = max === null ? null : max / 100;
    const words = `${str(r.title)} ${str(r.blurb)}`;
    const period = rangePeriod(words);
    pay = makePay(lo, hi, str(r.currency_type) || 'USD', period);
    if (pay) {
      payEvidence = `pay_input_ranges: ${str(r.title) ? str(r.title) + ' ' : ''}${lo ?? ''} to ${hi ?? ''} ${str(r.currency_type) || 'USD'}${str(r.blurb) ? ' (' + str(r.blurb).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) + ')' : ''}`;
      break;
    }
  }
  const company = board.company || str(j.company_name);
  return {
    externalId: String(id),
    url: str(j.absolute_url),
    applyUrl: '',
    title: str(j.title),
    company,
    location,
    descriptionHtml: str(j.content),
    remote: isRemote(location),
    workMode: workModeFromRemote(isRemote(location)),
    countries: [],
    postedAt: isoDate(j.first_published),
    employmentType: metadataEmploymentType(arr(j.metadata)),
    department: departments[0] ?? '',
    pay,
    places,
    payRanges: pay ? ranges.length : undefined,
    payEvidence,
    boardUpdatedAt: isoDate(j.updated_at),
    workModeEvidence: isRemote(location) ? location : undefined,
  };
}

export const greenhouse: Source = {
  ats: 'greenhouse',
  fullBoardListing: true,
  conditional: true,
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const url = `${BASE}/${encodeURIComponent(board.board)}/jobs?content=true${PAY_QUERY.value}`;
    const body = await http.getJson(url);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray((body as { jobs?: unknown }).jobs)) {
      throw new NotJobDataError(url, 'shape', 'a Greenhouse board answers {"jobs": [...]}; this reply has no job list');
    }
    const resp = obj(body);
    const list = arr(resp.jobs);
    const total = num(obj(resp.meta).total);
    if (total !== null && total > list.length) {
      throw new NotJobDataError(url, 'cut_off', `the reply lists ${list.length} of the ${total} jobs it says the board has`);
    }
    const out: RawJob[] = [];
    for (const j of list) out.push(mapGreenhouse(obj(j), board) ?? unmappable(j));
    return out;
  },
};
