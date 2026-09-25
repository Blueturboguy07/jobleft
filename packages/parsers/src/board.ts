// Reading the fact fields of public job-board formats: Greenhouse, Lever, Ashby, Workable, Recruitee, Personio and
// schema.org JobPosting (JSON-LD). Pure mapping from an object the caller already has; no network.
// The crawler's adapters own fetching; these functions only read the fields that carry the four facts.
import type { PayPeriod } from '@jobleft/contracts';
import type { BoardAddress } from './places.ts';
import type { BoardPay } from './pay.ts';

/** Everything the fact readers use for one posting. Only `title` is required. */
export interface PostingInput {
  title: string;
  /** The board's primary location text. */
  location?: string | null;
  /** Every location text the board lists (primary first). */
  locations?: string[];
  /** Structured addresses the board gives. */
  addresses?: BoardAddress[];
  /** ISO alpha-2 country codes the board states. */
  countries?: string[];
  /** The posting body as HTML (converted to text) ... */
  descriptionHtml?: string | null;
  /** ... or as plain text (used when given). */
  description?: string | null;
  /** Pay figures from the board's own pay field(s). */
  pay?: BoardPay[];
  /** The board's workplace field ("remote", "hybrid", "on-site", "TELECOMMUTE"). */
  workplaceType?: string | null;
  /** A board flag that says remote. */
  remote?: boolean | null;
  employmentType?: string | null;
  /** A board seniority field (Recruitee experience_code, Personio seniority). */
  seniority?: string | null;
  /** JSON-LD experienceRequirements.monthsOfExperience. */
  experienceMonths?: number | null;
  /** Board text shown next to the body that can hold facts (Lever salaryDescription, Ashby pay summary). */
  extraText?: string | null;
}

export type BoardFormat = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | 'personio' | 'jsonld';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/,/g, '')))) return Number(v.replace(/,/g, ''));
  return null;
};

function periodOf(v: string): PayPeriod | null {
  const k = v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/\b(?:hour|hourly|hr|per hour wage|1 hour)\b/.test(k)) return 'hour';
  if (/\b(?:day|daily|1 day)\b/.test(k)) return 'day';
  if (/\b(?:week|weekly|1 week)\b/.test(k)) return 'week';
  if (/\b(?:month|monthly|1 month)\b/.test(k)) return 'month';
  if (/\b(?:year|yearly|annual|annually|annum|1 year|salary)\b/.test(k)) return 'year';
  return null;
}

// --- Greenhouse (boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true[&pay_transparency=true]) ---------------
export function fromGreenhouse(j: Obj): PostingInput {
  const offices = arr(j.offices).map((o) => obj(o)).map((o) => str(obj(o.location).name) || str(o.location) || str(o.name)).filter(Boolean);
  const location = str(obj(j.location).name);
  const pay: BoardPay[] = arr(j.pay_input_ranges).map((r) => obj(r)).map((r) => ({
    min: num(r.min_cents) === null ? null : num(r.min_cents)! / 100,
    max: num(r.max_cents) === null ? null : num(r.max_cents)! / 100,
    currency: str(r.currency_type) || null,
    period: null,
    label: str(r.title) || null,
    text: [str(r.title), str(r.blurb)].filter(Boolean).join(': ') || null,
  }));
  let workplaceType: string | null = null;
  let employmentType: string | null = null;
  for (const m of arr(j.metadata).map((x) => obj(x))) {
    const name = str(m.name).toLowerCase();
    const value = Array.isArray(m.value) ? m.value.map(str).join(', ') : str(m.value);
    if (!value) continue;
    if (/workplace|work\s*(?:model|type|arrangement|location\s*type|style)|remote|location\s*type|on-?site/.test(name)) workplaceType = workplaceType ?? value;
    else if (/employment\s*type|job\s*type|time\s*type|schedule/.test(name)) employmentType = employmentType ?? value;
  }
  return {
    title: str(j.title), location, locations: [location, ...offices.filter((o) => o !== location)].filter(Boolean),
    descriptionHtml: str(j.content), pay, workplaceType, employmentType,
  };
}

