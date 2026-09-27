import type { ProfileInput } from '../src/index.ts';
export { blankToNull, profileIssues, type ProfileInput } from '../src/index.ts';

export function emptyProfileLike(): ProfileInput {
  return {
    personal: { firstName: null, middleName: null, lastName: null, email: null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
    summary: null, education: [], work: [], projects: [], certifications: [], skills: [],
    preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
  };
}
