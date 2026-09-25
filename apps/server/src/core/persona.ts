// The test persona "Jordan Testwell" (jordan.testwell@example.com, a reserved example domain). Never a real person.
// `pnpm app:up -- --persona nurse-tx` (or backend-remote) saves one of these profiles right after the server starts,
// which is the same call the preference step makes, so the first-run board choice and the first crawl start.

import type { ProfileInput } from '@jobleft/contracts';

export const PERSONAS = ['nurse-tx', 'backend-remote', 'none'] as const;
export type Persona = (typeof PERSONAS)[number];

const personal = {
  firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 010 0199',
  addressLine: null, city: null, region: null, postalCode: null, country: 'US', links: [],
};
const blankEeo = { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null };
const blankPrefs = { minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] };

export function personaProfile(p: Exclude<Persona, 'none'>): ProfileInput {
  if (p === 'nurse-tx') {
    return {
      personal: { ...personal, city: 'Austin', region: 'TX' },
      summary: 'Registered nurse with six years of acute care and telemetry experience. Calm under pressure; precepts new graduates.',
      education: [{ id: 'edu1', school: 'Testwell State University', degree: 'Bachelor of Science in Nursing', major: 'Nursing', gpa: null, startDate: '2014-08', endDate: '2018-05', current: false, achievements: [], coursework: [] }],
      work: [
        { id: 'w1', company: 'Riverbend General Hospital', title: 'Registered Nurse, Telemetry', employmentType: 'full_time', location: 'Austin, TX', startDate: '2021-03', endDate: null, current: true, summary: null, bullets: ['Cared for 5 telemetry patients per shift', 'Precepted 8 new graduate nurses', 'Charted in Epic'] },
        { id: 'w2', company: 'Lakeside Medical Center', title: 'Registered Nurse, Med-Surg', employmentType: 'full_time', location: 'Waco, TX', startDate: '2018-07', endDate: '2021-02', current: false, summary: null, bullets: ['Medical-surgical unit, 32 beds', 'IV therapy and wound care'] },
      ],
      projects: [],
      certifications: [{ name: 'RN licence (Texas)', issuer: 'Texas Board of Nursing', date: '2018-07' }, { name: 'BLS', issuer: 'American Heart Association', date: '2025-01' }, { name: 'ACLS', issuer: 'American Heart Association', date: '2025-01' }],
      skills: [{ name: 'Patient care', years: 6, source: 'user' }, { name: 'Epic', years: 6, source: 'user' }, { name: 'Telemetry', years: 4, source: 'user' }],
      preferences: { ...blankPrefs, jobFunctions: ['Nursing'], targetTitles: ['Registered Nurse'], employmentTypes: ['full_time'], workModels: ['onsite'], levels: ['mid'], countries: ['US'], places: [{ text: 'Texas', placeId: null, radiusMiles: null }] },
      workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: 'yes', hasSecurityClearance: 'no', authorizedCountries: [] },
      eeo: blankEeo,
    };
  }
  return {
    personal: { ...personal, city: 'Denver', region: 'CO' },
    summary: 'Backend engineer with eight years building APIs and data pipelines in Go and Python on AWS.',
    education: [{ id: 'edu1', school: 'Testwell State University', degree: 'BS', major: 'Computer Science', gpa: null, startDate: '2011-08', endDate: '2015-05', current: false, achievements: [], coursework: [] }],
    work: [
      { id: 'w1', company: 'Northwind Payments', title: 'Senior Backend Engineer', employmentType: 'full_time', location: 'Remote', startDate: '2020-06', endDate: null, current: true, summary: null, bullets: ['Built Go services handling 4k requests per second', 'Owned PostgreSQL schema changes', 'Led the move to Kubernetes'] },
      { id: 'w2', company: 'Contoso Data', title: 'Software Engineer', employmentType: 'full_time', location: 'Denver, CO', startDate: '2015-07', endDate: '2020-05', current: false, summary: null, bullets: ['Python ETL on AWS', 'REST APIs'] },
    ],
    projects: [],
    certifications: [],
    skills: ['Go', 'Python', 'PostgreSQL', 'AWS', 'Kubernetes', 'Distributed systems'].map((name) => ({ name, years: 5, source: 'user' as const })),
    preferences: { ...blankPrefs, jobFunctions: ['Software Engineering'], targetTitles: ['Senior Backend Engineer'], employmentTypes: ['full_time'], workModels: ['remote'], levels: ['senior'], countries: ['US'], places: [] },
    workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: 'yes', hasSecurityClearance: 'no', authorizedCountries: [] },
    eeo: blankEeo,
  };
}
