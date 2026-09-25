// Fixture employers, boards and postings for the mock. Every company, person and posting here is made up.
// Deterministic: the same --seed and size give the same data. The generator writes postings the way an employer's
// board would: board fields (title, locations, work model, type, posted date, pay when the board has a pay field)
// and a plain-text description. The mock crawl then derives the other facts from that text, with evidence.

import type { CompanyStage, EmploymentType, H1bSummary, PayPeriod } from '@jobleft/contracts';
import { CITIES, cityText, type City } from './cities.ts';
import { DAY_MS, HOUR_MS, companyKey, hash32, pick, pickSome, rng, slug } from './util.ts';

export interface RawPay {
  min: number | null;
  max: number | null;
  currency: string;
  period: PayPeriod;
  ranges: number;
}

/** One posting as the stand-in employer board serves it. */
export interface RawPosting {
  externalId: string;
  title: string;
  /** Location texts as the board lists them (may be empty). */
  locations: string[];
  /** The board's own workplace field, when it has one. */
  workplace: 'onsite' | 'hybrid' | 'remote' | null;
  employmentType: EmploymentType | null;
  department: string | null;
  /** When the employer posted it; null = the board gives no date. */
  postedAt: string | null;
  /** The board's pay field (null when the board has none; the text may still state pay). */
  pay: RawPay | null;
  description: string;
  /** true = the board gives a separate apply page. */
  hasApplyPage: boolean;
}

export interface BoardFile {
  id: string;
  ats: 'greenhouse' | 'lever' | 'ashby';
  board: string;
  company: string;
  /** Set to true to make the stand-in board answer 503 (an employer site that is down). */
  down?: boolean;
  postings: RawPosting[];
}

export interface CompanyFixture {
  key: string;
  name: string;
  industries: string[];
  stage: CompanyStage | null;
  size: string | null;
  founded: number | null;
  headquarters: string | null;
  description: string | null;
  totalFundingUsd: number | null;
  investors: string[] | null;
  leaders: Array<{ name: string; title: string }> | null;
  news: Array<{ title: string; publishedAt: string | null; outlet: string | null }> | null;
  isStaffingAgency: boolean | null;
  h1b: H1bSummary | null;
  /** true = the description and funding facts were written by an AI summary (the UI must say so). */
  aiWritten: boolean;
}

// ------------------------------------------------------------------ vocabularies

const NAME_PREFIX = [
  'Harbor', 'Bluestem', 'Cinder', 'Maple', 'Copperleaf', 'Silverline', 'Kestrel', 'Lumen', 'Brightwater', 'Granite',
  'Juniper', 'Tidewater', 'Redwood', 'Summit', 'Cobalt', 'Aster', 'Beacon', 'Evergreen', 'Fieldstone', 'Halcyon',
  'Ironbridge', 'Lakeshore', 'Meridian', 'Oakridge', 'Pinecrest', 'Quarry', 'Riverbend', 'Sable', 'Thistle', 'Vantage',
  'Willow', 'Yarrow', 'Zephyr', 'Alder', 'Birch', 'Crescent', 'Driftwood', 'Ember', 'Foxglove', 'Glacier', 'Heron',
  'Indigo', 'Jasper', 'Keystone', 'Lantern', 'Mosaic', 'Nimbus', 'Opal', 'Prairie', 'Quill', 'Rook', 'Saffron',
  'Tamarack', 'Upland', 'Verdant', 'Wren', 'Acme', 'Bramble', 'Canyon', 'Delta Faucet', 'Delta Air', 'Fable Hill',
];

interface Sector {
  id: string;
  suffixes: string[];
  industries: string[];
  families: string[];
  staffing?: boolean;
}