// --- Lever (api.lever.co/v0/postings/{site}?mode=json) ----------------------------------------------------------------
export function fromLever(p: Obj): PostingInput {
  const cats = obj(p.categories);
  const all = arr(cats.allLocations).map(str).filter(Boolean);
  const location = str(cats.location) || all[0] || '';
  let body = str(p.description) || str(p.descriptionPlain);
  for (const l of arr(p.lists).map((x) => obj(x))) {
    if (str(l.text)) body += `<h3>${str(l.text)}</h3>`;
    body += str(l.content);
  }
  body += str(p.additional) || str(p.additionalPlain);
  const sr = obj(p.salaryRange);
  const pay: BoardPay[] = Object.keys(sr).length ? [{
    min: num(sr.min), max: num(sr.max), currency: str(sr.currency) || null,
    period: (() => {
      const i = str(sr.interval);
      if (/one[- ]?time|bonus|stipend/i.test(i)) return 'onetime' as unknown as PayPeriod;
      return periodOf(i.replace(/salary|wage/g, ''));
    })(),
    text: str(p.salaryDescriptionPlain) || null,
  }].filter((x) => (x.period as unknown as string) !== 'onetime') : [];
  const country = str(p.country);
  return {
    title: str(p.text), location, locations: [location, ...all.filter((a) => a !== location)].filter(Boolean),
    countries: /^[A-Za-z]{2}$/.test(country) ? [country.toUpperCase()] : [],
    descriptionHtml: body, pay, workplaceType: str(p.workplaceType) || null, employmentType: str(cats.commitment) || null,
    extraText: str(p.salaryDescriptionPlain) || str(p.salaryDescription) || null,
  };
}

// --- Ashby (api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true) -----------------------------------
export function fromAshby(j: Obj): PostingInput {
  const primary = str(j.location);
  const secondary = arr(j.secondaryLocations).map((s) => obj(s));
  const addresses: BoardAddress[] = [];
  const pa = obj(obj(j.address).postalAddress);
  if (Object.keys(pa).length) addresses.push({ city: str(pa.addressLocality), region: str(pa.addressRegion), country: str(pa.addressCountry) });
  for (const s of secondary) {
    const spa = obj(obj(s.address).postalAddress);
    if (Object.keys(spa).length) addresses.push({ city: str(spa.addressLocality), region: str(spa.addressRegion), country: str(spa.addressCountry), text: str(s.location) || null });
  }
  const pay: BoardPay[] = [];
  for (const tier of arr(obj(j.compensation).compensationTiers).map((x) => obj(x))) {
    for (const c of arr(tier.components).map((x) => obj(x))) {
      if (str(c.compensationType) !== 'Salary') continue;
      const interval = str(c.interval);
      const period = interval === 'NONE' || !interval ? null : periodOf(interval);
      if (!period) continue;
      pay.push({ min: num(c.minValue), max: num(c.maxValue), currency: str(c.currencyCode) || null, period, label: str(tier.title) || null, text: str(c.summary) || str(tier.tierSummary) || null });
    }
  }
  const comp = obj(j.compensation);
  return {
    title: str(j.title), location: primary, locations: [primary, ...secondary.map((s) => str(s.location))].filter(Boolean),
    addresses, descriptionHtml: str(j.descriptionHtml) || null, description: str(j.descriptionHtml) ? null : str(j.descriptionPlain) || null,
    pay, workplaceType: str(j.workplaceType) || null, remote: typeof j.isRemote === 'boolean' ? j.isRemote : null,
    employmentType: str(j.employmentType) || null,
    extraText: str(comp.scrapeableCompensationSalarySummary) || str(comp.compensationTierSummary) || null,
  };
}

// --- Workable (apply.workable.com/api/v3/accounts/{account}/jobs and the widget API) ---------------------------------
export function fromWorkable(j: Obj): PostingInput {
  const loc = obj(j.location);
  const locs = arr(j.locations).map((x) => obj(x));
  const addresses: BoardAddress[] = [];
  const addLoc = (l: Obj) => {
    const city = str(l.city), region = str(l.region) || str(l.state), country = str(l.countryCode) || str(l.country_code) || str(l.country);
    if (city || region || country) addresses.push({ city, region, country });
  };
  if (Object.keys(loc).length) addLoc(loc); else addLoc(j);
  for (const l of locs) addLoc(l);
  const sal = obj(j.salary);
  const pay: BoardPay[] = [];
  const from = num(sal.salary_from ?? j.salary_from), to = num(sal.salary_to ?? j.salary_to);
  if (from !== null || to !== null) pay.push({ min: from, max: to, currency: str(sal.salary_currency ?? j.salary_currency) || null, period: periodOf(str(sal.salary_period ?? j.salary_period)) });
  const workplace = str(j.workplace) || str(j.workplace_type) || (j.remote === true || loc.telecommuting === true || j.telecommuting === true ? 'remote' : '');
  const desc = [str(j.description), str(j.requirements), str(j.benefits)].filter(Boolean).join('\n');
  return {
    title: str(j.title), location: str(j.location_str) || [str(loc.city), str(loc.region), str(loc.country)].filter(Boolean).join(', '),
    addresses, descriptionHtml: desc || null, pay, workplaceType: workplace || null,
    employmentType: str(j.employment_type) || str(j.type) || null,
    seniority: str(j.experience) || null,
  };
}

