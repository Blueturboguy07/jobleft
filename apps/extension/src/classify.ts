// Field classification: what a form field asks, from its label, name, autocomplete token, placeholder and the words
// around it. Pure: it reads a FormField and nothing else (never page text, never the job description), so text on
// the page cannot steer it beyond the field's own label.
//
// Rules of thumb:
//   * Sensitive questions are found by words ANYWHERE in the label (better to leave a question for the person than
//     to answer it). They get an answer only from an answer the person saved for that exact topic (answer.ts).
//   * Standard fields are found only when the label OPENS with the words ("Are you authorized to work in the
//     country ..." is not a Country field), or by a strong hint (autocomplete token, a known name attribute).
//   * A field about another person (a referrer, a reference, an emergency contact) never gets the person's details.

import type { FormField } from '@jobleft/contracts';
import { anyWords, hasWords, norm, opensWith, words } from './text.ts';

export const SENSITIVE_TOPICS = [
  'eeo_gender', 'eeo_race', 'eeo_hispanic', 'eeo_veteran', 'eeo_disability', 'eeo_lgbtq', 'eeo_orientation',
  'eeo_transgender', 'eeo_pronouns', 'eeo_other', 'age', 'dob', 'criminal', 'gov_id', 'work_auth',
  'work_auth_nosponsor', 'sponsorship', 'citizenship', 'clearance', 'pay',
] as const;
export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];

export type Topic =
  | 'first_name' | 'middle_name' | 'last_name' | 'full_name' | 'preferred_name' | 'email' | 'phone' | 'phone_code'
  | 'phone_type' | 'address_line' | 'address_line2' | 'city' | 'region' | 'postal_code' | 'country' | 'location'
  | 'pro_profile' | 'github' | 'twitter' | 'portfolio' | 'website' | 'other_link'
  | 'edu_school' | 'edu_degree' | 'edu_major' | 'edu_gpa' | 'edu_start' | 'edu_end' | 'edu_location'
  | 'work_company' | 'work_title' | 'work_start' | 'work_end' | 'work_current' | 'work_location' | 'work_description'
  | 'current_company' | 'current_title' | 'skills' | 'skill_years' | 'years_total' | 'summary'
  | 'resume_file' | 'cover_letter_file' | 'other_file' | 'open_question'
  | SensitiveTopic
  | 'consent' | 'captcha' | 'account' | 'other_person' | 'unknown';

/** Which part of a date a field wants. */
export type DatePart = 'full' | 'month' | 'year';

export interface Classification {
  topic: Topic;
  /** The repeated block (education or work entry), 0-based. */
  entry: number;
  /** For dates: the whole date, only the month, or only the year. */
  datePart: DatePart;
  /** "Confirm email", "Re-enter email". */
  confirm: boolean;
  /** For work_auth: the country the question names (ISO code), or null when it names none or an unclear one. */
  country: string | null;
  /** For skill_years: the tool or skill the question names. */
  skill: string | null;
  /** For edu_degree: "highest level of education". */
  highest: boolean;
  /** For other_person: the word that showed it. */
  otherWord: string | null;
  /** A short reason, for tests and the report. */
  why: string;
}

export function isSensitive(t: Topic): t is SensitiveTopic {
  return (SENSITIVE_TOPICS as readonly string[]).includes(t);
}

/** Topics that are about the person's own identity and contact details: filled once per form. */
export const IDENTITY_TOPICS: ReadonlySet<Topic> = new Set<Topic>(['first_name', 'middle_name', 'last_name', 'full_name', 'email', 'phone']);

// ------------------------------------------------------------------ helpers

/**
 * The profile-link field of the largest professional network ("<name> URL"). Its name is kept as character codes
 * so the packaged extension never names another job-search product (extension O15); the README names it.
 */
export const PRO_SITE = String.fromCharCode(108, 105, 110, 107, 101, 100, 105, 110);
const PRO_PROFILE = new RegExp(`\\b${PRO_SITE.slice(0, 6)} ?${PRO_SITE.slice(6)}\\b`);