const SECTORS: Sector[] = [
  { id: 'software', suffixes: ['Software', 'Labs', 'Systems', 'Cloud', 'Data', 'Technologies'], industries: ['Software', 'Information Technology', 'Artificial Intelligence (AI)', 'Developer Tools', 'Cloud Computing', 'SaaS'], families: ['swe', 'swe', 'swe', 'data', 'product', 'design', 'sales', 'cs', 'hr'] },
  { id: 'health', suffixes: ['Health', 'Medical Group', 'Care Partners', 'Clinics'], industries: ['Health Care', 'Hospitals', 'Medical', 'Wellness'], families: ['nurse', 'nurse', 'health', 'health', 'finance', 'hr', 'swe', 'ops'] },
  { id: 'finance', suffixes: ['Financial', 'Capital', 'Bank', 'Insurance'], industries: ['Financial Services', 'Banking', 'Insurance', 'FinTech'], families: ['finance', 'finance', 'data', 'swe', 'legal', 'sales', 'cs'] },
  { id: 'retail', suffixes: ['Market', 'Outfitters', 'Goods'], industries: ['Retail', 'E-Commerce', 'Consumer Goods'], families: ['ops', 'ops', 'marketing', 'sales', 'data', 'swe', 'design'] },
  { id: 'logistics', suffixes: ['Logistics', 'Freight'], industries: ['Logistics', 'Supply Chain Management', 'Transportation'], families: ['ops', 'ops', 'data', 'swe', 'finance', 'sales'] },
  { id: 'energy', suffixes: ['Energy', 'Power'], industries: ['Energy', 'Renewable Energy', 'Utilities'], families: ['ops', 'data', 'swe', 'finance', 'legal', 'hr'] },
  { id: 'education', suffixes: ['Learning', 'Academy'], industries: ['Education', 'EdTech'], families: ['swe', 'product', 'marketing', 'cs', 'design'] },
  { id: 'media', suffixes: ['Media', 'Studios'], industries: ['Media and Entertainment', 'Digital Media', 'Advertising'], families: ['marketing', 'marketing', 'design', 'swe', 'sales', 'data'] },
  { id: 'robotics', suffixes: ['Robotics', 'Automation'], industries: ['Robotics', 'Manufacturing', 'Hardware'], families: ['swe', 'swe', 'data', 'ops', 'product'] },
  { id: 'staffing', suffixes: ['Staffing', 'Talent Partners'], industries: ['Staffing and Recruiting', 'Human Resources'], families: ['swe', 'ops', 'finance', 'nurse'], staffing: true },
];

interface Family {
  fn: string;
  department: string;
  titles: Array<{ t: string; level?: string }>;
  skills: string[];
  pay: { period: PayPeriod; lo: number; hi: number };
  duties: string[];
}