// --- Recruitee ({company}.recruitee.com/api/offers/) -----------------------------------------------------------------
export function fromRecruitee(o: Obj): PostingInput {
  const addresses: BoardAddress[] = [];
  const locs = arr(o.locations).map((x) => obj(x));
  for (const l of locs) addresses.push({ city: str(l.city), region: str(l.state) || str(l.state_code), country: str(l.country_code) || str(l.country) });
  if (!locs.length && (o.city || o.country_code)) addresses.push({ city: str(o.city), region: str(o.state_code) || str(o.state_name), country: str(o.country_code) || str(o.country) });
  const sal = obj(o.salary);
  const pay: BoardPay[] = [];
  if (num(sal.min) !== null || num(sal.max) !== null) pay.push({ min: num(sal.min), max: num(sal.max), currency: str(sal.currency) || null, period: periodOf(str(sal.period)) });
  const workplace = o.remote === true ? 'remote' : o.hybrid === true ? 'hybrid' : o.on_site === true ? 'on-site' : '';
  return {
    title: str(o.title), location: str(o.location), addresses,
    descriptionHtml: [str(o.description), str(o.requirements)].filter(Boolean).join('\n') || null,
    pay, workplaceType: workplace || null, employmentType: str(o.employment_type_code) || null,
    seniority: str(o.experience_code) || null,
  };
}

// --- Personio (the XML feed, already parsed into an object by the caller) ------------------------------------------
export function fromPersonio(p: Obj): PostingInput {
  const offices = [str(p.office), ...arr(obj(p.additionalOffices).office ?? p.additionalOffices).map(str)].filter(Boolean);
  const descs = arr(obj(p.jobDescriptions).jobDescription ?? p.jobDescriptions).map((x) => obj(x));
  const html = descs.map((d) => `<h3>${str(d.name)}</h3>${str(d.value)}`).join('\n');
  const yoe = str(p.yearsOfExperience);
  const m = /^(?:lt-)?(\d+)/.exec(yoe);
  return {
    title: str(p.name), location: offices[0] ?? '', locations: offices, descriptionHtml: html || null,
    employmentType: str(p.employmentType) || str(p.schedule) || null, seniority: str(p.seniority) || null,
    experienceMonths: m && !yoe.startsWith('lt-') ? Number(m[1]) * 12 : null,
  };
}

// --- schema.org JobPosting (JSON-LD on job pages) --------------------------------------------------------------------
export function fromJsonLd(j: Obj): PostingInput {
  const addresses: BoardAddress[] = [];
  const places = Array.isArray(j.jobLocation) ? j.jobLocation : j.jobLocation ? [j.jobLocation] : [];
  for (const pl of places.map((x) => obj(x))) {
    const a = obj(pl.address);
    const country = typeof a.addressCountry === 'string' ? a.addressCountry : str(obj(a.addressCountry).name) || str(obj(a.addressCountry).identifier);
    addresses.push({ city: str(a.addressLocality), region: str(a.addressRegion), country, postalCode: str(a.postalCode) });
  }
  const pay: BoardPay[] = [];
  // baseSalary is the employer's stated pay; estimatedSalary is an estimate and is never read (parsers O3).
  const bs = obj(j.baseSalary);
  if (Object.keys(bs).length) {
    const v = obj(bs.value);
    const single = num(bs.value);
    pay.push({
      min: num(v.minValue) ?? num(v.value) ?? single, max: num(v.maxValue) ?? num(v.value) ?? single,
      currency: str(bs.currency) || str(v.currency) || null, period: periodOf(str(v.unitText) || str(bs.unitText)),
    });
  }
  const types = Array.isArray(j.employmentType) ? j.employmentType.map(str) : [str(j.employmentType)];
  const req = arr(j.applicantLocationRequirements).length ? arr(j.applicantLocationRequirements) : j.applicantLocationRequirements ? [j.applicantLocationRequirements] : [];
  const reqNames = req.map((r) => str(obj(r).name)).filter(Boolean);
  const remote = str(j.jobLocationType).toUpperCase() === 'TELECOMMUTE';
  const er = obj(j.experienceRequirements);
  const months = num(er.monthsOfExperience);
  return {
    title: str(j.title), addresses,
    location: remote && reqNames.length ? `Remote (${reqNames.join(', ')})` : remote ? 'Remote' : null,
    descriptionHtml: str(j.description) || null, pay, workplaceType: remote ? 'remote' : null,
    employmentType: types.filter(Boolean).join(', ') || null, experienceMonths: months,
  };
}

