// The mock match engine (the real one is @jobleft/match). Pure and deterministic: the same profile and the same
// job always give the same numbers. A part that cannot be judged has percent null with a reason, never a default.
// Every reason names only facts that are in the posting or in the profile.

import { bandFor, type Company, type Job, type MatchResult, type Profile, type Reason, type WhyFitChip, type Blocker } from '@jobleft/contracts';
import { functionOf } from './fixtures.ts';

export const ENGINE_VERSION = 'mock-match-1';

function monthsOf(ym: string | null): number | null {
  if (!ym) return null;
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(ym);
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0);
}

/** Years of experience from the work dates, overlaps counted once. null with no dates. */
export function yearsOfExperience(profile: Profile, now: number): number | null {
  const d = new Date(now);
  const nowM = d.getUTCFullYear() * 12 + d.getUTCMonth();
  const spans: Array<[number, number]> = [];
  for (const w of profile.work) {
    const a = monthsOf(w.startDate);
    if (a === null) continue;
    const b = w.current ? nowM : monthsOf(w.endDate);
    if (b === null || b < a) continue;
    spans.push([a, b]);
  }
  if (!spans.length) return null;
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [cs, ce] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else { total += ce - cs; cs = s; ce = e; }
  }
  total += ce - cs;
  return Math.round((total / 12) * 10) / 10;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export interface MatchContext {
  profile: Profile;
  job: Job;
  company: Company | null;
  networkCount: number | null;
  now: number;
}

