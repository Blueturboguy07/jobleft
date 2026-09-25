// Port of freehire internal/ingest/sources/ashby.go.
// One request per board: GET api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true.
// includeCompensation=true is required: without it the API silently drops the compensation object.
import type { BoardRef, HttpGetter, PayPeriod, RawJob, Source, WorkMode } from '../types.ts';
import { arr, countryFromCode, isRemote, isoDate, makePay, num, obj, str, workplaceTypeMode } from './util.ts';

const BASE = 'https://api.ashbyhq.com/posting-api/job-board';

function salaryPeriod(interval: string): PayPeriod | '' {
  switch (interval) {
    case '1 YEAR': return 'year';
    case '1 MONTH': return 'month';
    case '1 DAY': return 'day';
    case '1 HOUR': return 'hour';
    default: return ''; // "NONE" is a non-recurring component
  }
}

function employmentType(t: string): string {
  switch (t) {
    case 'FullTime': return 'full_time';
    case 'PartTime': return 'part_time';
    case 'Contract': case 'Temporary': return 'contract';
    case 'Intern': case 'Internship': return 'internship';
    default: return '';
  }
}

export function mapAshby(j: Record<string, unknown>, board: BoardRef): RawJob | null {
  const id = str(j.id);
  if (!id) return null;
  // workplaceType decides the mode; isRemote only says "not strictly onsite" (hybrid sets it too).
  let mode: WorkMode = workplaceTypeMode(str(j.workplaceType));
  if (!mode && j.isRemote === true) mode = 'remote';
  const primary = str(j.location);
  const secondary = arr(j.secondaryLocations).map((s) => str(obj(s).location)).filter(Boolean);
  const location = [primary, ...secondary].filter(Boolean).join('; ');
  let pay = null;
  const tiers = arr(obj(j.compensation).compensationTiers);
  find: for (const t of tiers) {
    for (const c of arr(obj(t).components)) {
      const co = obj(c);
      if (str(co.compensationType) !== 'Salary') continue;
      pay = makePay(num(co.minValue), num(co.maxValue), str(co.currencyCode) || 'USD', salaryPeriod(str(co.interval)));
      if (pay) break find;
    }
  }
  return {
    externalId: id,
    url: str(j.jobUrl),
    applyUrl: str(j.applyUrl),
    title: str(j.title),
    company: board.company,
    location,
    descriptionHtml: str(j.descriptionHtml) || str(j.descriptionPlain),
    remote: mode === 'remote' || isRemote(location),
    workMode: mode,
    countries: countryFromCode(str(obj(obj(j.address).postalAddress).addressCountry)),
    postedAt: isoDate(j.publishedAt),
    employmentType: employmentType(str(j.employmentType)),
    department: str(j.department) || str(j.team),
    pay,
  };
}

export const ashby: Source = {
  ats: 'ashby',
  fullBoardListing: true,
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const resp = obj(await http.getJson(`${BASE}/${encodeURIComponent(board.board)}?includeCompensation=true`));
    const out: RawJob[] = [];
    for (const j of arr(resp.jobs)) {
      const m = mapAshby(obj(j), board);
      if (m) out.push(m);
    }
    return out;
  },
};
