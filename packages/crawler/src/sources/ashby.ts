// Port of freehire internal/ingest/sources/ashby.go.
// One request per board: GET api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true.
// includeCompensation=true is required: without it the API silently drops the compensation object.
import { NotJobDataError } from '../http.ts';
import type { BoardRef, HttpGetter, PayPeriod, RawJob, Source, WorkMode } from '../types.ts';
import { arr, countryFromCode, isRemote, isoDate, makePay, num, obj, str, unmappable, workplaceTypeMode } from './util.ts';

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
  const places = [...new Map([primary, ...secondary].filter(Boolean).map((x) => [x.toLowerCase(), x])).values()];
  const location = places.join('; ');
  let pay = null;
  let payEvidence: string | undefined;
  let salaryParts = 0;
  const comp = obj(j.compensation);
  const tiers = arr(comp.compensationTiers);
  for (const t of tiers) {
    for (const c of arr(obj(t).components)) {
      const co = obj(c);
      if (str(co.compensationType) !== 'Salary') continue;
      const p = makePay(num(co.minValue), num(co.maxValue), str(co.currencyCode) || 'USD', salaryPeriod(str(co.interval)));
      if (!p) continue;
      salaryParts++;
      if (!pay) {
        pay = p;
        payEvidence = str(comp.compensationTierSummary) || str(obj(t).tierSummary)
          || `Salary ${num(co.minValue) ?? ''} to ${num(co.maxValue) ?? ''} ${str(co.currencyCode) || 'USD'} (${str(co.interval)})`;
      }
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
    places,
    payRanges: pay ? Math.max(1, salaryParts) : undefined,
    payEvidence,
    boardUpdatedAt: isoDate(j.updatedAt),
    workModeEvidence: str(j.workplaceType) ? `workplaceType: ${str(j.workplaceType)}` : j.isRemote === true ? 'isRemote: true' : undefined,
  };
}

export const ashby: Source = {
  ats: 'ashby',
  fullBoardListing: true,
  conditional: true,
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const url = `${BASE}/${encodeURIComponent(board.board)}?includeCompensation=true`;
    const body = await http.getJson(url);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray((body as { jobs?: unknown }).jobs)) {
      throw new NotJobDataError(url, 'shape', 'an Ashby board answers {"jobs": [...]}; this reply has no job list');
    }
    const out: RawJob[] = [];
    for (const j of arr(obj(body).jobs)) {
      // A posting the employer marked unlisted is not on its board; it is left out like the board leaves it out.
      if (obj(j).isListed === false) continue;
      out.push(mapAshby(obj(j), board) ?? unmappable(j));
    }
    return out;
  },
};
