// Typed fixtures: each one must type-check against its TypeScript type AND validate against its schema at run
// time (test/contracts.test.ts). Other packages may import them for their own tests.
// Persona: the fake "Jordan Testwell" (jordan.testwell@example.com). No real person's data.

import type {
  ChatStreamEvent, Company, FillRequest, FillResponse, Job, JobSearchResponse, MatchResult, NetworkContact, PairRequest,
  Profile, PublikWallet, Resume, ReviewResult, TrackerEntry,
} from '../src/index.ts';

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-24T12:00:00.000Z';

export const job: Job = {
  id: 'greenhouse:acmehealth:4001',
  status: 'open',
  closedAt: null,
  closedReason: null,
  title: 'Registered Nurse II - ICU',
  company: 'Acme Health, Inc.',
  companyKey: 'acmehealth',
  ats: 'greenhouse',
  board: 'acmehealth',
  externalId: '4001',
  url: 'https://boards.greenhouse.io/acmehealth/jobs/4001',
  applyUrl: null,
  canonicalUrl: 'https://boards.greenhouse.io/acmehealth/jobs/4001',
  places: [
    { text: 'Austin, TX', city: 'Austin', region: 'TX', country: 'US', placeId: 'geonames:4671654' },
    { text: 'Round Rock, TX', city: 'Round Rock', region: 'TX', country: 'US', placeId: null },
  ],
  isUs: true,
  workModel: 'onsite',
  remoteScope: null,
  employmentType: 'full_time',
  level: 'mid',
  levels: ['mid'],
  yearsRequired: { min: 2, max: null },
  pay: { min: 38.5, max: 52, currency: 'USD', period: 'hour', source: 'board_field', ranges: 1, annualMin: 80080, annualMax: 108160 },
  postedAt: '2026-08-20T14:00:00.000Z',
  firstSeenAt: T0,
  lastSeenAt: T1,
  updatedAt: T1,
  department: 'Nursing',
  statements: { sponsorship: null, clearanceRequired: null, usCitizenOnly: null },
  skills: ['BLS', 'ACLS', 'Epic'],
  evidence: {
    level: { source: 'title', text: 'Registered Nurse II' },
    years: { source: 'description', text: '2+ years of ICU experience' },
  },
  sources: [{
    sourceId: 'ats:greenhouse', name: 'Acme Health careers (Greenhouse)', url: 'https://boards.greenhouse.io/acmehealth/jobs/4001',
    credit: null, firstSeenAt: T0, lastSeenAt: T1,
  }],
  duplicateOf: null,
  contentHash: 'b'.repeat(64),
  description: 'Care for ICU patients.\n\nRequirements\n- RN license\n- 2+ years of ICU experience',
};

export const profile: Profile = {
  id: 'default',
  personal: {
    firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '555-0100',
    addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US',
    links: [{ label: 'Portfolio', url: 'https://example.com/jordan' }],
  },
  summary: 'Software engineer with 3 years of backend experience.',
  education: [{
    id: 'edu1', school: 'Sample State University', degree: 'B.S.', major: 'Computer Science', gpa: null,
    startDate: '2017-01', endDate: '2021-01', current: false, achievements: [], coursework: [],
  }],
  work: [{
    id: 'w1', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: 'full_time', location: 'Austin, TX',
    startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Cut batch-job time by 30%.'],
  }],
  projects: [],
  certifications: [],
  skills: [{ name: 'TypeScript', years: 3, source: 'resume' }, { name: 'PostgreSQL', years: null, source: 'user' }],
  preferences: {
    jobFunctions: ['Software Engineer'], targetTitles: ['Backend Engineer'], employmentTypes: ['full_time'],
    workModels: ['onsite', 'hybrid', 'remote'], levels: ['mid', 'senior'], countries: ['US'],
    places: [{ text: 'Austin, TX', placeId: null, radiusMiles: 25 }], minAnnualPayUsd: null, industries: [],
    companyStages: [], roleTypes: ['ic'], excludedCompanies: [],
  },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: {
    disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null,
  },
  version: 'p1',
  updatedAt: T1,
};

export const match: MatchResult = {
  jobId: job.id,
  profileVersion: 'p1',
  engineVersion: 'match-0.1',
  percent: 88,
  band: 'strong',
  subScores: {
    experienceLevel: { percent: 90, reasons: [{ code: 'level_match', text: 'The job asks for Mid Level; you have 3 years.', points: 10 }] },
    skills: { percent: 100, reasons: [] },
    industryExperience: { percent: null, reasons: [{ code: 'industry_unknown', text: 'The posting states no industry.', points: 0 }] },
  },
  whyFit: [{ kind: 'skills', label: 'Skills match', positive: true }],
  blockers: [],
  reasons: [{ code: 'skills_all', text: 'You have all 3 required skills.', points: 20, evidence: 'BLS, ACLS, Epic' }],
  skills: { matched: ['Epic'], missing: [], required: ['Epic'], preferred: [] },
  computedAt: T1,
};