/** Guesses the board format from a posting object's keys. */
export function detectFormat(j: Obj): BoardFormat | null {
  if (str(j['@type']) === 'JobPosting' || ('hiringOrganization' in j && 'datePosted' in j)) return 'jsonld';
  if ('absolute_url' in j || 'pay_input_ranges' in j || ('internal_job_id' in j)) return 'greenhouse';
  if ('hostedUrl' in j || ('categories' in j && 'text' in j)) return 'lever';
  if ('jobUrl' in j || 'isRemote' in j || 'secondaryLocations' in j || 'compensation' in j) return 'ashby';
  if ('shortcode' in j || 'workplace' in j) return 'workable';
  if ('careers_url' in j || 'experience_code' in j || 'employment_type_code' in j) return 'recruitee';
  if ('jobDescriptions' in j || 'recruitingCategory' in j) return 'personio';
  return null;
}

export function fromBoard(format: BoardFormat, j: Obj): PostingInput {
  switch (format) {
    case 'greenhouse': return fromGreenhouse(j);
    case 'lever': return fromLever(j);
    case 'ashby': return fromAshby(j);
    case 'workable': return fromWorkable(j);
    case 'recruitee': return fromRecruitee(j);
    case 'personio': return fromPersonio(j);
    case 'jsonld': return fromJsonLd(j);
  }
}

/** The postings in a whole board answer, each with its id and link when the format gives them. */
export function postingsFromBoard(payload: unknown, format?: BoardFormat): Array<{ id: string; url: string | null; format: BoardFormat; input: PostingInput }> {
  const root = payload;
  let list: unknown[] = [];
  if (Array.isArray(root)) list = root;
  else {
    const o = obj(root);
    if (Array.isArray(o.jobs)) list = o.jobs;
    else if (Array.isArray(o.offers)) list = o.offers;
    else if (Array.isArray(o.results)) list = o.results;
    else if (Array.isArray(o.postings)) list = o.postings;
    else if (Array.isArray(o['@graph'])) list = (o['@graph'] as unknown[]).filter((x) => str(obj(x)['@type']) === 'JobPosting');
    else if (Array.isArray(obj(o.workzag_jobs).position)) list = obj(o.workzag_jobs).position as unknown[];
    else if (Array.isArray(o.position)) list = o.position;
    else if (Object.keys(o).length) list = [o];
  }
  const out: Array<{ id: string; url: string | null; format: BoardFormat; input: PostingInput }> = [];
  list.forEach((item, i) => {
    const j = obj(item);
    const f = format ?? detectFormat(j);
    if (!f) return;
    let input: PostingInput;
    try { input = fromBoard(f, j); } catch { input = { title: str(j.title) || str(j.text) || str(j.name) || '(untitled)' }; }
    const id = str(j.id) || str(j.shortcode) || str(j.slug) || str(j.identifier) || String(i + 1);
    const url = str(j.absolute_url) || str(j.hostedUrl) || str(j.jobUrl) || str(j.url) || str(j.careers_url) || null;
    out.push({ id, url, format: f, input });
  });
  return out;
}

/** The fields of the crawler's RawJob that carry facts (structural, so parsers does not import the crawler). */
export interface RawJobLike {
  title: string;
  location?: string | null;
  descriptionHtml?: string | null;
  remote?: boolean | null;
  workMode?: string | null;
  countries?: string[] | null;
  employmentType?: string | null;
  pay?: { min: number | null; max: number | null; currency: string | null; period: PayPeriod | null } | null;
}

/**
 * PostingInput from the crawler's RawJob, for `normalizeJob`: `extractFacts(fromRawJob(raw))`.
 * The crawler joins several places with "; " in `location`; each is still read. Pass richer board fields (every
 * pay tier, secondary addresses) through the `from<Format>` readers when the adapter has them.
 */
export function fromRawJob(raw: RawJobLike, extra: Partial<PostingInput> = {}): PostingInput {
  return {
    title: raw.title ?? '',
    location: raw.location ?? null,
    descriptionHtml: raw.descriptionHtml ?? null,
    workplaceType: raw.workMode || null,
    remote: raw.remote === true && !raw.workMode ? true : null,
    countries: (raw.countries ?? []).filter(Boolean),
    employmentType: raw.employmentType || null,
    pay: raw.pay ? [{ min: raw.pay.min, max: raw.pay.max, currency: raw.pay.currency, period: raw.pay.period }] : [],
    ...extra,
  };
}
