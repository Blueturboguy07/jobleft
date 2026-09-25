// The answer engine: which profile value goes into which form field. It runs in the APP (the server's `fill`
// route, and the stand-in app in scripts/standin-app.ts), so the extension receives only the values a page needs,
// never the whole profile.
//
// Promises this module keeps (extension outcomes O3, O6, O7, O10):
//   * every value is a profile value, or the same fact in the form's format (TX -> Texas, 2021-05 -> 05/2021);
//   * no value is invented: an empty profile item leaves the field empty with a note ("needs you");
//   * a sensitive question gets an answer only from an answer the person saved for that exact topic;
//   * pay expectations, age, date of birth, criminal history and ID numbers are never answered;
//   * open questions never get a value here: they get a draft (only when asked) that the person must accept;
//   * the person's identity goes into the first matching field only; a second "Name" or "Email" (a referrer, a
//     reference) stays empty.

import type { DraftOffer, EducationEntry, FieldNote, FillRequest, FillResponse, FormField, Profile, WorkEntry } from '@jobleft/contracts';
import { classify, IDENTITY_TOPICS, isSensitive, PRO_SITE, type Classification, type Topic } from './classify.ts';
import { pickMany, pickOption, parseDegree, type MatchKind, type Opt } from './options.ts';
import { countryDisplayName } from './places.ts';
import { norm, words } from './text.ts';

export interface ResumeFile {
  id: string;
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface AnswerContext {
  profile: Profile;
  /** The resume to attach: the one the person picked, else the version for this job, else the default. */
  resume: ResumeFile | null;
  /** What the app can offer for open questions; null = no draft provider set up. */
  draftOffer: Omit<DraftOffer, 'fieldIds'> | null;
  /**
   * Makes drafts during the fill. The app passes it only for a FREE provider (a local model): a paid provider
   * waits until the person sees the price and asks (POST /api/v1/extension/drafts).
   */
  draft?: (fields: FormField[]) => Promise<Array<{ fieldId: string; text: string; provider: string }>>;
  jobId?: string | null;
}

type Fill = FillResponse['fills'][number];
type Result =
  | { kind: 'fill'; fill: Omit<Fill, 'fieldId'> }
  | { kind: 'file' }
  | { kind: 'note'; reason: FieldNote['reason']; message: string };

const TOPIC_WORDS: Partial<Record<Topic, string>> = {
  eeo_gender: 'gender', eeo_race: 'race or ethnicity', eeo_hispanic: 'Hispanic or Latino identity', eeo_veteran: 'veteran status',
  eeo_disability: 'disability', eeo_lgbtq: 'LGBTQ+ identity', eeo_orientation: 'sexual orientation', eeo_transgender: 'transgender identity',
  eeo_pronouns: 'pronouns', eeo_other: 'a personal topic (self-identification, military, accommodation or immigration)', age: 'age', dob: 'date of birth', criminal: 'criminal history',
  gov_id: 'a government ID number', work_auth: 'work authorization', work_auth_nosponsor: 'work authorization and sponsorship',
  sponsorship: 'visa sponsorship', citizenship: 'citizenship', clearance: 'security clearance', pay: 'pay expectations',
};

const NEVER_ANSWERED: ReadonlySet<Topic> = new Set<Topic>(['pay', 'age', 'dob', 'criminal', 'gov_id', 'eeo_transgender', 'eeo_other']);

function note(reason: FieldNote['reason'], message: string): Result {
  return { kind: 'note', reason, message };
}

function text(value: string, item: string, extra: Partial<Fill> = {}): Result {
  return { kind: 'fill', fill: { values: [value], source: 'profile', confidence: 'exact', needsReview: false, item, ...extra } };
}

function isChoice(f: FormField): boolean {
  return (f.kind === 'select' || f.kind === 'radio' || (f.kind === 'checkbox' && f.options.length > 1)) && !f.combobox;
}

/** A value for a choice field (by strict matcher), a combobox (the matcher runs in the page), or a text box. */
function choose(f: FormField, kind: MatchKind, wanted: string, typed: string | null, item: string, source: Fill['source'] = 'profile'): Result {
  if (f.combobox) {
    return { kind: 'fill', fill: { values: [wanted], source, confidence: 'exact', needsReview: false, item, topic: kind } };
  }
  if (isChoice(f)) {
    const opts: Opt[] = f.options.map((o) => ({ value: o.value, label: o.label }));
    const p = pickOption(kind, wanted, opts);
    if (!p) return note('no_option', `No option matches your ${item.toLowerCase()} (${typed ?? wanted}).`);
    const chosen = opts[p.index] as Opt;
    return { kind: 'fill', fill: { values: [chosen.value], source, confidence: p.confidence, needsReview: p.confidence !== 'exact', item } };
  }
  if (typed === null) return note('no_option', `This box needs a typed answer, and your ${item.toLowerCase()} is a choice.`);
  return { kind: 'fill', fill: { values: [typed], source, confidence: 'exact', needsReview: false, item } };
}

// ------------------------------------------------------------------ dates

function ym(date: string | null): { y: string; m: string | null } | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})(?:-(\d{2}))?$/);
  return m ? { y: m[1] as string, m: m[2] ?? null } : null;
}