const FAMILIES: Record<string, Family> = {
  swe: {
    fn: 'Software Engineering', department: 'Engineering',
    titles: [
      { t: 'Software Engineer' }, { t: 'Senior Software Engineer' }, { t: 'Backend Engineer' }, { t: 'Frontend Engineer' },
      { t: 'Full Stack Engineer' }, { t: 'Staff Software Engineer' }, { t: 'Site Reliability Engineer' }, { t: 'Mobile Engineer, iOS' },
      { t: 'Engineering Manager' }, { t: 'Software Engineering Intern' }, { t: 'New Grad Software Engineer' }, { t: 'Senior Backend Engineer, Payments Platform' },
    ],
    skills: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Java', 'SQL', 'PostgreSQL', 'React', 'Node.js', 'AWS', 'Docker', 'Kubernetes', 'GraphQL', 'Terraform', 'C++', 'C#', '.NET', 'Rust', 'Swift', 'Kotlin'],
    pay: { period: 'year', lo: 95_000, hi: 245_000 },
    duties: ['Design, build and run services that handle real customer traffic', 'Review code and help teammates ship safely', 'Improve reliability, test coverage and deploy speed', 'Work with product and design to scope new features'],
  },
  data: {
    fn: 'Data & Analytics', department: 'Data',
    titles: [{ t: 'Data Analyst' }, { t: 'Data Scientist' }, { t: 'Machine Learning Engineer' }, { t: 'Data Engineer' }, { t: 'Analytics Engineer' }, { t: 'Senior Data Scientist' }],
    skills: ['Python', 'SQL', 'Spark', 'Airflow', 'dbt', 'Tableau', 'Statistics', 'Machine Learning', 'PyTorch', 'A/B Testing', 'Excel', 'AWS'],
    pay: { period: 'year', lo: 80_000, hi: 210_000 },
    duties: ['Build dashboards and models the business uses every day', 'Own data pipelines from source to report', 'Design experiments and explain the results', 'Partner with teams to answer open questions with data'],
  },
  product: {
    fn: 'Product', department: 'Product',
    titles: [{ t: 'Product Manager' }, { t: 'Senior Product Manager' }, { t: 'Associate Product Manager' }],
    skills: ['Jira', 'SQL', 'A/B Testing', 'Figma', 'Roadmapping'],
    pay: { period: 'year', lo: 110_000, hi: 230_000 },
    duties: ['Own the roadmap for one product area', 'Talk to customers every week', 'Write clear specs with engineering and design', 'Measure launches and decide what comes next'],
  },
  design: {
    fn: 'Design', department: 'Design',
    titles: [{ t: 'Product Designer' }, { t: 'Senior Product Designer' }, { t: 'UX Researcher' }, { t: 'Brand Designer' }],
    skills: ['Figma', 'Prototyping', 'User Research', 'Design Systems', 'Illustration'],
    pay: { period: 'year', lo: 85_000, hi: 190_000 },
    duties: ['Design flows from first sketch to shipped pixels', 'Run research sessions and share what you learn', 'Grow the design system', 'Pair with engineers during the build'],
  },
  nurse: {
    fn: 'Nursing', department: 'Nursing',
    titles: [{ t: 'Registered Nurse - ICU' }, { t: 'Registered Nurse II - Med Surg' }, { t: 'Clinical Nurse Specialist' }, { t: 'Travel Nurse - Emergency Department' }, { t: 'Charge Nurse, Night Shift' }],
    skills: ['BLS', 'ACLS', 'Epic', 'CPR', 'Patient Care', 'Telemetry'],
    pay: { period: 'hour', lo: 34, hi: 72 },
    duties: ['Give safe, direct care to assigned patients', 'Work with physicians and the care team on each plan of care', 'Teach patients and families before discharge', 'Keep accurate records in the electronic health record'],
  },
  health: {
    fn: 'Healthcare', department: 'Clinical Operations',
    titles: [{ t: 'Medical Assistant' }, { t: 'Pharmacy Technician' }, { t: 'Patient Services Representative' }, { t: 'Physical Therapist' }],
    skills: ['Epic', 'CPR', 'Scheduling', 'Patient Care', 'Medical Terminology'],
    pay: { period: 'hour', lo: 18, hi: 48 },
    duties: ['Prepare rooms and patients for visits', 'Keep schedules and records up to date', 'Answer patient questions with care', 'Follow safety and privacy rules'],
  },
  finance: {
    fn: 'Accounting & Finance', department: 'Finance',
    titles: [{ t: 'Staff Accountant' }, { t: 'Financial Analyst' }, { t: 'Senior Financial Analyst' }, { t: 'Controller' }, { t: 'Payroll Specialist' }],
    skills: ['Excel', 'GAAP', 'NetSuite', 'QuickBooks', 'SAP', 'Financial Modeling', 'SQL'],
    pay: { period: 'year', lo: 62_000, hi: 185_000 },
    duties: ['Close the books each month on time', 'Build forecasts and explain changes', 'Keep controls and audits clean', 'Improve reporting for leaders'],
  },
  marketing: {
    fn: 'Marketing', department: 'Marketing',
    titles: [{ t: 'Marketing Manager' }, { t: 'Content Strategist' }, { t: 'Growth Marketing Manager' }, { t: 'Social Media Coordinator' }],
    skills: ['SEO', 'Google Analytics', 'HubSpot', 'Copywriting', 'A/B Testing', 'Excel'],
    pay: { period: 'year', lo: 58_000, hi: 165_000 },
    duties: ['Plan and run campaigns across channels', 'Write and edit clear copy', 'Track results and report on them', 'Work with sales on launches'],
  },
  sales: {
    fn: 'Sales', department: 'Sales',
    titles: [{ t: 'Account Executive' }, { t: 'Sales Development Representative' }, { t: 'Enterprise Account Executive' }],
    skills: ['Salesforce', 'HubSpot', 'Negotiation', 'Prospecting', 'Excel'],
    pay: { period: 'year', lo: 55_000, hi: 160_000 },
    duties: ['Build and manage a pipeline of new customers', 'Run discovery calls and demos', 'Close deals and hand them off well', 'Keep the CRM accurate'],
  },
  cs: {
    fn: 'Customer Success', department: 'Customer Success',
    titles: [{ t: 'Customer Success Manager' }, { t: 'Support Specialist' }, { t: 'Implementation Consultant' }],
    skills: ['Zendesk', 'Salesforce', 'SQL', 'Onboarding', 'Excel'],
    pay: { period: 'year', lo: 52_000, hi: 130_000 },
    duties: ['Help customers get value in their first 90 days', 'Answer questions and solve problems', 'Share customer feedback with product', 'Grow accounts over time'],
  },
  ops: {
    fn: 'Operations', department: 'Operations',
    titles: [{ t: 'Operations Coordinator' }, { t: 'Supply Chain Analyst' }, { t: 'Warehouse Associate' }, { t: 'Store Manager' }, { t: 'Field Service Technician' }],
    skills: ['Excel', 'Inventory Management', 'SAP', 'Forklift Certification', 'Scheduling', 'SQL'],
    pay: { period: 'hour', lo: 17, hi: 42 },
    duties: ['Keep daily operations running on time', 'Track inventory and orders', 'Follow and improve safety procedures', 'Train new team members'],
  },
  hr: {
    fn: 'Human Resources', department: 'People',
    titles: [{ t: 'Recruiter' }, { t: 'HR Generalist' }, { t: 'People Operations Partner' }],
    skills: ['Greenhouse', 'Interviewing', 'Employee Relations', 'Excel', 'HRIS'],
    pay: { period: 'year', lo: 58_000, hi: 140_000 },
    duties: ['Run hiring processes from intake to offer', 'Support managers on people questions', 'Keep policies and records current', 'Help plan onboarding'],
  },
  legal: {
    fn: 'Legal', department: 'Legal',
    titles: [{ t: 'Paralegal' }, { t: 'Corporate Counsel' }, { t: 'Compliance Analyst' }],
    skills: ['Contract Review', 'Compliance', 'Legal Research', 'Excel'],
    pay: { period: 'year', lo: 60_000, hi: 210_000 },
    duties: ['Review and draft contracts', 'Track regulatory changes', 'Keep records organized', 'Advise teams on risk'],
  },
};

