// Synthetic job sets for size and speed tests. Deterministic (same seed, same jobs). No real employer, no real
// posting, no personal data. Descriptions have realistic lengths (median about 4,600 characters, like the crawled
// sample of spike S1) and mix role words with a broad vocabulary so the word index is not unrealistically small.

import type { Job } from '@jobleft/contracts';
import { companyKeyOf, contentHashOf } from './record.ts';

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Family {
  name: string;
  titles: string[];
  skills: string[];
  duties: string[];
  department: string;
}

const FAMILIES: Family[] = [
  { name: 'software', department: 'Engineering', titles: ['Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'Full Stack Developer', 'Mobile Engineer', 'Platform Engineer', 'Site Reliability Engineer', 'DevOps Engineer', 'Embedded Software Engineer', 'C++ Developer', '.NET Developer', 'Java Developer'],
    skills: ['Python', 'Java', 'Go', 'TypeScript', 'JavaScript', 'React', 'Node.js', 'C++', 'C#', '.NET', 'Kubernetes', 'AWS', 'PostgreSQL', 'Docker', 'Terraform', 'Rust', 'Kotlin', 'Swift', 'GraphQL', 'Redis'],
    duties: ['design, build and operate services that handle millions of requests', 'write clean, tested and maintainable code', 'review pull requests and mentor other engineers', 'improve reliability, latency and observability of production systems', 'partner with product managers to scope features', 'own services end to end, from design documents to on-call', 'debug complex distributed systems issues', 'automate deployment pipelines and infrastructure as code'] },
  { name: 'data', department: 'Data', titles: ['Data Scientist', 'Data Analyst', 'Data Engineer', 'Machine Learning Engineer', 'Analytics Engineer', 'Business Intelligence Analyst', 'Research Scientist'],
    skills: ['SQL', 'Python', 'R', 'Spark', 'dbt', 'Airflow', 'Tableau', 'Looker', 'PyTorch', 'TensorFlow', 'statistics', 'A/B testing', 'Snowflake', 'BigQuery', 'Excel'],
    duties: ['build dashboards and reports that leadership relies on', 'design experiments and analyze their results', 'train, evaluate and ship machine learning models', 'build reliable data pipelines and models', 'translate business questions into analyses', 'define metrics and keep them trustworthy'] },
  { name: 'accounting', department: 'Finance', titles: ['Staff Accountant', 'Senior Accountant', 'Accounts Payable Specialist', 'Accounts Receivable Specialist', 'Controller', 'Financial Analyst', 'Payroll Specialist', 'Tax Associate', 'Billing Coordinator', 'Revenue Accountant'],
    skills: ['GAAP', 'NetSuite', 'QuickBooks', 'Excel', 'SAP', 'reconciliations', 'month-end close', 'accounts payable', 'accounts receivable', 'financial reporting', 'budgeting', 'forecasting', 'audit', 'CPA'],
    duties: ['prepare journal entries and account reconciliations', 'support the month-end and year-end close', 'process vendor invoices and payments on time', 'prepare financial statements and variance analysis', 'work with auditors and keep documentation ready', 'build budgets and forecasts with department heads', 'maintain internal controls over financial reporting'] },
  { name: 'sales', department: 'Sales', titles: ['Account Executive', 'Sales Development Representative', 'Account Manager', 'Enterprise Account Executive', 'Sales Manager', 'Customer Success Manager', 'Business Development Representative', 'Inside Sales Representative'],
    skills: ['Salesforce', 'HubSpot', 'prospecting', 'negotiation', 'pipeline management', 'SaaS sales', 'cold calling', 'account management', 'forecasting', 'Gong', 'Outreach'],
    duties: ['prospect and qualify new business opportunities', 'run discovery calls and product demonstrations', 'manage a pipeline and forecast accurately', 'negotiate and close contracts with new customers', 'grow revenue within existing accounts', 'partner with marketing on campaigns and events'] },
  { name: 'marketing', department: 'Marketing', titles: ['Marketing Manager', 'Product Marketing Manager', 'Content Marketing Specialist', 'Growth Marketing Manager', 'Social Media Coordinator', 'SEO Specialist', 'Brand Designer', 'Demand Generation Manager'],
    skills: ['SEO', 'Google Analytics', 'HubSpot', 'copywriting', 'paid social', 'email marketing', 'content strategy', 'Figma', 'Marketo', 'brand strategy'],
    duties: ['plan and run campaigns across paid, owned and earned channels', 'write clear copy for the website, email and social', 'own positioning and messaging for product launches', 'measure campaign performance and report results', 'manage the content calendar and freelancers'] },
  { name: 'nursing', department: 'Clinical', titles: ['Registered Nurse', 'ICU Nurse', 'Licensed Practical Nurse', 'Nurse Practitioner', 'Medical Assistant', 'Clinical Nurse Manager', 'Patient Care Technician', 'Travel Nurse'],
    skills: ['BLS', 'ACLS', 'patient care', 'EMR', 'Epic', 'medication administration', 'triage', 'wound care', 'telemetry', 'IV therapy'],
    duties: ['provide direct patient care and document it in the electronic record', 'administer medications and monitor patient response', 'coordinate care with physicians and the care team', 'educate patients and families about treatment plans', 'follow infection control and safety protocols'] },
  { name: 'operations', department: 'Operations', titles: ['Operations Manager', 'Warehouse Associate', 'Logistics Coordinator', 'Supply Chain Analyst', 'Forklift Operator', 'Fulfillment Specialist', 'Distribution Center Supervisor', 'Procurement Specialist'],
    skills: ['inventory management', 'forklift', 'WMS', 'SAP', 'lean', 'Six Sigma', 'shipping and receiving', 'procurement', 'vendor management', 'Excel'],
    duties: ['coordinate inbound and outbound shipments', 'keep inventory accurate through cycle counts', 'lead a team of associates on the warehouse floor', 'improve processes with lean methods', 'negotiate with carriers and suppliers', 'track key performance indicators and fix gaps'] },
  { name: 'people', department: 'People', titles: ['Recruiter', 'Technical Recruiter', 'HR Generalist', 'People Operations Manager', 'HR Business Partner', 'Talent Acquisition Coordinator', 'Benefits Specialist'],
    skills: ['Greenhouse', 'Workday', 'sourcing', 'interviewing', 'employee relations', 'onboarding', 'benefits administration', 'HRIS', 'compensation'],
    duties: ['source and screen candidates for open roles', 'coordinate interviews and keep candidates informed', 'advise managers on employee relations matters', 'run onboarding for new hires', 'administer benefits and answer employee questions'] },
  { name: 'support', department: 'Support', titles: ['Customer Support Specialist', 'Technical Support Engineer', 'Help Desk Technician', 'Customer Service Representative', 'Support Team Lead', 'IT Support Specialist'],
    skills: ['Zendesk', 'troubleshooting', 'ticketing systems', 'customer service', 'Jira', 'Active Directory', 'networking', 'macOS', 'Windows'],
    duties: ['answer customer questions by chat, email and phone', 'troubleshoot technical issues and escalate bugs', 'write help center articles', 'meet response time and satisfaction goals', 'set up laptops and accounts for employees'] },
  { name: 'design', department: 'Design', titles: ['Product Designer', 'UX Designer', 'UX Researcher', 'Visual Designer', 'Design Lead', 'Graphic Designer'],
    skills: ['Figma', 'Sketch', 'prototyping', 'user research', 'design systems', 'Adobe Creative Suite', 'usability testing', 'interaction design'],
    duties: ['design flows, wireframes and high fidelity mockups', 'run user interviews and usability tests', 'maintain and extend the design system', 'partner with engineers through implementation'] },
  { name: 'legal', department: 'Legal', titles: ['Corporate Counsel', 'Paralegal', 'Contracts Manager', 'Compliance Analyst', 'Legal Operations Specialist'],
    skills: ['contract negotiation', 'compliance', 'privacy', 'GDPR', 'litigation support', 'legal research', 'regulatory'],
    duties: ['draft and negotiate commercial agreements', 'advise teams on regulatory and privacy questions', 'maintain the contract repository', 'support compliance programs and audits'] },
  { name: 'education', department: 'Education', titles: ['Teacher', 'Instructional Designer', 'Curriculum Developer', 'Academic Advisor', 'Tutor', 'Training Specialist'],
    skills: ['curriculum design', 'classroom management', 'LMS', 'instructional design', 'assessment', 'e-learning'],
    duties: ['plan and deliver lessons for diverse learners', 'design course materials and assessments', 'advise students on academic plans', 'train employees on new tools and processes'] },
  { name: 'trades', department: 'Field Operations', titles: ['Electrician', 'HVAC Technician', 'Maintenance Technician', 'Construction Project Manager', 'Plumber', 'Field Service Technician', 'Site Superintendent'],
    skills: ['OSHA', 'blueprint reading', 'preventive maintenance', 'electrical systems', 'HVAC', 'troubleshooting', 'project scheduling'],
    duties: ['install and repair equipment at customer sites', 'perform preventive maintenance on schedule', 'read blueprints and follow safety codes', 'manage subcontractors and the project schedule'] },
  { name: 'product', department: 'Product', titles: ['Product Manager', 'Senior Product Manager', 'Technical Program Manager', 'Project Manager', 'Program Coordinator', 'Scrum Master'],
    skills: ['roadmapping', 'Jira', 'agile', 'stakeholder management', 'user stories', 'SQL', 'product analytics'],
    duties: ['own the roadmap for a product area', 'write clear requirements and user stories', 'coordinate launches across teams', 'track milestones, risks and dependencies', 'use data and customer feedback to set priorities'] },
];

const LEVEL_PREFIX: Array<[string, Job['level'], number]> = [
  ['Intern, ', 'intern', 0.04], ['Junior ', 'entry', 0.12], ['', null, 0.44], ['Senior ', 'senior', 0.22], ['Staff ', 'staff', 0.06],
  ['Lead ', 'lead', 0.05], ['Principal ', 'principal', 0.03], ['Director of ', 'director', 0.04],
];

const CITIES: Array<[string, string, string]> = [
  ['New York', 'NY', 'US'], ['San Francisco', 'CA', 'US'], ['Austin', 'TX', 'US'], ['Seattle', 'WA', 'US'], ['Chicago', 'IL', 'US'],
  ['Boston', 'MA', 'US'], ['Los Angeles', 'CA', 'US'], ['Denver', 'CO', 'US'], ['Atlanta', 'GA', 'US'], ['Dallas', 'TX', 'US'],
  ['Houston', 'TX', 'US'], ['Miami', 'FL', 'US'], ['Phoenix', 'AZ', 'US'], ['Portland', 'OR', 'US'], ['Raleigh', 'NC', 'US'],
  ['Minneapolis', 'MN', 'US'], ['Nashville', 'TN', 'US'], ['Salt Lake City', 'UT', 'US'], ['Pittsburgh', 'PA', 'US'], ['Columbus', 'OH', 'US'],
  ['Washington', 'DC', 'US'], ['San Diego', 'CA', 'US'], ['Detroit', 'MI', 'US'], ['Philadelphia', 'PA', 'US'], ['Charlotte', 'NC', 'US'],
  ['Toronto', 'ON', 'CA'], ['Vancouver', 'BC', 'CA'], ['London', '', 'GB'], ['Dublin', '', 'IE'], ['Berlin', '', 'DE'],
  ['Bengaluru', 'KA', 'IN'], ['Amsterdam', '', 'NL'], ['Paris', '', 'FR'], ['Singapore', '', 'SG'], ['Sydney', 'NSW', 'AU'],
];

const SYLLABLES = ['ka', 'lo', 'mi', 'ra', 'ven', 'tor', 'qui', 'sen', 'dal', 'bri', 'nox', 'fer', 'lum', 'zor', 'pal', 'tek', 'ion', 'sa', 'ver', 'mon', 'ari', 'cel', 'dyn', 'gro', 'hal', 'jun', 'kor', 'lex', 'nav', 'orb'];
const COMPANY_TAILS = ['', '', ' Labs', ' Health', ' Systems', ' Group', ', Inc.', ' Technologies', ' Logistics', ' Financial', ' Energy', ' Foods', ' Robotics', ' Media'];
const INDUSTRIES = ['Software', 'Healthcare', 'Financial Services', 'Retail', 'Logistics', 'Manufacturing', 'Education', 'Media', 'Energy', 'Government', 'Consulting', 'Biotech'];
const STAGES = ['early', 'growth', 'late', 'public'] as const;

const COMMON = ('the of and to in a is that for it as was with be by on not he this are or his from at which but have an they you were her she ' +
  'there been one all we their has would when if so what up out about who them no can more some time could into only other ' +
  'new also two may after first most over well work years state world year made people where between both being under ' +
  'business company team customers product process quality growth support data plan project clients service goals results ' +
  'strategy performance systems tools market impact experience knowledge communication collaboration environment role ' +
  'opportunity mission culture values community operations technology information development management leadership ' +
  'responsibility ownership partners standards training schedule budget safety policy requirements documentation analysis').split(' ');

export interface SynthOptions {
  seed?: number;
  /** Reference time for posted dates (ms). */
  now?: number;
  /** Id prefix so two sets never collide. */
  prefix?: string;
}

/** Company facts that go with a synthetic set (industry, stage, staffing agency, H-1B history). */
export interface SynthCompany {
  name: string;
  key: string;
  industries: string[];
  stage: (typeof STAGES)[number] | null;
  isStaffingAgency: boolean | null;
  h1b: 'likely' | 'some_history' | null;
}

export class SynthGenerator {
  private readonly rnd: () => number;
  private readonly now: number;
  private readonly prefix: string;
  private readonly vocab: string[];
  private readonly zipf: Float64Array;
  readonly companies: SynthCompany[];

  constructor(opts: SynthOptions = {}) {
    this.rnd = prng(opts.seed ?? 42);
    this.now = opts.now ?? Date.parse('2026-09-25T12:00:00Z');
    this.prefix = opts.prefix ?? 'syn';
    // 40,000 rare words (pseudo-words) after the common ones, Zipf weights.
    const vocab = [...COMMON];
    const seen = new Set(vocab);
    while (vocab.length < 40_000) {
      const n = 2 + Math.floor(this.rnd() * 3);
      let w = '';
      for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(this.rnd() * SYLLABLES.length)];
      if (!seen.has(w)) { seen.add(w); vocab.push(w); }
    }
    this.vocab = vocab;
    const cum = new Float64Array(vocab.length);
    let s = 0;
    for (let i = 0; i < vocab.length; i++) { s += 1 / Math.pow(i + 1, 1.05); cum[i] = s; }
    for (let i = 0; i < cum.length; i++) cum[i]! /= s;
    this.zipf = cum;
    this.companies = [];
    const names = new Set<string>();
    while (this.companies.length < 8_000) {
      const n = 2 + Math.floor(this.rnd() * 2);
      let w = '';
      for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(this.rnd() * SYLLABLES.length)];
      const name = w[0]!.toUpperCase() + w.slice(1) + COMPANY_TAILS[Math.floor(this.rnd() * COMPANY_TAILS.length)];
      if (names.has(name)) continue;
      names.add(name);
      const r = this.rnd();
      this.companies.push({
        name,
        key: companyKeyOf(name),
        industries: r < 0.8 ? [INDUSTRIES[Math.floor(this.rnd() * INDUSTRIES.length)]!] : [],
        stage: this.rnd() < 0.7 ? STAGES[Math.floor(this.rnd() * STAGES.length)]! : null,
        isStaffingAgency: this.rnd() < 0.6 ? this.rnd() < 0.05 : null,
        h1b: r < 0.2 ? 'likely' : r < 0.3 ? 'some_history' : null,
      });
    }
  }

  private pick<T>(a: readonly T[]): T { return a[Math.floor(this.rnd() * a.length)]!; }

  private word(): string {
    const r = this.rnd();
    let lo = 0, hi = this.zipf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.zipf[mid]! < r) lo = mid + 1; else hi = mid; }
    return this.vocab[lo]!;
  }

  private sentence(min: number, max: number, extra: string[] = []): string {
    const n = min + Math.floor(this.rnd() * (max - min + 1));
    const words: string[] = [];
    for (let i = 0; i < n; i++) words.push(extra.length > 0 && this.rnd() < 0.12 ? this.pick(extra) : this.word());
    const s = words.join(' ');
    return s[0]!.toUpperCase() + s.slice(1) + '.';
  }

  /** Job number i of the set (deterministic for a given seed and i order). */
  job(i: number): Job {
    const fam = this.pick(FAMILIES);
    const company = this.companies[Math.floor(Math.pow(this.rnd(), 1.6) * this.companies.length)]!;
    let lr = this.rnd();
    let level: [string, Job['level'], number] = LEVEL_PREFIX[2]!;
    for (const l of LEVEL_PREFIX) { if (lr < l[2]) { level = l; break; } lr -= l[2]; }
    const baseTitle = this.pick(fam.titles);
    const title = level[1] === 'intern' ? `${baseTitle} Intern` : `${level[0]}${baseTitle}`;
    const skills: string[] = [];
    const nSkills = 3 + Math.floor(this.rnd() * 6);
    for (let k = 0; k < nSkills; k++) { const s = this.pick(fam.skills); if (!skills.includes(s)) skills.push(s); }
    const nPlaces = this.rnd() < 0.8 ? 1 : this.rnd() < 0.7 ? 2 : 3;
    const places: Job['places'] = [];
    for (let p = 0; p < nPlaces; p++) {
      const [city, region, country] = this.pick(CITIES);
      if (places.some((x) => x.city === city)) continue;
      places.push({ text: region ? `${city}, ${region}` : `${city}, ${country}`, city, region: region || null, country: country as Job['places'][number]['country'], placeId: null });
    }
    const wr = this.rnd();
    const workModel: Job['workModel'] = wr < 0.36 ? null : wr < 0.8 ? 'hybrid' : wr < 0.94 ? 'onsite' : 'remote';
    const yrs = level[1] === 'intern' ? 0 : level[1] === 'entry' ? 1 : level[1] === null ? 3 : level[1] === 'senior' ? 5 : 8;
    const yearsRequired = this.rnd() < 0.6 ? { min: yrs + Math.floor(this.rnd() * 2), max: this.rnd() < 0.3 ? yrs + 3 : null } : null;
    let pay: Job['pay'] = null;
    const pr = this.rnd();
    if (pr < 0.5) {
      const base = 40_000 + yrs * 18_000 + Math.floor(this.rnd() * 40) * 1_000;
      pay = { min: base, max: base + 20_000 + Math.floor(this.rnd() * 30) * 1_000, currency: 'USD', period: 'year', source: 'board_field', ranges: 1, annualMin: 0, annualMax: 0 };
      pay.annualMin = pay.min; pay.annualMax = pay.max;
    } else if (pr < 0.58) {
      const h = 16 + Math.floor(this.rnd() * 50);
      pay = { min: h, max: h + 8, currency: 'USD', period: 'hour', source: 'description', ranges: 1, annualMin: h * 2080, annualMax: (h + 8) * 2080 };
    }
    const postedAt = this.rnd() < 0.97 ? new Date(this.now - Math.floor(this.rnd() * 60 * 86_400_000)).toISOString() : null;
    const er = this.rnd();
    const employmentType: Job['employmentType'] = level[1] === 'intern' ? 'internship' : er < 0.1 ? null : er < 0.85 ? 'full_time' : er < 0.93 ? 'contract' : 'part_time';
    const sr = this.rnd();
    const sponsorship = sr < 0.05 ? 'yes' : sr < 0.12 ? 'no' : null;
    // Description: intro, role, duties, requirements, benefits, pay text, equal opportunity text.
    const paras: string[] = [];
    paras.push(`About ${company.name}: ` + Array.from({ length: 6 + Math.floor(this.rnd() * 5) }, () => this.sentence(10, 24)).join(' '));
    paras.push(`About the role: ${company.name} is hiring a ${title} to join the ${fam.department} team. ` +
      Array.from({ length: 4 + Math.floor(this.rnd() * 4) }, () => this.sentence(10, 22, skills)).join(' '));
    const duties = [...fam.duties].sort(() => this.rnd() - 0.5).slice(0, 4 + Math.floor(this.rnd() * 3));
    paras.push("What you'll do:\n" + duties.map((d) => `- ${d[0]!.toUpperCase()}${d.slice(1)}. ${this.sentence(8, 18, skills)} ${this.sentence(8, 16)}`).join('\n'));
    paras.push('What you bring:\n' + [
      yearsRequired ? `- ${yearsRequired.min}+ years of experience in a similar role.` : '- Experience in a similar role.',
      `- Working knowledge of ${skills.slice(0, 3).join(', ')}.`,
      ...Array.from({ length: 5 + Math.floor(this.rnd() * 5) }, () => `- ${this.sentence(8, 18, skills)}`),
    ].join('\n'));
    paras.push('Benefits: ' + Array.from({ length: 4 + Math.floor(this.rnd() * 5) }, () => this.sentence(10, 22)).join(' '));
    if (pay) paras.push(pay.period === 'hour' ? `The pay for this role is $${pay.min} to $${pay.max} per hour.` : `The base salary range for this role is $${pay.min!.toLocaleString('en-US')} to $${pay.max!.toLocaleString('en-US')} per year.`);
    if (sponsorship === 'no') paras.push('Visa sponsorship is not available for this position.');
    if (sponsorship === 'yes') paras.push('We sponsor work visas for this position.');
    paras.push('We are an equal opportunity employer. ' + this.sentence(12, 24));
    const description = paras.join('\n\n');
    const n = String(i).padStart(7, '0');
    const url = `https://jobs.example.com/${company.key}/${this.prefix}-${n}`;
    const iso = new Date(this.now).toISOString();
    const job: Job = {
      id: `${this.prefix}:${company.key}:${n}`, status: 'open', closedAt: null, closedReason: null,
      title, company: company.name, companyKey: company.key, ats: null, board: null, externalId: null,
      url, applyUrl: null, canonicalUrl: url, places, isUs: places.every((p) => p.country) ? places.some((p) => p.country === 'US') : null,
      workModel, remoteScope: workModel === 'remote' ? { regions: ['US'], text: 'Remote (US)' } : null,
      employmentType, level: level[1], levels: level[1] ? [({ intern: 'intern_new_grad', entry: 'entry', senior: 'senior', staff: 'lead_staff', lead: 'lead_staff', principal: 'lead_staff', director: 'director_exec' } as Record<string, Job['levels'][number]>)[level[1]]!] : [],
      yearsRequired, pay, postedAt, firstSeenAt: iso, lastSeenAt: iso, updatedAt: iso,
      department: fam.department, statements: { sponsorship, clearanceRequired: null, usCitizenOnly: null },
      skills, evidence: {},
      sources: [{ sourceId: 'synthetic', name: 'Synthetic test set', url, credit: null, firstSeenAt: iso, lastSeenAt: iso }],
      duplicateOf: null, contentHash: '', description,
    };
    job.contentHash = contentHashOf(job);
    return job;
  }
}