function dateAnswer(f: FormField, c: Classification, date: string | null, item: string): Result {
  const d = ym(date);
  if (!d) return note('no_value', `Your profile has no ${item.toLowerCase()}.`);
  if (c.datePart === 'year') return choose(f, 'year', d.y, d.y, item);
  if (c.datePart === 'month') {
    if (!d.m) return note('no_value', `Your profile has only the year for ${item.toLowerCase()}.`);
    return choose(f, 'month', String(Number(d.m)), d.m, item);
  }
  if (f.inputType === 'date') return note('no_value', `This box wants a day, and your profile has only the month and year for ${item.toLowerCase()}.`);
  if (f.inputType === 'month') {
    if (!d.m) return note('no_value', `Your profile has only the year for ${item.toLowerCase()}.`);
    return text(`${d.y}-${d.m}`, item);
  }
  if (f.kind === 'select' || f.kind === 'radio') return note('no_option', `jobleft cannot match a whole date to this list.`);
  const p = norm(f.placeholder ?? '');
  if (/\bdd\b|\bday\b/.test(p)) return note('no_value', `This box wants a day, and your profile has only the month and year for ${item.toLowerCase()}.`);
  if (!d.m) return text(d.y, item);
  if (/yyyy\s*[-/.]\s*mm/.test(p)) return text(`${d.y}-${d.m}`, item, { needsReview: true, confidence: 'likely' });
  return text(`${d.m}/${d.y}`, item, { needsReview: !/mm\s*[-/.]\s*yyyy/.test(p), confidence: /mm\s*[-/.]\s*yyyy/.test(p) ? 'exact' : 'likely' });
}

// ------------------------------------------------------------------ entries

function recency(a: { current: boolean; endDate: string | null; startDate: string | null }): string {
  return `${a.current ? '9' : '0'}${a.endDate ?? '0000-00'}${a.startDate ?? '0000-00'}`;
}

function sortedWork(p: Profile): WorkEntry[] {
  return [...p.work].sort((a, b) => recency(b).localeCompare(recency(a)));
}

function sortedEducation(p: Profile): EducationEntry[] {
  return [...p.education].sort((a, b) => recency(b).localeCompare(recency(a)));
}

// ------------------------------------------------------------------ links