export const JOB_FUNCTIONS = [...new Set(Object.values(FAMILIES).map((f) => f.fn))];

/** The canonical skill names the mock recognises in posting text (the real one is @jobleft/static-data). */
export const SKILLS: readonly string[] = [...new Set(Object.values(FAMILIES).flatMap((f) => f.skills))];

const BENEFITS = ['Medical, dental and vision coverage', '401(k) with a company match', 'Paid parental leave', 'Flexible paid time off', 'Learning budget', 'Commuter benefits', 'Home office stipend'];
const INVESTORS = ['Northgate Ventures', 'Blue Harbor Capital', 'Tallgrass Partners', 'Signal Peak Fund', 'Crosswind Ventures', 'Oakline Growth', 'Tern Capital'];
const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Taylor', 'Quinn', 'Rowan', 'Emerson', 'Parker', 'Sasha', 'Devon', 'Reese', 'Hayden', 'Kendall', 'Logan', 'Marlowe', 'Noel', 'Skyler', 'Tatum'];
const LAST = ['Okafor', 'Lindqvist', 'Ramirez', 'Chen', 'Nakamura', 'Haddad', 'Novak', 'Brennan', 'Achebe', 'Kowalski', 'Moreau', 'Silva', 'Ivanova', 'Park', 'Dubois', 'Mensah', 'Rossi', 'Varga', 'Holm', 'Quispe'];
const OUTLETS = ['Local Business Journal', 'Industry Weekly', 'City Tribune', 'Trade Daily'];

