// AI-written text about a match: what it may say, and a check that it does not contradict the numbers.
// An AI provider may write the narrative only, never the number. The brief below is everything it gets: no name, no
// contact details, no equal-employment answers, no work-authorization answers, only the facts the score view shows.

import type { MatchResult } from '@jobleft/contracts';
import { MATCH_BAND_LABELS } from '@jobleft/contracts';

export const AI_TEXT_LABEL = 'AI-written summary. The percent, the parts and the warnings come from jobleft rules, not from AI.';

export interface NarrativeBrief {
  /** A key that changes only when the profile, the job or the rules change: cache the narrative under it. */
  cacheKey: string;
  percent: number;
  band: string;
  complete: boolean;
  parts: Array<{ name: string; percent: number | null }>;
  strengths: string[];
  gaps: string[];
  warnings: string[];
  /** Skills the profile does not have: the text must never present them as strengths. */
  mustNotClaim: string[];
  rules: string[];
}

export function narrativeBrief(r: MatchResult, jobContentHash: string): NarrativeBrief {
  const strengths = [
    ...r.whyFit.filter((c) => c.positive).map((c) => c.label),
    ...(r.skills.matched.length ? [`Has: ${r.skills.matched.slice(0, 8).join(', ')}`] : []),
  ];
  const gaps = [
    ...(r.skills.missing.length ? [`Missing: ${r.skills.missing.slice(0, 8).join(', ')}`] : []),
    ...r.whyFit.filter((c) => !c.positive).map((c) => c.label),
  ];
  return {
    cacheKey: `${r.engineVersion}|${r.profileVersion}|${jobContentHash}`,
    percent: r.percent,
    band: MATCH_BAND_LABELS[r.band],
    complete: r.complete !== false,
    parts: [
      { name: 'Experience Level', percent: r.subScores.experienceLevel.percent },
      { name: 'Skills', percent: r.subScores.skills.percent },
      { name: 'Industry Experience', percent: r.subScores.industryExperience.percent },
    ],
    strengths,
    gaps,
    warnings: r.blockers.map((b) => b.message),
    mustNotClaim: r.skills.missing,
    rules: [
      'Do not state or change any number; the numbers are shown next to your text.',
      `The band is ${MATCH_BAND_LABELS[r.band]}. Do not call the job a stronger fit than that.`,
      'Do not present anything in mustNotClaim as a strength or as something the person has.',
      'Do not mention name, age, gender, race, ethnicity, religion, disability, veteran status, sexual orientation or photo.',
      'Mention a citizenship, clearance or visa requirement only as the posting\'s own requirement.',
      'Mention every warning.',
    ],
  };
}

export interface NarrativeIssue {
  code: 'claims_stronger_band' | 'claims_missing_skill' | 'contradicts_percent' | 'mentions_protected_trait' | 'omits_warning';
  text: string;
}

const STRONG_WORDS = /\b(strong|excellent|great|perfect|ideal|outstanding|exceptional|top|near-perfect|superb)\s+(fit|match|candidate|alignment)\b/i;
const GOOD_WORDS = /\b(good|solid)\s+(fit|match)\b/i;
const POSITIVE = /\b(you have|your|strong|proficien\w*|skilled|expert\w*|experienced|experience (with|in)|background in|brings?|familiar(ity)? with|knowledge of|mastery|solid)\b/i;
const NEGATIVE = /\b(lack\w*|missing|not|no|gap\w*|without|develop|learn\w*|build up|would need|needs?|could add|consider adding|absent)\b/i;
const PROTECTED = /\b(gender|genders|male|female|race|racial|ethnicity|ethnic background|hispanic|latin[oa]|veteran status|veterans? (status|background)|disability|disabilities|disabled|pronouns?|religion|religious|nationality|your age|years old|photo|photograph|sexual orientation|lgbtq\+?)\b/i;

/** Problems in an AI-written text about this match. An empty list means it agrees with the score view. */
export function checkNarrative(text: string, r: MatchResult): NarrativeIssue[] {
  const issues: NarrativeIssue[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
  for (const s of sentences) {
    const negated = /\b(not|isn'?t|no|hardly)\s+(a\s+)?(strong|excellent|great|perfect|ideal|good)\b/i.test(s);
    if (!negated && r.band !== 'strong' && STRONG_WORDS.test(s)) issues.push({ code: 'claims_stronger_band', text: `Calls a ${MATCH_BAND_LABELS[r.band]} job a strong fit: "${s.trim()}"` });
    if (!negated && r.band === 'fair' && GOOD_WORDS.test(s)) issues.push({ code: 'claims_stronger_band', text: `Calls a FAIR MATCH job a good fit: "${s.trim()}"` });
    for (const skill of r.skills.missing) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}+#])${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}+#])`, 'iu');
      if (re.test(s) && POSITIVE.test(s) && !NEGATIVE.test(s)) issues.push({ code: 'claims_missing_skill', text: `Presents ${skill} as a strength, but it is not in the profile: "${s.trim()}"` });
    }
    const pcts = [...s.matchAll(/\b(\d{1,3})\s?%/g)].map((m) => Number(m[1]));
    for (const p of pcts) if (p !== r.percent && ![r.subScores.experienceLevel.percent, r.subScores.skills.percent, r.subScores.industryExperience.percent].includes(p)) {
      issues.push({ code: 'contradicts_percent', text: `States ${p}%, which is not a number in the score view: "${s.trim()}"` });
    }
    if (PROTECTED.test(s)) issues.push({ code: 'mentions_protected_trait', text: `Mentions a protected trait or identity detail: "${s.trim()}"` });
  }
  return issues;
}