function linkFor(p: Profile, kind: 'pro_profile' | 'github' | 'twitter' | 'portfolio' | 'website'): string | null {
  const links = p.personal.links;
  const host = (u: string): string => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
  const pro = (u: string): boolean => host(u) === `${PRO_SITE}.com` || host(u).endsWith(`.${PRO_SITE}.com`);
  const social = (u: string): boolean => pro(u) || /(^|\.)(github\.com|twitter\.com|x\.com)$/.test(host(u));
  switch (kind) {
    case 'pro_profile': return links.find((l) => pro(l.url))?.url ?? null;
    case 'github': return links.find((l) => /(^|\.)github\.com$/.test(host(l.url)))?.url ?? null;
    case 'twitter': return links.find((l) => /(^|\.)(twitter\.com|x\.com)$/.test(host(l.url)))?.url ?? null;
    case 'portfolio':
    case 'website': {
      const labelled = links.find((l) => !social(l.url) && /\b(portfolio|website|personal|homepage|home page|site|blog)\b/.test(words(l.label)));
      return labelled?.url ?? null;
    }
  }
}

// ------------------------------------------------------------------ sensitive answers

type YND = 'yes' | 'no' | 'decline';

function yesNo(f: FormField, v: YND, item: string, alsoRace?: string): Result {
  if (f.combobox) return { kind: 'fill', fill: { values: [v], source: 'saved_answer', confidence: 'exact', needsReview: false, item, topic: v } };
  if (f.kind === 'checkbox' && f.options.length <= 1) {
    if (v === 'decline') return note('sensitive', `Your saved answer is "decline", and this is a single tick box. Decide yourself.`);
    return { kind: 'fill', fill: { values: [v === 'yes' ? 'true' : 'false'], source: 'saved_answer', confidence: 'exact', needsReview: false, item } };
  }
  if (isChoice(f)) {
    const opts: Opt[] = f.options.map((o) => ({ value: o.value, label: o.label }));
    let p = pickOption(v, '', opts);
    if (!p && alsoRace && v !== 'decline') p = pickOption('race', v === 'yes' ? alsoRace : `not ${alsoRace}`, opts);
    if (!p) return note('no_option', `No option means exactly your saved answer (${v}).`);
    return { kind: 'fill', fill: { values: [(opts[p.index] as Opt).value], source: 'saved_answer', confidence: 'exact', needsReview: false, item } };
  }
  if (v === 'decline') return note('sensitive', 'Your saved answer is "decline", and this box needs typed words. Decide yourself.');
  return { kind: 'fill', fill: { values: [v === 'yes' ? 'Yes' : 'No'], source: 'saved_answer', confidence: 'exact', needsReview: false, item } };
}