// ------------------------------------------------------------------ generator

export interface GenerateOptions {
  seed: number;
  boards: number;
  postingsPerBoard: number;
  /** "now" in ms: posted dates are placed before it. */
  now: number;
}

export interface Generated {
  boards: BoardFile[];
  companies: CompanyFixture[];
}

function money(r: () => number, lo: number, hi: number, step: number): number {
  return Math.round((lo + r() * (hi - lo)) / step) * step;
}

function payText(p: RawPay): string {
  const unit = { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month', year: 'per year' }[p.period];
  const sym = p.currency === 'USD' ? '$' : p.currency === 'CAD' ? 'CA$' : p.currency === 'GBP' ? '£' : p.currency === 'EUR' ? '€' : `${p.currency} `;
  const fmt = (v: number) => `${sym}${v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  if (p.min !== null && p.max !== null) return p.min === p.max ? `${fmt(p.min)} ${unit}` : `${fmt(p.min)} to ${fmt(p.max)} ${unit}`;
  if (p.min !== null) return `from ${fmt(p.min)} ${unit}`;
  return `up to ${fmt(p.max!)} ${unit}`;
}

function currencyFor(c: City): string {
  if (c.country === 'CA') return 'CAD';
  if (c.country === 'GB') return 'GBP';
  if (c.country === 'IE' || c.country === 'DE') return 'EUR';
  return 'USD';
}

function levelWordsFor(title: string): { minYears: number | null; maxYears: number | null } {
  const t = title.toLowerCase();
  if (/intern|new grad/.test(t)) return { minYears: 0, maxYears: 1 };
  if (/staff|principal|controller|counsel|manager/.test(t)) return { minYears: 7, maxYears: null };
  if (/senior|charge/.test(t)) return { minYears: 5, maxYears: null };
  if (/associate|coordinator|representative|assistant|technician/.test(t)) return { minYears: 0, maxYears: 2 };
  return { minYears: 2, maxYears: 4 };
}

export function generate(opts: GenerateOptions): Generated {
  const master = rng(opts.seed);
  const used = new Set<string>();
  const boards: BoardFile[] = [];
  const companies: CompanyFixture[] = [];
  const usCities = CITIES.filter((c) => c.country === 'US');
  const intlCities = CITIES.filter((c) => c.country !== 'US');

  for (let b = 0; b < opts.boards; b++) {
    const sector = b === 3 ? SECTORS.find((s) => s.id === 'staffing')! : pick(master, SECTORS.filter((s) => !s.staffing || master() < 0.3));
    let name = '';
    for (let tries = 0; tries < 50; tries++) {
      const n = `${pick(master, NAME_PREFIX)} ${pick(master, sector.suffixes)}`;
      if (!used.has(n)) { name = n; break; }
    }
    if (!name) name = `${pick(master, NAME_PREFIX)} ${pick(master, sector.suffixes)} ${b}`;
    used.add(name);
    const legal = master() < 0.35 ? `${name}, Inc.` : master() < 0.15 ? `${name} LLC` : name;
    const key = companyKey(legal);
    const ats = pick(master, ['greenhouse', 'lever', 'ashby'] as const);
    const board = slug(name).replace(/-/g, '');
    const r = rng(hash32(`${opts.seed}:${board}`));
    const hq = r() < 0.9 ? pick(r, usCities) : pick(r, intlCities);

    // ---- company facts (some companies have none at all)
    const known = r() < 0.8;
    const stage: CompanyStage | null = known ? pick(r, ['early', 'growth', 'late', 'public'] as const) : null;
    const h1bKind = r();
    const years = [2026, 2025, 2024, 2023, 2022];
    let h1b: H1bSummary | null = null;
    if (!sector.staffing && h1bKind < 0.45) {
      const likely = h1bKind < 0.3;
      const byYear = years.map((y, i) => ({ year: y, count: likely ? 20 + Math.floor(r() * 400) : Math.floor(r() * 4), partial: i === 0, yearKind: 'fiscal' as const }));
      const total = byYear.reduce((s, x) => s + x.count, 0);
      if (total > 0) {
        h1b = {
          status: likely ? 'likely' : 'some_history',
          certifiedFilings: total,
          window: { from: '2022-10-01', to: '2026-06-30' },
          byYear,
          similarRoleShare: r() < 0.7 ? Math.round(r() * 100) / 100 : null,
          roleFamily: r() < 0.7 ? 'Engineering and Development' : null,
          filerEntities: [legal.toUpperCase().replace(/,/g, '')],
          dataThrough: '2026-06-30',
          source: 'US Department of Labor, LCA disclosure data (stand-in copy for the mock)',
          note: 'Past filings show the company has sponsored H-1B workers. They do not promise sponsorship for this role.',
        };
      }
    }
    const aiWritten = known && r() < 0.25;
    companies.push({
      key,
      name: legal,
      industries: known ? pickSome(r, sector.industries, 1, 3) : [],
      stage,
      size: known ? pick(r, ['11-50 employees', '51-200 employees', '201-500 employees', '501-1,000 employees', '1,001-5,000 employees', '5,001-10,000 employees']) : null,
      founded: known && r() < 0.85 ? 1950 + Math.floor(r() * 74) : null,
      headquarters: known ? cityText(hq) + (hq.country === 'US' ? ', USA' : '') : null,
      description: known ? `${name} works in ${sector.industries[0]!.toLowerCase()} and has teams across ${hq.city} and other cities.` : null,
      totalFundingUsd: stage && stage !== 'public' && r() < 0.7 ? money(r, 2_000_000, 400_000_000, 100_000) : null,
      investors: stage && stage !== 'public' && r() < 0.6 ? pickSome(r, INVESTORS, 1, 3) : null,
      leaders: known && r() < 0.6 ? [{ name: `${pick(r, FIRST)} ${pick(r, LAST)}`, title: 'Chief Executive Officer' }, { name: `${pick(r, FIRST)} ${pick(r, LAST)}`, title: 'Chief Operating Officer' }] : null,
      news: known && r() < 0.4 ? [{ title: `${name} opens a new office in ${hq.city}`, publishedAt: '2026-08-12', outlet: pick(r, OUTLETS) }] : null,
      isStaffingAgency: sector.staffing ? true : known ? false : null,
      h1b,
      aiWritten,
    });

    // ---- postings
    const count = Math.max(1, Math.round(opts.postingsPerBoard * (0.6 + r() * 0.8)));
    const postings: RawPosting[] = [];
    for (let i = 0; i < count; i++) {
      const fam = FAMILIES[pick(r, sector.families)]!;
      const titleEntry = pick(r, fam.titles);
      let title = titleEntry.t;
      if (i === 0 && b === 1) title = 'Principal Software Engineer, Distributed Systems and Developer Productivity for Payments, Risk and Ledger Infrastructure Platform (Remote, US)';
      const externalId = String(4000 + b * 1000 + i);

      // locations: none, one, several (up to 12), or remote
      const locRoll = r();
      let locs: City[] = [];
      let workplace: RawPosting['workplace'] = pick(r, ['onsite', 'onsite', 'hybrid', 'remote', null] as const);
      if (locRoll < 0.06) locs = [];
      else if (locRoll < 0.12) locs = pickSome(r, usCities, 3, 12);
      else if (locRoll < 0.2) locs = pickSome(r, usCities, 2, 3);
      else locs = [r() < 0.7 ? hq : pick(r, r() < 0.85 ? usCities : intlCities)];
      const locations = locs.map(cityText);
      let remoteLine: string | null = null;
      if (workplace === 'remote') {
        remoteLine = pick(r, ['Remote (US only)', 'Remote - United States', 'Remote, anywhere in North America', 'Remote (open to EU time zones)']);
        if (r() < 0.5) locations.unshift(remoteLine.startsWith('Remote (US') ? 'Remote - US' : 'Remote');
      }
      const firstCity = locs[0] ?? hq;
      const currency = currencyFor(firstCity);

      // employment type
      let employmentType: EmploymentType | null = /intern/i.test(title) ? 'internship' : pick(r, ['full_time', 'full_time', 'full_time', 'full_time', 'contract', 'part_time', null] as const);
      if (/travel nurse/i.test(title)) employmentType = 'contract';

      // pay: board field, text only, several ranges, or none
      const payRoll = r();
      let pay: RawPay | null = null;
      let payInTextOnly = false;
      if (payRoll < 0.62) {
        const lo = fam.pay.period === 'hour' ? money(r, fam.pay.lo, fam.pay.hi * 0.8, 0.5) : money(r, fam.pay.lo, fam.pay.hi * 0.8, 1000);
        const hi = fam.pay.period === 'hour' ? Math.min(fam.pay.hi, lo + money(r, 4, 20, 0.5)) : Math.min(fam.pay.hi, lo + money(r, 15_000, 70_000, 1000));
        const shape = r();
        pay = shape < 0.08 ? { min: null, max: hi, currency, period: fam.pay.period, ranges: 1 }
          : shape < 0.14 ? { min: lo, max: null, currency, period: fam.pay.period, ranges: 1 }
            : shape < 0.18 ? { min: lo, max: lo, currency, period: fam.pay.period, ranges: 1 }
              : { min: lo, max: hi, currency, period: fam.pay.period, ranges: shape > 0.93 ? 2 : 1 };
        payInTextOnly = r() < 0.25;
      }

      // posted date: most within 40 days, some near midnight UTC, some not stated
      let postedAt: string | null;
      const pr = r();
      if (pr < 0.07) postedAt = null;
      else if (pr < 0.1) {
        const d = new Date(opts.now - Math.floor(r() * 5) * DAY_MS);
        d.setUTCHours(r() < 0.5 ? 23 : 0, r() < 0.5 ? 50 : 10, 0, 0);
        postedAt = d.getTime() > opts.now ? new Date(d.getTime() - DAY_MS).toISOString() : d.toISOString();
      } else {
        const ageMs = Math.floor(Math.pow(r(), 2) * 40 * DAY_MS) + Math.floor(r() * 3 * HOUR_MS);
        postedAt = new Date(opts.now - ageMs).toISOString();
      }

      // description (plain text)
      const years = levelWordsFor(title);
      const stateYears = r() < 0.75;
      const reqSkills = pickSome(r, fam.skills, 2, 5);
      const niceSkills = pickSome(r, fam.skills.filter((s) => !reqSkills.includes(s)), 0, 2);
      const sponsorRoll = r();
      const clearance = fam.fn === 'Software Engineering' && r() < 0.05;
      const citizen = !clearance && r() < 0.03;
      const short = r() < 0.03;
      const lines: string[] = [];
      if (short) {
        lines.push(`${title} at ${name}. Apply on our careers page.`);
      } else {
        lines.push('About the role');
        lines.push(`${name} is hiring a ${title} to join the ${fam.department} team${locs[0] ? ` in ${locs[0].city}` : ''}. You will work with a small, friendly team and a clear plan for the year.${workplace === 'remote' && remoteLine ? ` This role is ${remoteLine.replace(/^Remote/, 'remote')}.` : workplace === 'hybrid' ? ' This is a hybrid role: three days a week in the office.' : ''}`);
        lines.push('');
        lines.push('What you will do');
        for (const d of pickSome(r, fam.duties, 3, 4)) lines.push(`- ${d}`);
        lines.push('');
        lines.push('What you need');
        if (stateYears && years.minYears !== null) {
          if (years.maxYears !== null) lines.push(`- ${years.minYears} to ${years.maxYears} years of professional experience`);
          else lines.push(`- ${years.minYears}+ years of professional experience`);
        }
        lines.push(`- Hands-on skill with ${reqSkills.join(', ')}`);
        if (fam.fn === 'Nursing') lines.push('- Current RN license in the state of practice');
        if (clearance) lines.push('- Active Secret security clearance is required');
        if (citizen) lines.push('- US citizenship is required for this role');
        if (niceSkills.length) {
          lines.push('');
          lines.push('Nice to have');
          for (const s of niceSkills) lines.push(`- Experience with ${s}`);
        }
        if (pay && (payInTextOnly || r() < 0.5)) {
          lines.push('');
          lines.push('Pay');
          lines.push(`The pay for this role is ${payText(pay)}${pay.ranges > 1 ? ' in our main office; a second range applies in other cities' : ''}. Final pay depends on skills and location.`);
        }
        lines.push('');
        lines.push('Benefits');
        for (const x of pickSome(r, BENEFITS, 2, 4)) lines.push(`- ${x}`);
        if (sponsorRoll < 0.1) { lines.push(''); lines.push('Visa sponsorship is available for this position.'); }
        else if (sponsorRoll < 0.2) { lines.push(''); lines.push('We are unable to sponsor employment visas for this position.'); }
        lines.push('');
        lines.push(`${name} is an equal opportunity employer.`);
      }

      postings.push({
        externalId,
        title,
        locations,
        workplace,
        employmentType,
        department: r() < 0.8 ? fam.department : null,
        postedAt,
        pay: payInTextOnly ? null : pay,
        description: lines.join('\n'),
        hasApplyPage: r() < 0.4,
      });
    }
    boards.push({ id: `${ats}:${board}`, ats, board, company: legal, postings });
  }
  return { boards, companies };
}

/** The function family of a title (the mock's stand-in for the store's job-function mapping). */
export function functionOf(title: string): string | null {
  const t = title.toLowerCase();
  for (const f of Object.values(FAMILIES)) {
    if (f.titles.some((x) => x.t.toLowerCase() === t)) return f.fn;
  }
  if (/engineer|developer|sre|software/.test(t)) return 'Software Engineering';
  if (/data|analyst|scientist|machine learning/.test(t)) return 'Data & Analytics';
  if (/nurse|rn\b/.test(t)) return 'Nursing';
  if (/product manager/.test(t)) return 'Product';
  if (/designer|ux/.test(t)) return 'Design';
  if (/account|finance|payroll|controller/.test(t)) return 'Accounting & Finance';
  if (/marketing|content|social/.test(t)) return 'Marketing';
  if (/sales|account executive/.test(t)) return 'Sales';
  if (/recruit|hr |people/.test(t)) return 'Human Resources';
  return null;
}

// ------------------------------------------------------------------ the persona's connections file

/** A LinkedIn-style Connections.csv for the made-up persona (fictional people at fixture companies). */
export function connectionsCsv(companies: CompanyFixture[], seed: number, count = 60): string {
  const r = rng(seed ^ 0x5eed);
  const positions = ['Senior Recruiter', 'Technical Recruiter', 'Engineering Manager', 'Software Engineer', 'Data Scientist', 'Product Manager', 'Nurse Manager', 'Director of Engineering', 'Talent Acquisition Partner', 'Staff Engineer', 'Financial Analyst'];
  const rows: string[] = [
    'Notes:',
    '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  ];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const special = [['伟', '陈'], ['さくら', '中村'], ['נועה', 'לוי'], ['Ã‰milie', 'DuprÃ©']];
  for (let i = 0; i < count; i++) {
    const [first, last] = i < special.length ? special[i]! : [pick(r, FIRST), pick(r, LAST)];
    const c = r() < 0.85 ? pick(r, companies.slice(0, Math.min(companies.length, 25))) : null;
    const email = r() < 0.3 ? `${slug(first).replace(/-/g, '') || 'contact'}.${i}@mail.invalid` : '';
    const d = `${String(1 + Math.floor(r() * 28)).padStart(2, '0')} ${pick(r, months)} ${2016 + Math.floor(r() * 10)}`;
    const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    rows.push([first, last, `https://people.invalid/in/made-up-person-${i}`, email, c ? q(c.name) : '', q(pick(r, positions)), d].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}
