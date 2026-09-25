// Test helpers: the fake persona "Jordan Testwell" (jordan.testwell@example.com) only.

import type { Job, Profile } from '@jobleft/contracts';
import { normalizeProfile } from '../src/io.ts';
import { looseJob, type LooseJob } from '../src/loose.ts';
import { scoreMatch, type FullMatchResult } from '../src/index.ts';

export const NOW = Date.parse('2026-09-25T12:00:00Z');

export const PERSONA = {
  firstName: 'Jordan', lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '555-0100',
  city: 'Austin', region: 'TX', country: 'US',
};

type ProfileSketch = Record<string, unknown>;

export function profileOf(sketch: ProfileSketch = {}): Profile {
  return normalizeProfile({ personal: PERSONA, ...sketch });
}

export const SWE: ProfileSketch = {
  summary: 'Backend software engineer.',
  work: [
    { company: 'Northwind Cloud Software', title: 'Software Engineer', startDate: '2022-06', endDate: 'present', bullets: ['Built REST APIs in TypeScript on AWS.'] },
    { company: 'Fabrikam Bank', title: 'Junior Software Engineer', startDate: '2020-06', endDate: '2022-05', bullets: ['Maintained React dashboards.'] },
  ],
  education: [{ school: 'Sample State University', degree: 'B.S.', major: 'Computer Science', startDate: '2016-08', endDate: '2020-05' }],
  skills: ['JavaScript', 'TypeScript', 'Kubernetes', 'PostgreSQL', 'React', 'AWS', 'Docker', 'Git'],
  preferences: { jobFunctions: ['Software Engineer'], employmentTypes: ['full_time'], workModels: ['onsite', 'hybrid', 'remote'], places: [{ text: 'Austin, TX', radiusMiles: 25 }], countries: ['US'] },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: 'yes', hasSecurityClearance: 'no' },
};

export const NURSE: ProfileSketch = {
  work: [
    { company: "St. David's Medical Center", title: 'Registered Nurse, ICU', startDate: '2021-03', endDate: 'present', bullets: ['Cared for critically ill patients; charted in Epic.'] },
  ],
  education: [{ school: 'Sample State University', degree: 'BSN', major: 'Nursing', startDate: '2017-08', endDate: '2021-01' }],
  skills: ['Patient care', 'IV therapy', 'Telemetry', 'Epic', 'Patient assessment'],
  certifications: ['RN license (Texas)', 'BLS', 'ACLS'],
  preferences: { jobFunctions: ['Registered Nurse'], employmentTypes: ['full_time'], workModels: ['onsite'], places: [{ text: 'Austin, TX', radiusMiles: 30 }], countries: ['US'] },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: 'yes', hasSecurityClearance: 'no' },
};

export function job(x: Partial<LooseJob> & { title: string }): Job {
  return looseJob({ company: 'Fixture Co', location: 'Austin, TX', ...x });
}

export function score(profile: Profile, j: Job, extra: Partial<Parameters<typeof scoreMatch>[0]> = {}): FullMatchResult {
  return scoreMatch({ profile, job: j, company: null, now: NOW, ...extra });
}

/** The parts of a result a person sees (everything but the job id). */
export function view(r: FullMatchResult): unknown {
  const { jobId: _j, ...rest } = r;
  return rest;
}

/** Every quote the result shows from the posting. */
export function quotesOf(r: FullMatchResult): string[] {
  return [
    ...r.mustHaves.map((m) => m.quote), ...r.skillDetail.map((c) => c.quote),
    ...r.blockers.map((b) => b.evidence?.text ?? '').filter(Boolean),
    ...Object.values(r.jobFacts).map((f) => f.quote ?? '').filter(Boolean),
    ...r.dealBreakers.map((d) => d.quote ?? '').filter(Boolean),
  ];
}