function sensitive(f: FormField, c: Classification, p: Profile): Result {
  const topicWords = TOPIC_WORDS[c.topic] ?? 'a sensitive topic';
  const none = note('sensitive', `This question is about ${topicWords}. jobleft answers it only with an answer you saved for this topic in the app.`);
  if (NEVER_ANSWERED.has(c.topic)) {
    return note('sensitive', `This question is about ${topicWords}. jobleft never answers it. Answer it yourself.`);
  }
  const eeo = p.eeo;
  const wa = p.workAuthorization;
  const item = `Saved answer: ${topicWords}`;
  switch (c.topic) {
    case 'eeo_gender': {
      if (!eeo.gender) return none;
      if (norm(eeo.gender) === 'decline') return yesNo(f, 'decline', item);
      return choose(f, 'gender', eeo.gender, eeo.gender, item, 'eeo');
    }
    case 'eeo_race': {
      if (!eeo.race) return none;
      if (norm(eeo.race) === 'decline') return yesNo(f, 'decline', item);
      if (f.kind === 'checkbox' && f.options.length > 1 && !f.combobox) {
        const idx = pickMany('race', [eeo.race], f.options);
        if (idx.length !== 1) return note('no_option', `No option means exactly your saved answer (${eeo.race}).`);
        return { kind: 'fill', fill: { values: [(f.options[idx[0] as number] as Opt).value], source: 'eeo', confidence: 'exact', needsReview: false, item } };
      }
      return choose(f, 'race', eeo.race, eeo.race, item, 'eeo');
    }
    case 'eeo_hispanic':
      return eeo.hispanicOrLatino ? yesNo(f, eeo.hispanicOrLatino, item, 'hispanic or latino') : none;
    case 'eeo_veteran':
      return eeo.veteran ? yesNo(f, eeo.veteran, item) : none;
    case 'eeo_disability':
      return eeo.disability ? yesNo(f, eeo.disability, item) : none;
    case 'eeo_lgbtq':
      return eeo.lgbtq ? yesNo(f, eeo.lgbtq, item) : none;
    case 'eeo_orientation': {
      const saved = eeo.sexualOrientation.filter((s) => s.trim());
      if (saved.length === 0) return none;
      if (saved.length === 1 && norm(saved[0]) === 'decline') return yesNo(f, 'decline', item);
      if (f.kind === 'checkbox' && f.options.length > 1 && !f.combobox) {
        const idx = pickMany('orientation', saved, f.options);
        if (idx.length !== saved.length) return note('no_option', 'The options do not match your saved answer exactly.');
        return { kind: 'fill', fill: { values: idx.map((i) => (f.options[i] as Opt).value), source: 'eeo', confidence: 'exact', needsReview: false, item } };
      }
      if (saved.length !== 1) return note('no_option', 'Your saved answer has more than one choice, and this question takes one.');
      return choose(f, 'orientation', saved[0] as string, saved[0] as string, item, 'eeo');
    }
    case 'eeo_pronouns':
      if (!eeo.pronouns) return none;
      if (norm(eeo.pronouns) === 'decline') return yesNo(f, 'decline', item);
      return choose(f, 'pronouns', eeo.pronouns, eeo.pronouns, item, 'eeo');
    case 'work_auth': {
      if (c.country === null) return note('sensitive', 'This question does not name a country, so your saved work authorization may not fit. Answer it yourself.');
      if (c.country === 'US') return wa.usAuthorized ? yesNo(f, wa.usAuthorized, item) : none;
      // Another country: "yes" only when the person listed it; never "no" from a missing entry.
      if (wa.authorizedCountries.includes(c.country)) return yesNo(f, 'yes', item);
      return none;
    }
    case 'work_auth_nosponsor': {
      if (c.country !== null && c.country !== 'US') return none;
      if (wa.usAuthorized === 'yes' && wa.needsSponsorship === 'no') return yesNo(f, 'yes', item);
      if (wa.usAuthorized === 'no' || wa.needsSponsorship === 'yes') return yesNo(f, 'no', item);
      return none;
    }
    case 'sponsorship': {
      if (c.country !== null && c.country !== 'US') return none;
      return wa.needsSponsorship ? yesNo(f, wa.needsSponsorship, item) : none;
    }
    case 'citizenship': {
      const t = words(f.label);
      const usQuestion = /\b(u s|us|united states|american) citizen\b|\bcitizen of the (u s|us|united states)\b/.test(t);
      if (!usQuestion || !wa.usCitizen) return none;
      return yesNo(f, wa.usCitizen, item);
    }
    case 'clearance':
      if (!/^(do|are|have|does)\b/.test(words(f.label))) return none;
      return wa.hasSecurityClearance ? yesNo(f, wa.hasSecurityClearance, item) : none;
    default:
      return none;
  }
}

// ------------------------------------------------------------------ one field

interface State {
  identitySeen: Set<Topic>;
  resumeGiven: boolean;
}

