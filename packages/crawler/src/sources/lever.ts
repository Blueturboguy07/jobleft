// Port of freehire internal/ingest/sources/lever.go.
// One request per board: GET api.lever.co/v0/postings/{site}?mode=json (EU: api.eu.lever.co).
// Lever's robots.txt says Crawl-delay: 1, which the pacer honours.
import type { BoardRef, HttpGetter, PayPeriod, RawJob, Source } from '../types.ts';
import { arr, countryFromCode, employmentTypeFromText, isoDate, isRemote, makePay, num, obj, str, workplaceTypeMode } from './util.ts';

const BASE_US = 'https://api.lever.co/v0/postings';
const BASE_EU = 'https://api.eu.lever.co/v0/postings';

function salaryPeriod(interval: string): PayPeriod | '' {
  switch (interval) {
    case 'per-year-salary': return 'year';
    case 'per-month-salary': return 'month';
    case 'per-hour-wage': return 'hour';
    default: return ''; // includes one-time bonus / stipend: not a recurring wage
  }
}

export function mapLever(p: Record<string, unknown>, board: BoardRef): RawJob | null {
  const id = str(p.id);
  if (!id) return null;
  const cats = obj(p.categories);
  const allLocations = arr(cats.allLocations).map(str).filter(Boolean);
  const location = str(cats.location) || allLocations[0] || '';
  // Lever splits the body across description + lists (heading + HTML items) + additional.
  let body = str(p.description);
  for (const l of arr(p.lists)) {
    const lo = obj(l);
    if (str(lo.text)) body += `<h3>${str(lo.text)}</h3>`;
    body += str(lo.content);
  }
  body += str(p.additional);
  let pay = null;
  const sr = obj(p.salaryRange);
  if (Object.keys(sr).length > 0) {
    pay = makePay(num(sr.min), num(sr.max), str(sr.currency) || 'USD', salaryPeriod(str(sr.interval)));
  }
  const mode = workplaceTypeMode(str(p.workplaceType));
  return {
    externalId: id,
    url: str(p.hostedUrl),
    applyUrl: str(p.applyUrl),
    title: str(p.text),
    company: board.company,
    location,
    descriptionHtml: body,
    remote: mode === 'remote' || isRemote(location),
    workMode: mode,
    countries: countryFromCode(str(p.country)),
    postedAt: isoDate(num(p.createdAt)),
    employmentType: employmentTypeFromText(str(cats.commitment)),
    department: str(cats.department) || str(cats.team),
    pay,
  };
}

export const lever: Source = {
  ats: 'lever',
  fullBoardListing: true,
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const base = board.region === 'eu' ? BASE_EU : BASE_US;
    const resp = await http.getJson(`${base}/${encodeURIComponent(board.board)}?mode=json`);
    const out: RawJob[] = [];
    for (const p of arr(resp)) {
      const m = mapLever(obj(p), board);
      if (m) out.push(m);
    }
    return out;
  },
};
