// Profile: the one local user's facts (the only source of truth for resumes and matching), job preferences,
// target titles, skills and work authorization. It never leaves the laptop except in the parts an AI step
// needs, sent only to the provider the user chose.

import { CountryCodeSchema, HttpUrlSchema, IdSchema, IsoDateTimeSchema, YearMonthSchema } from './common.ts';
import { CompanyStageSchema } from './company.ts';
import { PlaceQuerySchema } from './filter.ts';
import { EmploymentTypeSchema, ExperienceLevelSchema, WorkModelSchema } from './job.ts';
import { arr, bool, enm, named, nullable, num, obj, str, type Infer } from './schema.ts';

const YesNo = enm(['yes', 'no']);
/** Autofill answers: "decline" is a real answer ("Decline to state"). null = not answered. */
const YesNoDecline = enm(['yes', 'no', 'decline']);

export const LinkSchema = named(obj({ label: str(), url: HttpUrlSchema }), 'Link');

export const PersonalSchema = named(obj({
  firstName: nullable(str()),
  middleName: nullable(str()),
  lastName: nullable(str()),
  email: nullable(str()),
  phone: nullable(str()),
  addressLine: nullable(str()),
  city: nullable(str()),
  region: nullable(str()),
  postalCode: nullable(str()),
  country: nullable(CountryCodeSchema),
  links: arr(LinkSchema),
}), 'Personal');

export const EducationEntrySchema = named(obj({
  id: IdSchema,
  school: str(),
  degree: nullable(str()),
  major: nullable(str()),
  gpa: nullable(str()),
  startDate: nullable(YearMonthSchema),
  endDate: nullable(YearMonthSchema),
  current: bool(),
  achievements: arr(str()),
  coursework: arr(str()),
}), 'EducationEntry');

export const WorkEntrySchema = named(obj({
  id: IdSchema,
  company: str(),
  title: str(),
  employmentType: nullable(EmploymentTypeSchema),
  location: nullable(str()),
  startDate: nullable(YearMonthSchema),
  endDate: nullable(YearMonthSchema),
  current: bool(),
  summary: nullable(str()),
  bullets: arr(str()),
}), 'WorkEntry');

export const ProjectEntrySchema = named(obj({
  id: IdSchema,
  name: str(),
  description: nullable(str()),
  url: nullable(HttpUrlSchema),
  startDate: nullable(YearMonthSchema),
  endDate: nullable(YearMonthSchema),
  bullets: arr(str()),
}), 'ProjectEntry');

export const SkillEntrySchema = named(obj({
  name: str({ minLength: 1 }),
  /** Years of use the user states. null = not stated. */
  years: nullable(num({ minimum: 0, maximum: 60 })),
  /** resume = imported; user = typed or confirmed by the user. */
  source: enm(['resume', 'user']),
}), 'SkillEntry');

/** What the user is looking for. Feeds the default filter and the match score. */
export const JobPreferencesSchema = named(obj({
  jobFunctions: arr(str()),
  /** Target job titles, one per base resume or in general. */
  targetTitles: arr(str()),
  employmentTypes: arr(EmploymentTypeSchema),
  workModels: arr(WorkModelSchema),
  levels: arr(ExperienceLevelSchema),
  countries: arr(CountryCodeSchema),
  places: arr(PlaceQuerySchema),
  minAnnualPayUsd: nullable(num({ minimum: 0 })),
  industries: arr(str()),
  companyStages: arr(CompanyStageSchema),
  roleTypes: arr(enm(['ic', 'manager'])),
  excludedCompanies: arr(str()),
}), 'JobPreferences');

/** Work authorization answers. Used for blockers and the H-1B filter default. Never sent to an AI provider. */
export const WorkAuthorizationSchema = named(obj({
  usAuthorized: nullable(YesNo),
  needsSponsorship: nullable(YesNo),
  usCitizen: nullable(YesNo),
  hasSecurityClearance: nullable(YesNo),
  /** Other countries where the user may work. */
  authorizedCountries: arr(CountryCodeSchema),
}), 'WorkAuthorization');

/** Equal-employment answers. Used ONLY by autofill on the user's own review. Never sent to an AI provider. */
export const EeoAnswersSchema = named(obj({
  disability: nullable(YesNoDecline),
  veteran: nullable(YesNoDecline),
  gender: nullable(str()),
  lgbtq: nullable(YesNoDecline),
  race: nullable(str()),
  hispanicOrLatino: nullable(YesNoDecline),
  sexualOrientation: arr(str()),
  pronouns: nullable(str()),
}), 'EeoAnswers');

/** The fields the user edits. The server sets id, version and updatedAt. */
const PROFILE_INPUT_FIELDS = {
  personal: PersonalSchema,
  summary: nullable(str()),
  education: arr(EducationEntrySchema),
  work: arr(WorkEntrySchema),
  projects: arr(ProjectEntrySchema),
  certifications: arr(obj({ name: str(), issuer: nullable(str()), date: nullable(YearMonthSchema) })),
  skills: arr(SkillEntrySchema),
  preferences: JobPreferencesSchema,
  workAuthorization: WorkAuthorizationSchema,
  eeo: EeoAnswersSchema,
};

/** Optional editable fields, added after 1.0.0 (additive). Readers treat a missing field as empty. */
const PROFILE_INPUT_OPTIONAL = {
  /**
   * Skills the person marked "I don't have this" on a job (match lane). The match score never counts them, even when
   * a work bullet names them. "I have this" adds a SkillEntry with source "user" instead.
   */
  declinedSkills: arr(str({ minLength: 1 })),
};

/** The editable profile (PUT /api/v1/profile, and the proposal a resume import returns). */
export const ProfileInputSchema = named(obj(PROFILE_INPUT_FIELDS, PROFILE_INPUT_OPTIONAL), 'ProfileInput', 'The editable part of the profile');

export const ProfileSchema = named(obj({
  /** One local user: always "default". */
  id: str({ minLength: 1 }),
  ...PROFILE_INPUT_FIELDS,
  /** Hash of the facts; MatchResult.profileVersion refers to it. */
  version: str(),
  updatedAt: IsoDateTimeSchema,
}, PROFILE_INPUT_OPTIONAL), 'Profile', "The user's own facts, preferences and answers");

export type Link = Infer<typeof LinkSchema>;
export type Personal = Infer<typeof PersonalSchema>;
export type EducationEntry = Infer<typeof EducationEntrySchema>;
export type WorkEntry = Infer<typeof WorkEntrySchema>;
export type ProjectEntry = Infer<typeof ProjectEntrySchema>;
export type SkillEntry = Infer<typeof SkillEntrySchema>;
export type JobPreferences = Infer<typeof JobPreferencesSchema>;
export type WorkAuthorization = Infer<typeof WorkAuthorizationSchema>;
export type EeoAnswers = Infer<typeof EeoAnswersSchema>;
export type ProfileInput = Infer<typeof ProfileInputSchema>;
export type Profile = Infer<typeof ProfileSchema>;