function answerOne(f: FormField, c: Classification, ctx: AnswerContext, st: State): Result {
  const p = ctx.profile;
  const me = p.personal;
  const missing = (what: string): Result => note('no_value', `Your profile has no ${what}.`);

  if (IDENTITY_TOPICS.has(c.topic) && !c.confirm) {
    if (st.identitySeen.has(c.topic)) {
      return note('duplicate', `This is a second "${f.label.trim().slice(0, 60)}" field. jobleft puts your details in the first one only.`);
    }
    st.identitySeen.add(c.topic);
  }
  if (isSensitive(c.topic)) return sensitive(f, c, p);

  switch (c.topic) {
    case 'first_name': return me.firstName ? text(me.firstName, 'First name') : missing('first name');
    case 'last_name': return me.lastName ? text(me.lastName, 'Last name') : missing('last name');
    case 'middle_name': {
      if (!me.middleName) return missing('middle name');
      if (/\binitial\b/.test(words(f.label))) return text(`${me.middleName.trim().charAt(0).toUpperCase()}`, 'Middle name (initial)');
      return text(me.middleName, 'Middle name');
    }
    case 'full_name': {
      if (!me.firstName || !me.lastName) return missing('full name (first and last name)');
      return text(`${me.firstName} ${me.lastName}`, 'Full name (first and last name)');
    }
    case 'preferred_name': return note('no_value', 'Your profile has no preferred name. jobleft does not guess one.');
    case 'email': return me.email ? text(me.email, c.confirm ? 'Email (confirm)' : 'Email') : missing('email');
    case 'phone': return me.phone ? text(me.phone, 'Phone') : missing('phone number');
    case 'phone_code': return note('no_value', 'Your profile has no phone country code.');
    case 'phone_type': return note('no_value', 'Your profile does not say what kind of phone it is.');
    case 'address_line': return me.addressLine ? text(me.addressLine, 'Address') : missing('street address');
    case 'address_line2': return missing('second address line');
    case 'city':
      if (!me.city) return missing('city');
      return isChoice(f) || f.combobox ? choose(f, 'exact', me.city, me.city, 'City') : text(me.city, 'City');
    case 'region':
      if (!me.region) return missing('state or province');
      return isChoice(f) || f.combobox ? choose(f, 'region', `${me.region}|${me.country ?? ''}`, me.region, 'State or province') : text(me.region, 'State or province');
    case 'postal_code': return me.postalCode ? text(me.postalCode, 'Postal code') : missing('postal code');
    case 'country': {
      if (!me.country) return missing('country');
      const name = countryDisplayName(me.country) ?? me.country;
      return isChoice(f) || f.combobox ? choose(f, 'country', me.country, name, 'Country') : text(name, 'Country');
    }
    case 'location': {
      if (!me.city) return missing('city');
      if (isChoice(f) || f.combobox) return choose(f, 'location', `${me.city}|${me.region ?? ''}|${me.country ?? ''}`, null, 'City and state');
      return text([me.city, me.region].filter(Boolean).join(', '), 'City and state (from your profile)');
    }
    case 'pro_profile':
    case 'github':
    case 'twitter':
    case 'portfolio':
    case 'website': {
      const url = linkFor(p, c.topic);
      const names = { pro_profile: 'professional profile link', github: 'GitHub link', twitter: 'Twitter or X link', portfolio: 'portfolio link', website: 'website link' } as const;
      if (!url) return missing(names[c.topic]);
      if (isChoice(f)) return note('no_option', 'This is a list, and a link is typed.');
      return text(url, names[c.topic].charAt(0).toUpperCase() + names[c.topic].slice(1));
    }
    case 'other_link': return note('no_value', 'jobleft does not choose an "other" link for you.');

    // education
    case 'edu_school':
    case 'edu_degree':
    case 'edu_major':
    case 'edu_gpa':
    case 'edu_start':
    case 'edu_end':
    case 'edu_location': {
      const list = sortedEducation(p);
      let e = list[c.entry];
      if (c.highest) {
        const rank = (d: EducationEntry): number => ['high_school', 'certificate', 'associate', 'bachelor', 'master', 'doctorate'].indexOf(parseDegree(d.degree ?? '')?.level ?? '');
        e = [...list].sort((a, b) => rank(b) - rank(a))[0];
      }
      const n = c.entry + 1;
      if (!e) return note('no_value', list.length === 0 ? 'Your profile has no education.' : `Your profile has ${list.length} education ${list.length === 1 ? 'entry' : 'entries'}, not ${n}.`);
      const label = `Education ${n}`;
      switch (c.topic) {
        case 'edu_school': return isChoice(f) || f.combobox ? choose(f, 'exact', e.school, e.school, `${label}: school`) : text(e.school, `${label}: school`);
        case 'edu_degree':
          if (!e.degree) return missing(`degree for ${e.school}`);
          return isChoice(f) || f.combobox ? choose(f, 'degree', e.degree, e.degree, `${label}: degree`) : text(e.degree, `${label}: degree`);
        case 'edu_major':
          if (!e.major) return missing(`major for ${e.school}`);
          return isChoice(f) || f.combobox ? choose(f, 'exact', e.major, e.major, `${label}: major`) : text(e.major, `${label}: major`);
        case 'edu_gpa': return e.gpa ? text(e.gpa, `${label}: GPA`) : missing(`GPA for ${e.school}`);
        case 'edu_start': return dateAnswer(f, c, e.startDate, `${label}: start date`);
        case 'edu_end':
          if (e.current && !e.endDate) return note('no_value', `Your profile says you study at ${e.school} now and has no end date.`);
          return dateAnswer(f, c, e.endDate, `${label}: end date`);
        case 'edu_location': return missing(`location for ${e.school}`);
      }
      return missing('education detail');
    }

    // work
    case 'work_company':
    case 'work_title':
    case 'work_start':
    case 'work_end':
    case 'work_current':
    case 'work_location':
    case 'work_description': {
      const list = sortedWork(p);
      const w = list[c.entry];
      const n = c.entry + 1;
      if (!w) return note('no_value', list.length === 0 ? 'Your profile has no work history.' : `Your profile has ${list.length} ${list.length === 1 ? 'job' : 'jobs'}, not ${n}.`);
      const label = `Work ${n}`;
      switch (c.topic) {
        case 'work_company': return isChoice(f) ? choose(f, 'exact', w.company, w.company, `${label}: company`) : text(w.company, `${label}: company`);
        case 'work_title': return isChoice(f) ? choose(f, 'exact', w.title, w.title, `${label}: title`) : text(w.title, `${label}: title`);
        case 'work_start': return dateAnswer(f, c, w.startDate, `${label}: start date`);
        case 'work_end':
          if (w.current) return note('no_value', `Your profile says you work at ${w.company} now, so there is no end date.`);
          return dateAnswer(f, c, w.endDate, `${label}: end date`);
        case 'work_current':
          if (f.kind !== 'checkbox') return note('unknown', 'jobleft fills this only as a tick box.');
          return { kind: 'fill', fill: { values: [w.current ? 'true' : 'false'], source: 'profile', confidence: 'exact', needsReview: false, item: `${label}: I work here now` } };
        case 'work_location': return w.location ? text(w.location, `${label}: location`) : missing(`location for ${w.company}`);
        case 'work_description': {
          const body = [w.summary, ...w.bullets].filter((s): s is string => !!s && !!s.trim()).join('\n');
          return body ? text(body, `${label}: description`) : missing(`description for ${w.company}`);
        }
      }
      return missing('work detail');
    }
    case 'current_company':
    case 'current_title': {
      const w = sortedWork(p).find((x) => x.current);
      if (!w) return note('no_value', 'Your profile shows no current job.');
      return c.topic === 'current_company' ? text(w.company, 'Current company') : text(w.title, 'Current title');
    }

    case 'summary': return p.summary && p.summary.trim() ? text(p.summary, 'Summary') : missing('summary');

    // skills
    case 'skills': {
      const names = p.skills.map((s) => s.name).filter(Boolean);
      if (names.length === 0) return missing('skills');
      if (f.kind === 'checkbox' && f.options.length > 1 && !f.combobox) {
        const idx = pickMany('exact', names, f.options);
        if (idx.length === 0) return note('no_option', 'None of the listed skills is in your profile.');
        return { kind: 'fill', fill: { values: idx.map((i) => (f.options[i] as Opt).value), source: 'profile', confidence: 'exact', needsReview: false, item: 'Skills' } };
      }
      if (isChoice(f) || f.combobox) return note('no_option', 'jobleft does not pick one skill for you from a list.');
      return text(names.join(', '), 'Skills');
    }
    case 'skill_years': {
      const want = norm(c.skill).replace(/^the /, '');
      const s = p.skills.find((x) => norm(x.name) === want);
      if (!s) return note('no_value', `Your profile does not list ${c.skill}. jobleft does not guess years for it.`);
      if (s.years === null) return note('no_value', `Your profile lists ${s.name} with no number of years.`);
      const y = String(s.years);
      return isChoice(f) || f.combobox ? choose(f, 'range', y, y, `Years with ${s.name}`) : text(y, `Years with ${s.name}`);
    }
    case 'years_total': return note('no_value', 'jobleft does not add up your years of experience. Type your own number.');

    // files
    case 'resume_file':
      if (!ctx.resume) return note('file', 'No resume is set up in the app.');
      if (st.resumeGiven) return note('file', 'Your resume goes into the first resume field only.');
      st.resumeGiven = true;
      return { kind: 'file' };
    case 'cover_letter_file': return note('file', 'This is a cover letter upload. jobleft puts your resume only in the resume field.');
    case 'other_file': return note('file', 'jobleft attaches only your resume, and only in a resume field.');

    case 'open_question': return note('open_question', 'An open question. jobleft can offer a draft. It goes in only when you accept it.');
    case 'consent': return note('consent', 'Only you can agree to this or opt in.');
    case 'captcha': return note('captcha', 'A human check. Only you can complete it.');
    case 'account': return note('account', 'jobleft never fills passwords or makes accounts.');
    case 'other_person':
      return note('other_person', `This field is about another person${c.otherWord ? ` (${c.otherWord})` : ''}. jobleft fills only your own details.`);
    default:
      return note('unknown', 'jobleft has no saved answer for this question.');
  }
}

