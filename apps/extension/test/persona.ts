// The test persona "Jordan Testwell" (jordan.testwell@example.com). No real person's data.
// Starts with NO sensitive answers saved (extension O6 starts from there).
import type { FormField, Profile } from '@jobleft/contracts';

export function persona(): Profile {
  return {
    id: 'default',
    personal: {
      firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '555-0100',
      addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US',
      links: [
        { label: 'LinkedIn', url: 'https://www.linkedin.com/in/jordan-testwell-example' },
        { label: 'Portfolio', url: 'https://example.com/jordan' },
      ],
    },
    summary: 'Software engineer with backend experience.',
    education: [{
      id: 'edu1', school: 'Sample State University', degree: 'B.S.', major: 'Computer Science', gpa: null,
      startDate: '2017-08', endDate: '2021-05', current: false, achievements: [], coursework: [],
    }],
    work: [{
      id: 'w1', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: 'full_time', location: 'Austin, TX',
      startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Built internal tools.'],
    }, {
      id: 'w0', company: 'Contoso Example Co', title: 'Junior Developer', employmentType: 'full_time', location: 'Dallas, TX',
      startDate: '2021-06', endDate: '2023-05', current: false, summary: null, bullets: [],
    }],
    projects: [],
    certifications: [],
    skills: [{ name: 'TypeScript', years: 3, source: 'user' }, { name: 'PostgreSQL', years: null, source: 'user' }],
    preferences: {
      jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: ['US'], places: [],
      minAnnualPayUsd: 150000, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [],
    },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
    version: 'p1',
    updatedAt: '2026-09-25T00:00:00.000Z',
  };
}

let n = 0;
export function field(label: string, over: Partial<FormField> = {}): FormField {
  n += 1;
  return { fieldId: over.fieldId ?? `f${n}`, label, name: null, kind: 'text', required: false, options: [], maxLength: null, section: null, ...over };
}

export const opts = (...labels: string[]) => labels.map((l) => ({ value: l, label: l }));
