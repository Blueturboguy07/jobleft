// Port of freehire internal/ingest/sources/greenhouse.go.
// One request per board: GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true.
// Differences from the Go adapter:
//   * posted date is `first_published` when present (Go uses `updated_at`, which moves on every edit)
//   * `pay_input_ranges` is read when the API includes it (needs pay_transparency=true, see PAY_QUERY)
//   * no second request for the company "about us" text
import type { BoardRef, HttpGetter, RawJob, Source } from '../types.ts';
import { arr, employmentTypeFromText, isoDate, isRemote, makePay, num, obj, str, workModeFromRemote } from './util.ts';

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

export function mapGreenhouse(j: Record<string, unknown>, board: BoardRef): RawJob | null {
  const id = j.id;
  if (id === undefined || id === null) return null;
  const location = str(obj(j.location).name);
  const departments = arr(j.departments).map((d) => str(obj(d).name)).filter(Boolean);
  let pay = null;
  const ranges = arr(j.pay_input_ranges);
  if (ranges.length > 0) {
    const r = obj(ranges[0]);
    const min = num(r.min_cents), max = num(r.max_cents);
    const lo = min === null ? null : min / 100, hi = max === null ? null : max / 100;
    // The API states no period. Under 500 is an hourly rate, otherwise annual.
    const period = (hi ?? lo ?? 0) < 500 ? 'hour' : 'year';
    pay = makePay(lo, hi, str(r.currency_type) || 'USD', period);
  }
  return {
    externalId: String(id),
    url: str(j.absolute_url),
    applyUrl: '',
    title: str(j.title),
    company: board.company,
    location,
    descriptionHtml: str(j.content),
    remote: isRemote(location),
    workMode: workModeFromRemote(isRemote(location)),
    countries: [],
    postedAt: isoDate(j.first_published) ?? isoDate(j.updated_at),
    employmentType: metadataEmploymentType(arr(j.metadata)),
    department: departments[0] ?? '',
    pay,
  };
}

export const greenhouse: Source = {
  ats: 'greenhouse',
  fullBoardListing: true,
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const url = `${BASE}/${encodeURIComponent(board.board)}/jobs?content=true${PAY_QUERY.value}`;
    const resp = obj(await http.getJson(url));
    const out: RawJob[] = [];
    for (const j of arr(resp.jobs)) {
      const m = mapGreenhouse(obj(j), board);
      if (m) out.push(m);
    }
    return out;
  },
};