/** The fields of a request that are open questions (the ones a draft can answer). */
export function openQuestions(fields: readonly FormField[]): FormField[] {
  return fields.filter((f) => classify(f).topic === 'open_question');
}

/** The app side of POST /api/v1/extension/fill. */
export async function answerFill(req: FillRequest, ctx: AnswerContext): Promise<FillResponse> {
  const st: State = { identitySeen: new Set(), resumeGiven: false };
  const fills: FillResponse['fills'] = [];
  const files: FillResponse['files'] = [];
  const notes: FieldNote[] = [];
  const open: FormField[] = [];
  for (const f of req.fields) {
    const c = classify(f);
    const r = answerOne(f, c, ctx, st);
    if (r.kind === 'fill') fills.push({ fieldId: f.fieldId, ...r.fill });
    else if (r.kind === 'file' && ctx.resume) {
      files.push({ fieldId: f.fieldId, fileName: ctx.resume.fileName, mimeType: ctx.resume.mimeType, base64: ctx.resume.base64, resumeId: ctx.resume.id });
    } else if (r.kind === 'note') {
      notes.push({ fieldId: f.fieldId, reason: r.reason, message: r.message, topic: c.topic });
      if (c.topic === 'open_question') open.push(f);
    }
  }
  const answered = new Set([...fills.map((x) => x.fieldId), ...files.map((x) => x.fieldId)]);
  let drafts: FillResponse['drafts'] = [];
  const warnings: string[] = [];
  if (open.length > 0 && ctx.draftOffer && ctx.draftOffer.maxPriceMicrosPerDraft === 0 && ctx.draft) {
    try {
      drafts = (await ctx.draft(open)).filter((d) => open.some((f) => f.fieldId === d.fieldId));
    } catch {
      warnings.push('The drafts could not be made. You can ask again.');
    }
  }
  return {
    requestId: req.requestId,
    jobId: ctx.jobId ?? null,
    fills,
    drafts,
    unknownFieldIds: req.fields.filter((f) => !answered.has(f.fieldId)).map((f) => f.fieldId),
    files,
    warnings,
    notes,
    draftOffer: open.length > 0 && ctx.draftOffer ? { ...ctx.draftOffer, fieldIds: open.map((f) => f.fieldId) } : null,
  };
}