/** The score, or null when nothing in the posting can be judged against the profile. */
export function scoreMatch(ctx: MatchContext): MatchResult | null {
  const { profile, job, company } = ctx;
  const reasons: Reason[] = [];
  const years = yearsOfExperience(profile, ctx.now);

  // ---- experience level
  const expReasons: Reason[] = [];
  let exp: number | null = null;
  const minYears = job.yearsRequired?.min ?? null;
  if (minYears !== null && years !== null) {
    const diff = years - minYears;
    exp = diff >= 0 ? Math.max(70, 100 - Math.max(0, diff - 8) * 3) : Math.max(0, Math.round(100 + diff * 20));
    expReasons.push({
      code: diff >= 0 ? 'years_met' : 'years_short',
      text: diff >= 0
        ? `The posting asks for ${minYears}+ years; your work dates add up to about ${years} years.`
        : `The posting asks for ${minYears}+ years; your work dates add up to about ${years} years.`,
      points: diff >= 0 ? 10 : Math.round(diff * 5),
      evidence: job.evidence.years?.text,
    });
  } else if (job.levels.length && profile.preferences.levels.length) {
    const ok = job.levels.some((l) => profile.preferences.levels.includes(l));
    exp = ok ? 90 : 55;
    expReasons.push({
      code: ok ? 'level_in_preferences' : 'level_outside_preferences',
      text: ok ? 'The job level is one of the levels in your preferences.' : 'The job level is not one of the levels in your preferences.',
      points: ok ? 8 : -8,
      evidence: job.evidence.level?.text,
    });
  } else {
    expReasons.push({
      code: 'experience_unknown',
      text: minYears === null && !job.levels.length ? 'The posting states no level and no years of experience.' : 'Your profile has no work dates to compare with.',
      points: 0,
    });
  }

  // ---- skills
  const skillReasons: Reason[] = [];
  let skills: number | null = null;
  const declined = new Set((profile as Profile & { declinedSkills?: string[] }).declinedSkills?.map(norm) ?? []);
  const mine = new Set(profile.skills.map((s) => norm(s.name)).filter((s) => !declined.has(s)));
  const jobSkills = job.skills.slice(0, 10);
  const required: string[] = [];
  const preferred: string[] = [];
  const niceIdx = job.description.indexOf('Nice to have');
  for (const s of jobSkills) {
    const at = job.description.indexOf(s);
    if (niceIdx >= 0 && at > niceIdx) preferred.push(s); else required.push(s);
  }
  const matched = jobSkills.filter((s) => mine.has(norm(s)));
  const missing = jobSkills.filter((s) => !mine.has(norm(s)));
  if (jobSkills.length && profile.skills.length) {
    const reqMatched = required.filter((s) => mine.has(norm(s))).length;
    const prefMatched = preferred.filter((s) => mine.has(norm(s))).length;
    const denom = required.length * 2 + preferred.length;
    skills = denom ? Math.round((100 * (reqMatched * 2 + prefMatched)) / denom) : null;
    if (matched.length) skillReasons.push({ code: 'skills_matched', text: `You list ${matched.join(', ')}, which the posting names.`, points: matched.length * 4 });
    if (missing.length) skillReasons.push({ code: 'skills_missing', text: `The posting names ${missing.join(', ')}; your profile does not list ${missing.length === 1 ? 'it' : 'them'}.`, points: -missing.length * 3 });
  } else {
    skillReasons.push({ code: 'skills_unknown', text: jobSkills.length ? 'Your profile lists no skills yet.' : 'The posting names no skills jobleft can recognise.', points: 0 });
  }

  // ---- industry experience
  const indReasons: Reason[] = [];
  let industry: number | null = null;
  const jobFn = functionOf(job.title);
  const pastFns = profile.work.map((w) => ({ w, fn: functionOf(w.title) })).filter((x) => x.fn);
  if (jobFn && profile.work.length) {
    const same = pastFns.filter((x) => x.fn === jobFn);
    let score = same.length ? 85 : 35;
    const prefInd = profile.preferences.industries.map(norm);
    const compInd = company?.facts.industries?.value.map(norm) ?? [];
    if (prefInd.length && compInd.length) {
      const hit = compInd.some((i) => prefInd.includes(i));
      score += hit ? 10 : -5;
      indReasons.push({ code: hit ? 'industry_preferred' : 'industry_not_preferred', text: hit ? 'The company works in an industry from your preferences.' : 'The company does not work in an industry from your preferences.', points: hit ? 5 : -3 });
    }
    industry = Math.max(0, Math.min(100, score));
    indReasons.unshift({
      code: same.length ? 'field_matched' : 'field_new',
      text: same.length
        ? `Your past title "${same[0]!.w.title}" at ${same[0]!.w.company} is in the same field (${jobFn}).`
        : `None of your past titles is in this job's field (${jobFn}).`,
      points: same.length ? 10 : -10,
    });
  } else {
    indReasons.push({ code: 'industry_unknown', text: profile.work.length ? 'jobleft cannot tell the field of this job from its title.' : 'Your profile has no work experience yet.', points: 0 });
  }

  const parts: Array<[number | null, number]> = [[exp, 0.35], [skills, 0.45], [industry, 0.2]];
  const known = parts.filter((p) => p[0] !== null) as Array<[number, number]>;
  if (!known.length) return null;
  const wsum = known.reduce((s, p) => s + p[1], 0);
  let percent = Math.round(known.reduce((s, p) => s + p[0] * p[1], 0) / wsum);

  // ---- blockers from the posting's own words
  const blockers: Blocker[] = [];
  const wa = profile.workAuthorization;
  const cap = (n: number) => { percent = Math.min(percent, n); };
  if (job.statements.sponsorship === 'no') {
    if (wa.needsSponsorship === 'yes') { blockers.push({ kind: 'sponsorship', message: 'The posting says it cannot sponsor a visa, and your profile says you need sponsorship.', evidence: job.evidence.sponsorship ?? null }); cap(40); }
    else if (wa.needsSponsorship === null) blockers.push({ kind: 'sponsorship', message: 'The posting says it cannot sponsor a visa. Your profile does not say whether you need sponsorship.', evidence: job.evidence.sponsorship ?? null });
  }
  if (job.statements.usCitizenOnly) {
    if (wa.usCitizen === 'no') { blockers.push({ kind: 'citizenship', message: 'The posting requires US citizenship, and your profile says you are not a US citizen.', evidence: job.evidence.usCitizenOnly ?? null }); cap(30); }
    else if (wa.usCitizen === null) blockers.push({ kind: 'citizenship', message: 'The posting requires US citizenship. Your profile does not answer this.', evidence: job.evidence.usCitizenOnly ?? null });
  }
  if (job.statements.clearanceRequired) {
    if (wa.hasSecurityClearance === 'no') { blockers.push({ kind: 'clearance', message: 'The posting requires a security clearance, and your profile says you have none.', evidence: job.evidence.clearanceRequired ?? null }); cap(40); }
    else if (wa.hasSecurityClearance === null) blockers.push({ kind: 'clearance', message: 'The posting requires a security clearance. Your profile does not answer this.', evidence: job.evidence.clearanceRequired ?? null });
  }

  // ---- why-fit chips (positive first)
  const chips: WhyFitChip[] = [];
  if (company?.h1b?.status === 'likely' && job.statements.sponsorship !== 'no') chips.push({ kind: 'h1b_sponsor_likely', label: 'H-1B sponsor likely', positive: true });
  if (job.statements.sponsorship === 'yes') chips.push({ kind: 'post_says_sponsors', label: 'Posting offers visa sponsorship', positive: true });
  if (skills !== null && skills >= 80) chips.push({ kind: 'skills', label: 'Strong skills overlap', positive: true });
  if (exp !== null && exp >= 85) chips.push({ kind: 'level', label: 'Level fits your experience', positive: true });
  const minPay = profile.preferences.minAnnualPayUsd;
  if (minPay !== null && job.pay?.currency === 'USD' && (job.pay.annualMax ?? job.pay.annualMin ?? 0) >= minPay) chips.push({ kind: 'comp_benefits', label: 'Pay meets your minimum', positive: true });
  if (ctx.networkCount) chips.push({ kind: 'network', label: `You know ${ctx.networkCount} ${ctx.networkCount === 1 ? 'person' : 'people'} here`, positive: true });
  if (skills !== null && skills < 40) chips.push({ kind: 'skills', label: 'Few of the named skills', positive: false });

  for (const r of [...expReasons, ...skillReasons, ...indReasons]) reasons.push(r);
  const unknownParts = (['experienceLevel', 'skills', 'industryExperience'] as const).filter((_, i) => parts[i]![0] === null);
  const thin = job.description.length < 300;
  const computedAt = [profile.updatedAt, job.updatedAt].sort().at(-1)!;
  const result: MatchResult & Record<string, unknown> = {
    jobId: job.id,
    profileVersion: profile.version,
    engineVersion: ENGINE_VERSION,
    percent,
    band: bandFor(percent),
    subScores: {
      experienceLevel: { percent: exp, reasons: expReasons },
      skills: { percent: skills, reasons: skillReasons },
      industryExperience: { percent: industry, reasons: indReasons },
    },
    whyFit: chips.slice(0, 4),
    blockers,
    reasons,
    skills: { matched, missing, required, preferred },
    experienceYearsUsed: years,
    computedAt,
    // optional fields the match lane adds (readers that do not know them show nothing)
    complete: unknownParts.length === 0 && !thin,
    unknownParts,
    notes: thin ? ['The posting is very short, so this score rests on little information.'] : [],
  };
  return result;
}