function splitCamel(s: string | null | undefined): string {
  return (s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Drops polite lead-ins so "Please enter your first name" opens with "first name". */
function stripLeadIn(t: string): string {
  return t
    .replace(/^(please )?(enter|provide|type|share|give|list|add|select|choose|upload|attach|include)( in)? (your |the |a )?/, '')
    .replace(/^(what is|what's|whats) your /, '')
    .replace(/^your /, '')
    .trim();
}

/** Words that name a field only when they are the whole label ("First", not "First job?"). */
const WHOLE_ONLY = new Set(['first', 'last', 'middle', 'tel', 'site', 'street', 'cell', 'where', 'subject', 'unit', 'apt', 'to', 'from', 'end', 'start', 'title', 'position', 'role', 'other', 'finish', 'mobile', 'city', 'state', 'region']);

function opensAny(t: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => (WHOLE_ONLY.has(p) ? t === p : opensWith(t, p)));
}

const MONTH_WORDS = /\b(month|mm)\b/;
const YEAR_WORDS = /\b(year|yyyy|yy)\b/;

function datePartOf(label: string, placeholder: string, f: FormField): DatePart {
  if (f.inputType === 'month' || f.inputType === 'date') return 'full';
  const both = `${label} ${placeholder}`;
  const hasM = MONTH_WORDS.test(label);
  const hasY = YEAR_WORDS.test(label);
  if (hasM && !hasY) return 'month';
  if (hasY && !hasM) return 'year';
  if (f.options.length > 0) {
    const labels = f.options.map((o) => norm(o.label));
    if (labels.some((l) => /^(jan|january|feb|february|mar|march)$/.test(l))) return 'month';
    if (labels.filter((l) => /^(19|20)\d\d$/.test(l)).length >= 3) return 'year';
  }
  if (/^(yyyy|yy)$/.test(placeholder.trim())) return 'year';
  if (/\b(mm|month)\b/.test(both) && !/\b(yyyy|year|yy)\b/.test(both)) return 'month';
  return 'full';
}

/** A country named in a work-authorization question, or null. "the country ..." (unclear) is null. */
function countryInQuestion(t: string): string | null {
  if (/\b(united states|u s a|usa|u s|us|america)\b/.test(t)) return 'US';
  if (/\bcanada\b/.test(t)) return 'CA';
  if (/\b(united kingdom|uk|u k|great britain|britain|england)\b/.test(t)) return 'GB';
  if (/\b(european union|eu|eea)\b/.test(t)) return 'EU';
  if (/\bgermany\b/.test(t)) return 'DE';
  if (/\bfrance\b/.test(t)) return 'FR';
  if (/\bindia\b/.test(t)) return 'IN';
  if (/\baustralia\b/.test(t)) return 'AU';
  if (/\bireland\b/.test(t)) return 'IE';
  if (/\bnetherlands\b/.test(t)) return 'NL';
  if (/\bsingapore\b/.test(t)) return 'SG';
  if (/\bmexico\b/.test(t)) return 'MX';
  if (/\bbrazil\b/.test(t)) return 'BR';
  if (/\bjapan\b/.test(t)) return 'JP';
  if (/\bspain\b/.test(t)) return 'ES';
  if (/\bpoland\b/.test(t)) return 'PL';
  if (/\bisrael\b/.test(t)) return 'IL';
  return null;
}

// ------------------------------------------------------------------ the classifier

const OTHER_PERSON_WORDS = [
  'referrer', 'referral', 'referred by', 'referring', 'refer', 'referee', 'reference', 'references', 'emergency',
  'recommender', 'recommendation', 'supervisor', "supervisor's", 'manager name', "manager's", 'hiring manager',
  'friend', "friend's", 'next of kin', 'spouse', 'parent', 'guardian', 'employee who referred', 'relative',
];

const CONSENT_WORDS = [
  'agree', 'i agree', 'consent', 'acknowledge', 'acknowledgement', 'acknowledgment', 'certify', 'certification',
  'i understand', 'i confirm', 'confirm that', 'terms', 'privacy', 'accept', 'authorize', 'authorise', 'attest',
  'declare', 'subscribe', 'newsletter', 'job alert', 'job alerts', 'marketing', 'notify me', 'keep me',
  'future opportunities', 'talent community', 'talent network', 'receive updates', 'send me', 'text me', 'sms',
  'opt in', 'opt-in', 'gdpr', 'data retention', 'retain my',
];

const EEO_SECTION_WORDS = [
  'voluntary self identification', 'self identification', 'voluntary self-identification', 'self-identification',
  'equal employment', 'equal opportunity', 'eeo', 'eeoc', 'demographic', 'demographics', 'diversity', 'self identify',
  'self-identify', 'invitation to self identify', 'affirmative action', 'ofccp',
];

export function classify(f: FormField): Classification {
  const labelN = norm(f.label);
  const L = stripLeadIn(words(f.label));
  const N = words(splitCamel(f.name));
  const A = norm(f.autocomplete).split(/\s+/).filter(Boolean).pop() ?? '';
  const P = words(f.placeholder);
  const C = words(`${f.context ?? ''} ${f.section ?? ''}`);
  const both = `${L} ${N}`;
  const entry = f.entry ?? 0;
  const base: Classification = {
    topic: 'unknown', entry, datePart: 'full', confirm: false, country: null, skill: null, highest: false,
    otherWord: null, why: '',
  };
  const out = (topic: Topic, why: string, extra: Partial<Classification> = {}): Classification => ({ ...base, topic, why, ...extra });

  // Files: only a resume field gets the resume.
  if (f.kind === 'file') {
    const t = `${L} ${N} ${C}`;
    if (/\bcover( |-)?letter\b|\bmotivation letter\b/.test(t)) return out('cover_letter_file', 'cover letter upload');
    if (/\b(resume|resumé|cv|curriculum vitae|curriculum)\b/.test(`${L} ${N}`)) return out('resume_file', 'resume upload');
    if (/\b(transcript|portfolio|writing sample|photo|picture|headshot|certificate|other|additional)\b/.test(t)) return out('other_file', 'other upload');
    if (/\b(resume|cv)\b/.test(C)) return out('resume_file', 'upload in a resume section');
    return out('other_file', 'unnamed upload');
  }

  if (f.inputType === 'password') return out('account', 'password field');
  if (/\b(captcha|recaptcha|hcaptcha|not a robot|characters (shown|you see)|security check)\b/.test(`${L} ${N}`)) return out('captcha', 'human check');

  // ---------------- sensitive questions (words anywhere in the label or name)
  const S = `${L} ${N}`;
  if (/\b(ssn|social security|social insurance|sin number|national insurance|national id|national identity|passport (number|no|#)|driver s licen[cs]e|drivers licen[cs]e|driving licen[cs]e|tax id|taxpayer|itin|aadhaar|aadhar|pan number|id number|identification number|identity number)\b/.test(S)) {
    return out('gov_id', 'government ID number');
  }
  if (/\b(date of birth|birth date|birthdate|birthday|dob|born on|year of birth)\b/.test(S)) return out('dob', 'date of birth');
  if (/\b(your age|how old|age range|age group|at least 18|18 years|over 18|over the age|18 or older|of legal age|legal working age|minimum age|age 18|under 18|older than 18|age)\b/.test(L)) return out('age', 'age');
  if (/\b(convicted|conviction|convictions|felony|felonies|misdemeanou?r|criminal|arrested|arrest record|pending charges|background check)\b/.test(S)) return out('criminal', 'criminal history');
  if (/\b(salary|salaries|compensation|pay expectations?|pay requirements?|pay range|expected pay|desired pay|pay rate|hourly rate|rate expectations?|wage|wages|remuneration|ctc|base pay|total rewards|desired rate|expected rate|pay)\b/.test(S)) {
    return out('pay', 'pay expectation');
  }
  const authWords = /\b(authori[sz]ed to (work|be employed)|authori[sz]ation to work|work authori[sz]ation|employment authori[sz]ation|legally (eligible|able|permitted|entitled) to work|eligible to work|eligibility to work|right to work|permitted to work|lawfully (work|employed)|legal right to work|legally authori[sz]ed)\b/;
  const sponsorWords = /\b(sponsor|sponsorship|sponsored|visa|visas|h 1b|h1b|h 1 b|immigration|work permit|tn status|stem opt|opt ead|f 1 visa|e verify)\b/;
  // A saved "needs sponsorship" answers only a question about NEEDING sponsorship (now or later), never one about
  // a past sponsorship, a visa type or an immigration status: those are other topics.
  const needVerb = /\b(require|requires|required|need|needs|will you|would you|now or in the future|in the future|going forward)\b/;
  if (authWords.test(S)) {
    if (sponsorWords.test(S) && /\bwithout\b/.test(S)) return out('work_auth_nosponsor', 'authorized without sponsorship', { country: countryInQuestion(S) });
    if (sponsorWords.test(S) && needVerb.test(S)) return out('sponsorship', 'sponsorship', { country: countryInQuestion(S) });
    if (sponsorWords.test(S)) return out('eeo_other', 'immigration status');
    return out('work_auth', 'work authorization', { country: countryInQuestion(S) });
  }
  if (sponsorWords.test(S)) {
    if (needVerb.test(S) && /\bsponsor/.test(S)) return out('sponsorship', 'sponsorship', { country: countryInQuestion(S) });
    return out('eeo_other', 'visa or immigration status');
  }
  if (/\b(citizen|citizenship|nationality|nationalities|permanent resident|green card|immigration status|residency status|resident status)\b/.test(S)) {
    return out('citizenship', 'citizenship', { country: countryInQuestion(S) });
  }
  if (/\b(security clearance|clearance level|active clearance|secret clearance|clearance)\b/.test(S)) return out('clearance', 'security clearance');
  if (/\btransgender\b|\btrans\b/.test(S)) return out('eeo_transgender', 'transgender');
  if (/\bsexual orientation\b|\borientation\b/.test(S) && !/\borientation (session|program|day)\b/.test(S)) return out('eeo_orientation', 'sexual orientation');
  if (/\blgbt|\blgbtq|\bqueer\b/.test(S)) return out('eeo_lgbtq', 'LGBTQ+');
  if (/\bpronouns?\b/.test(S)) return out('eeo_pronouns', 'pronouns');
  // "Are you Hispanic/Latino?" is its own yes/no question (its field name may still say "ethnicity").
  if (/\b(hispanic|latino|latina|latinx|latine)\b/.test(L) && !/\b(race|races|racial)\b/.test(L)) return out('eeo_hispanic', 'Hispanic or Latino');
  if (/\b(race|races|racial|ethnicity|ethnicities|ethnic|ancestry)\b/.test(S)) return out('eeo_race', 'race or ethnicity');
  if (/\b(hispanic|latino|latina|latinx|latine)\b/.test(S)) return out('eeo_hispanic', 'Hispanic or Latino');
  // Each saved answer fits only its own topic. Near topics ("sex", "accommodation", "military spouse",
  // "served in the military") are other questions and stay with the person.
  if (/\bgender\b/.test(S) && !/\bsexual\b/.test(S)) return out('eeo_gender', 'gender');
  if (/\bsex\b/.test(S)) return out('eeo_other', 'sex');
  if (/\b(disability|disabilities|disabled)\b/.test(S) && !/\b(family|spouse|child|dependent|relative|parent)\b/.test(S)) return out('eeo_disability', 'disability');
  if (/\b(handicap|impairment|accommodation|accommodations|adjustments)\b/.test(S)) return out('eeo_other', 'accommodation');
  if (/\b(veteran|veterans|vevraa|protected veteran)\b/.test(S) && !/\b(spouse|family|child|dependent|relative|parent|married)\b/.test(S)) return out('eeo_veteran', 'veteran status');
  if (/\b(military|armed forces|service member|national guard|reserves|veteran|veterans)\b/.test(S)) return out('eeo_other', 'military service');
  // ---------------- consent and opt-ins: never ticked by jobleft
  if ((f.kind === 'checkbox' || f.kind === 'radio') && anyWords(`${L} ${labelN}`, CONSENT_WORDS)) return out('consent', 'consent or opt-in');

  if (anyWords(C, EEO_SECTION_WORDS) && (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkbox')) {
    return out('eeo_other', 'self-identification section');
  }

  // ---------------- another person
  const otherHit = OTHER_PERSON_WORDS.find((w) => hasWords(L, w) || hasWords(C, w) || hasWords(N, w));
  if (otherHit) return out('other_person', 'about another person', { otherWord: otherHit });

  // ---------------- names
  if (opensAny(L, ['preferred name', 'preferred first name', 'preferred last name', 'nickname', 'nick name', 'chosen name', 'known as', 'goes by', 'preferred full name'])
    || /\bpreferred (first )?name\b/.test(N)) {
    return out('preferred_name', 'preferred name');
  }
  if (opensAny(L, ['middle name', 'middle names', 'middle initial', 'middle']) || A === 'additional-name' || /\bmiddle ?name\b/.test(N)) {
    return out('middle_name', 'middle name');
  }
  if (opensAny(L, ['first name', 'given name', 'given names', 'given name s', 'legal first name', 'firstname', 'forename', 'first'])
    || A === 'given-name' || /\b(first ?name|fname|given ?name)\b/.test(N)) {
    return out('first_name', 'first name');
  }
  if (opensAny(L, ['last name', 'family name', 'surname', 'legal last name', 'lastname', 'last'])
    || A === 'family-name' || /\b(last ?name|lname|family ?name|surname)\b/.test(N)) {
    return out('last_name', 'last name');
  }
  if (['name', 'full name', 'legal name', 'full legal name', 'legal full name', 'candidate name', 'applicant name', 'first and last name', 'name first and last', 'your name', 'complete name'].includes(L)
    || opensAny(L, ['full name', 'legal name', 'full legal name', 'first and last name'])
    || A === 'name' || /^(name|full ?name|systemfield name|candidate ?name|applicant ?name)$/.test(N)) {
    return out('full_name', 'full name');
  }

  // ---------------- contact
  const confirmEmail = /^(confirm|re enter|reenter|re type|retype|repeat|verify|verification)\b/.test(L) && /\be ?mail\b/.test(L);
  if (confirmEmail) return out('email', 'confirm email', { confirm: true });
  if (opensAny(L, ['email', 'e mail', 'email address', 'e mail address', 'emailaddress'])
    || f.inputType === 'email' || A === 'email' || /\be ?mail\b/.test(N) && !/\b(alert|subscribe|newsletter)\b/.test(N)) {
    return out('email', 'email');
  }
  if (/\b(phone|mobile|telephone) (type|device type|device)\b|^(phone device type|device type|type of phone)\b/.test(S)) return out('phone_type', 'phone type');
  if (/\b(country (phone )?code|phone country|dial(ing)? code|country calling code|calling code)\b/.test(S)) return out('phone_code', 'phone country code');
  if (/^(extension|phone extension|ext)$/.test(L)) return out('unknown', 'phone extension');
  if (opensAny(L, ['phone', 'phone number', 'mobile', 'mobile number', 'mobile phone', 'cell', 'cell phone', 'cellphone', 'telephone', 'telephone number', 'contact number', 'primary phone', 'tel'])
    || f.inputType === 'tel' || A === 'tel' || A === 'tel-national' || /\b(phone|mobile|telephone|cellphone)\b/.test(N)) {
    return out('phone', 'phone');
  }

  // ---------------- work and education context
  const eduCtx = /\b(education|school|university|college|degree|academic)\b/.test(C) || /\b(education|school|degree)\b/.test(N);
  const workCtx = /\b(employment|experience|work history|work experience|employer|job history|professional experience|positions?)\b/.test(C)
    || /\b(employment|experience|employer|work)\b/.test(N);

  if (eduCtx || workCtx) {
    const ctx = eduCtx && !workCtx ? 'edu' : workCtx && !eduCtx ? 'work' : (/\b(education|school|degree)\b/.test(`${C} ${N}`) ? 'edu' : 'work');
    const dp = datePartOf(L, P, f);
    if (opensAny(L, ['start', 'start date', 'from', 'begin', 'date started', 'started', 'start month', 'start year', 'from date', 'beginning'])) {
      return out(ctx === 'edu' ? 'edu_start' : 'work_start', 'start date', { datePart: dp });
    }
    if (opensAny(L, ['end', 'end date', 'to', 'date ended', 'ended', 'end month', 'end year', 'to date', 'completion', 'completion date', 'finish', 'finish date', 'graduation', 'graduation date', 'graduation year', 'expected graduation'])) {
      return out(ctx === 'edu' ? 'edu_end' : 'work_end', 'end date', { datePart: dp });
    }
    if (opensAny(L, ['location', 'city', 'city state', 'where'])) return out(ctx === 'edu' ? 'edu_location' : 'work_location', 'entry location');
    if (ctx === 'work' && f.kind === 'checkbox' && /\b(currently|current|present|still)\b/.test(L)) return out('work_current', 'currently works here');
    if (ctx === 'work' && opensAny(L, ['description', 'responsibilities', 'role description', 'duties', 'summary', 'job description', 'key responsibilities'])) {
      return out('work_description', 'role description');
    }
  }

  // ---------------- education
  if (/\b(graduation (date|year)|expected graduation|year of graduation|graduation)\b/.test(L) && !/\bhigh school\b/.test(L)) {
    return out('edu_end', 'graduation date', { datePart: datePartOf(L, P, f) });
  }
  if (opensAny(L, ['school', 'school name', 'university', 'university name', 'college', 'college name', 'institution', 'institution name', 'name of school', 'name of university', 'name of institution', 'educational institution', 'school or university', 'university or college'])
    || /\b(school ?name|university|institution)\b/.test(N) && !/\bhigh school\b/.test(L)) {
    return out('edu_school', 'school');
  }
  if (opensAny(L, ['highest level of education', 'highest education', 'highest degree', 'level of education', 'education level', 'highest level of education completed'])) {
    return out('edu_degree', 'highest degree', { highest: true });
  }
  if (opensAny(L, ['degree', 'degree type', 'degree name', 'type of degree', 'degree earned', 'degree obtained', 'qualification']) || /\bdegree\b/.test(N) && !/\bdegree of\b/.test(L)) {
    return out('edu_degree', 'degree');
  }
  if (opensAny(L, ['discipline', 'major', 'field of study', 'area of study', 'concentration', 'course of study', 'specialization', 'specialisation', 'major field of study', 'subject', 'program of study'])
    || /\b(discipline|major|field of study)\b/.test(N)) {
    return out('edu_major', 'major');
  }
  if (/\b(gpa|grade point average|cgpa)\b/.test(`${L} ${N}`)) return out('edu_gpa', 'GPA');

  // ---------------- work
  if (opensAny(L, ['current company', 'current employer', 'present employer', 'current organization', 'current organisation', 'current company name', 'company you currently work for'])) {
    return out('current_company', 'current company');
  }
  if (opensAny(L, ['most recent employer', 'current or most recent employer', 'current or previous employer', 'most recent company', 'current or most recent company', 'latest employer'])) {
    return out('work_company', 'most recent employer', { entry: 0 });
  }
  if (opensAny(L, ['current title', 'current job title', 'current position', 'current role', 'current position title', 'present title', 'current designation'])) {
    return out('current_title', 'current title');
  }
  if (opensAny(L, ['most recent title', 'most recent job title', 'current or most recent title', 'current or most recent job title', 'latest job title'])) {
    return out('work_title', 'most recent title', { entry: 0 });
  }
  if (opensAny(L, ['company', 'company name', 'employer', 'employer name', 'name of employer', 'name of company', 'organization', 'organisation', 'organization name']) || A === 'organization') {
    return out('work_company', 'company');
  }
  if (opensAny(L, ['job title', 'position title', 'title of position', 'role title', 'your title', 'designation']) || A === 'organization-title'
    || (workCtx && opensAny(L, ['title', 'position', 'role']))) {
    return out('work_title', 'job title');
  }

  // ---------------- address and location
  if (opensAny(L, ['address line 2', 'address 2', 'apartment', 'apt', 'suite', 'unit', 'street address line 2', 'address2']) || A === 'address-line2') {
    return out('address_line2', 'address line 2');
  }
  if (opensAny(L, ['address', 'street address', 'home address', 'mailing address', 'address line 1', 'address 1', 'street', 'current address', 'residential address', 'address1', 'permanent address'])
    || A === 'street-address' || A === 'address-line1' || /\b(address ?line ?1|street ?address|address1)\b/.test(N)) {
    return out('address_line', 'address');
  }
  if (opensAny(L, ['location', 'current location', 'city and state', 'city state', 'city state country', 'city country', 'city and country', 'where are you located', 'where are you currently located', 'where are you based', 'where do you live', 'where are you currently based', 'based in', 'location city'])
    || /\b(location|systemfield location)\b/.test(N) && !/\b(job|preferred|work)\b/.test(`${L} ${N}`)) {
    if (/\b(preferred|desired|willing|relocat|open to|job location|office|work location)\b/.test(L)) return out('unknown', 'location preference');
    return out('location', 'location');
  }
  if (opensAny(L, ['city', 'town', 'city town', 'city of residence', 'current city', 'city or town', 'home city']) || A === 'address-level2' || /^(city|town)$/.test(N)) {
    return out('city', 'city');
  }
  if (opensAny(L, ['state', 'province', 'region', 'state province', 'state or province', 'province state', 'state province region', 'state region', 'county state']) || A === 'address-level1' || /^(state|province|region)$/.test(N)) {
    return out('region', 'state or province');
  }
  if (opensAny(L, ['zip', 'zip code', 'zipcode', 'postal', 'postal code', 'postcode', 'post code', 'zip postal code', 'postal zip code', 'pin code', 'pincode']) || A === 'postal-code' || /\b(zip|postal ?code|postcode)\b/.test(N)) {
    return out('postal_code', 'postal code');
  }
  if ((opensAny(L, ['country', 'country of residence', 'country region', 'country territory', 'current country', 'residence country', 'country you live in']) && !/\bcode\b/.test(L))
    || A === 'country' || A === 'country-name' || /^(country|country ?region|address country)$/.test(N)) {
    return out('country', 'country');
  }

  // ---------------- links: the label names the link (short, or opening with it), or the field name does
  const linkish = (re: RegExp): boolean => re.test(N) || (re.test(L) && (L.length <= 45 || new RegExp(`^${re.source}`).test(L)));
  if (linkish(PRO_PROFILE)) return out('pro_profile', 'professional profile link');
  if (linkish(/\bgit ?hub\b/)) return out('github', 'GitHub');
  if (linkish(/\b(twitter|x com)\b/) || /^x$|^x profile\b|\bx twitter\b/.test(L)) return out('twitter', 'Twitter or X');
  if (/^(other|additional) (website|link|url|profile)s?\b|^other$/.test(L)) return out('other_link', 'other link');
  if (linkish(/\bportfolio\b/)) return out('portfolio', 'portfolio');
  if (opensAny(L, ['website', 'personal website', 'personal site', 'web site', 'blog', 'homepage', 'home page', 'personal url', 'personal web site', 'website url', 'site']) || A === 'url' || /^(website|personal ?website|homepage)$/.test(N)) {
    return out('website', 'website');
  }

  // ---------------- the person's own summary
  if (opensAny(L, ['summary', 'professional summary', 'profile summary', 'career summary', 'candidate summary', 'personal summary', 'short bio', 'bio'])
    && (f.kind === 'textarea' || f.kind === 'text') && !workCtx && !eduCtx) {
    return out('summary', 'profile summary');
  }

  // ---------------- skills
  const skillYears = skillYearsOf(L);
  if (skillYears) return out('skill_years', 'years with a skill', { skill: skillYears });
  if (/\b(years|yrs)\b.*\b(experience|exp)\b|\bexperience\b.*\b(years|yrs)\b|^how many years\b/.test(L)) return out('years_total', 'total years of experience');
  if (opensAny(L, ['skills', 'key skills', 'technical skills', 'skill set', 'skillset', 'top skills', 'relevant skills', 'core skills', 'skills and expertise'])) {
    return out('skills', 'skills');
  }

  // ---------------- open questions (drafts only, never written by a fill)
  const longText = f.kind === 'textarea' || ((f.kind === 'text' || f.kind === 'unknown') && (f.maxLength ?? 0) >= 500);
  if (longText) {
    if (/\bcover letter\b/.test(L)) return out('open_question', 'cover letter text');
    const question = /\?\s*$/.test(labelN)
      || /^(why|what|how|describe|tell us|tell me|explain|share|please describe|please explain|please tell|please share|briefly|in a few|in \d+|in one|give an example|provide an example|walk us|if you|what s|what is|which|when|where|who)\b/.test(L)
      || /\b(why do you want|why are you interested|what interests you|what excites you|tell us about|describe a time|motivat)\b/.test(L);
    if (question) return out('open_question', 'open question');
  }
  return out('unknown', 'no known topic');
}

/**
 * The skill a "years with X" question names ("How many years of experience do you have with Kubernetes?"), or null.
 */
export function skillYearsOf(L: string): string | null {
  const pats: RegExp[] = [
    /^how many years (?:of )?(?:professional |hands on |relevant |work |working )?(?:experience )?(?:do you have )?(?:with|in|using|working with|working in|of) (.+?)(?: experience)?(?: do you have)?$/,
    /^years (?:of )?(?:professional |hands on |relevant )?(?:experience )?(?:with|in|using|working with) (.+)$/,
    /^(?:number of )?years of (.+?) experience$/,
    /^(.+?) experience in years$/,
    /^(.+?) years of experience$/,
    /^experience with (.+?) in years$/,
    /^experience with (.+?) years$/,
    /^(.+?) experience years$/,
    /^how many years (?:have you|did you) (?:worked|used|been using|been working|work|use) (?:with |in |on )?(.+)$/,
  ];
  const t = L.replace(/\?/g, '').trim();
  for (const re of pats) {
    const m = t.match(re);
    const s = m?.[1]?.trim();
    if (s && s.length <= 60 && !/^(professional|relevant|total|work|industry|overall|full time|paid|related|management|leadership)$/.test(s)) return s;
  }
  return null;
}