export const tracker: TrackerEntry = {
  jobId: job.id, liked: true, hidden: false, external: false, status: 'applied',
  statusHistory: [{ status: 'applied', at: T1 }], appliedAt: T1, resumeId: null,
  notes: [{ id: 'n1', text: 'Referral from a friend.', createdAt: T1, updatedAt: T1 }],
  reminders: [{ id: 'r1', at: '2026-10-01T15:00:00.000Z', text: 'Follow up', done: false }],
  createdAt: T1, updatedAt: T1,
};

export const contact: NetworkContact = {
  id: 'c1', firstName: 'Alex', lastName: 'Sample', profileUrl: 'https://www.linkedin.com/in/alex-sample-000',
  email: null, company: 'Acme Health, Inc.', companyKey: 'acmehealth', position: 'Senior Recruiter', connectedOn: '2024-03-15',
  maybeGarbled: false, stage: 'to_contact', note: null, followUpOn: null, inPlan: false, importedAt: T1, updatedAt: T1,
};

export const wallet: PublikWallet = {
  claimState: 'anonymous', balanceMicros: 250_000, starterRemainingMicros: 250_000, plan: 'none',
  week: { usedMicros: 0, budgetMicros: null, resetsAt: null },
  topUpUrl: 'https://publik.example.test/claim/HK7F-2QWD', claimUrl: 'https://publik.example.test/claim/HK7F-2QWD',
  addCreditUrl: null, updatedAt: T1,
};

export const company: Company = {
  key: 'acmehealth', name: 'Acme Health', aliases: ['Acme Health, Inc.'],
  facts: { founded: { value: 1998, source: { name: 'Example registry', url: 'https://registry.example.test/acme', retrievedAt: T1 } } },
  h1b: null, isStaffingAgency: null, factsFreshUntil: '2026-10-24T12:00:00.000Z', updatedAt: T1,
};

export const resume: Resume = {
  id: 'r-base-1', name: 'Jordan_Testwell_Resume', targetTitle: 'Backend Engineer', isPrimary: true, kind: 'base',
  baseResumeId: null, jobId: null, version: 1, file: null,
  document: {
    header: { name: 'Jordan Testwell', email: 'jordan.testwell@example.com', phone: '555-0100', city: 'Austin, TX', links: [] },
    sections: [{
      id: 's1', kind: 'experience', title: 'Experience', text: null,
      items: [{ id: 'i1', heading: 'Northwind Sample Labs', subheading: 'Software Engineer', location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, bullets: ['Cut batch-job time by 30%.'], tags: [] }],
    }],
  },
  importReport: null, atsReport: null, createdAt: T1, updatedAt: T1,
};

export const searchResponse: JobSearchResponse = {
  items: [{
    job: (({ description: _d, ...rest }) => ({ ...rest, snippet: 'Care for ICU patients.' }))(job),
    match: { percent: 88, band: 'strong', whyFit: [] }, liked: true, hidden: false, trackerStatus: 'applied',
    networkCount: 1, h1bTag: null, fitScore: 0.71,
  }],
  total: 1, nextCursor: null, fit: { state: 'ready', waiting: 0, model: 'bge-small-en-v1.5' }, tookMs: 12,
};

export const chatEvents: ChatStreamEvent[] = [
  { type: 'start', requestId: 'req-1', provider: 'local', model: 'qwen2.5:7b' },
  { type: 'delta', text: 'ready' },
  { type: 'done', incomplete: false, costMicros: null },
];

export const pairRequest: PairRequest = {
  code: '123456', extensionId: 'abcdefghijklmnopabcdefghijklmnop', extensionVersion: '0.1.0', protocolVersion: 1, browser: 'Chrome 140',
};

export const fillRequest: FillRequest = {
  requestId: 'fill-1', pageUrl: 'https://boards.greenhouse.io/acmehealth/jobs/4001', ats: 'greenhouse', step: null, resumeId: null,
  fields: [
    { fieldId: 'f1', label: 'First Name', name: 'first_name', kind: 'text', required: true, options: [], maxLength: null, section: null },
    { fieldId: 'f2', label: 'Resume/CV', name: 'resume', kind: 'file', required: true, options: [], maxLength: null, section: null },
  ],
};

export const fillResponse: FillResponse = {
  requestId: 'fill-1', jobId: job.id,
  fills: [{ fieldId: 'f1', values: ['Jordan'], source: 'profile', confidence: 'exact', needsReview: false }],
  unknownFieldIds: [], files: [{ fieldId: 'f2', fileName: 'Jordan_Testwell_Resume.pdf', mimeType: 'application/pdf', base64: 'JVBERi0=' }],
  warnings: [],
};

export const reviewResult: ReviewResult = {
  requestId: 'fill-1', pageUrl: 'https://boards.greenhouse.io/acmehealth/jobs/4001', jobId: job.id, ats: 'greenhouse',
  filledFieldIds: ['f1', 'f2'], editedFieldIds: [], submittedByUser: true, savedAnswers: [], at: T1,
};
