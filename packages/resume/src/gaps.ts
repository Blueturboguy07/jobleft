// Keyword gaps (resume O6): the key terms a job names, each one covered by the resume, in the profile but not on
// the resume, or not in the profile at all. Whole-term matching ("Java" is not "JavaScript") and short forms
// ("k8s" is Kubernetes). Deterministic: same inputs, same list. No score that rewards repeating a word.

import type { Job, KeywordGapReport, Profile, ResumeDocument } from '@jobleft/contracts';
import type { SkillDictionary } from '@jobleft/static-data';
import { documentText } from './document.ts';
import { canonicalSkill, findCertifications, findDegrees, findSkills, isCaseSensitiveForm, skillForms } from './facts.ts';
import { CERTS, DEGREE_LEVELS } from './lexicon.ts';
import { profileTexts } from './truth.ts';
import { termRegExp } from './text.ts';

/** jobleft's own skill list as a SkillDictionary (used when the shared dictionary is not available). */
export function builtinSkillDictionary(): SkillDictionary {
  return {
    canonical: (term) => canonicalSkill(term),
    aliases: (canonical) => skillForms(canonical).filter((f) => f !== canonical),
    extract: (text) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const m of [...findCertifications(text), ...findSkills(text)].sort((a, b) => a.start - b.start)) {
        const c = canonicalSkill(m.text) ?? m.text;
        if (seen.has(c.toLowerCase())) continue;
        seen.add(c.toLowerCase());
        out.push(c);
      }
      return out;
    },
  };
}

/** A dictionary that never throws: the shared one when it works, jobleft's own list otherwise. */
export function safeDictionary(skills: SkillDictionary | null | undefined): SkillDictionary {
  const own = builtinSkillDictionary();
  if (!skills) return own;
  const guard = <T>(f: () => T, fallback: () => T): T => { try { return f(); } catch { return fallback(); } };
  return {
    canonical: (t) => guard(() => skills.canonical(t), () => null) ?? own.canonical(t),
    aliases: (c) => [...new Set([...guard(() => skills.aliases(c), () => [] as string[]), ...own.aliases(c)])],
    extract: (text) => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const s of [...guard(() => skills.extract(text), () => [] as string[]), ...own.extract(text)]) {
        const k = (own.canonical(s) ?? s).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(own.canonical(s) ?? s);
      }
      return out;
    },
  };
}

export interface JobTerm {
  term: string;
  key: string;
  kind: 'skill' | 'certification' | 'degree';
  forms: Array<{ text: string; caseSensitive: boolean }>;
  /** For degrees: the level ("doctorate"). */
  level?: string;
}

function formsFor(canonical: string, dict: SkillDictionary): JobTerm['forms'] {
  const all = new Set<string>([canonical, ...dict.aliases(canonical), ...skillForms(canonical)]);
  return [...all].filter(Boolean).map((f) => ({ text: f, caseSensitive: isCaseSensitiveForm(canonical, f) }));
}

/** The key terms of a job posting, in order of first appearance. */
export function jobTerms(job: Job, skills: SkillDictionary): JobTerm[] {
  const dict = safeDictionary(skills);
  const text = `${job.title}\n${job.description}`;
  const found: Array<{ at: number; t: JobTerm }> = [];
  const seen = new Set<string>();
  const add = (at: number, t: JobTerm) => { if (seen.has(t.key)) return; seen.add(t.key); found.push({ at, t }); };
  for (const m of findCertifications(text)) {
    const c = canonicalSkill(m.text) ?? m.text;
    add(m.start, { term: c, key: c.toLowerCase(), kind: 'certification', forms: formsFor(c, dict) });
  }
  for (const m of findSkills(text)) {
    const c = canonicalSkill(m.text) ?? m.text;
    add(m.start, { term: c, key: c.toLowerCase(), kind: 'skill', forms: formsFor(c, dict) });
  }
  for (const s of dict.extract(text)) {
    const c = dict.canonical(s) ?? s;
    const at = text.toLowerCase().indexOf(s.toLowerCase());
    add(at < 0 ? text.length : at, { term: c, key: c.toLowerCase(), kind: CERTS.some((e) => e.canonical === c) ? 'certification' : 'skill', forms: formsFor(c, dict) });
  }
  for (const s of job.skills) {
    const c = dict.canonical(s) ?? canonicalSkill(s) ?? s;
    add(text.length + 1, { term: c, key: c.toLowerCase(), kind: 'skill', forms: formsFor(c, dict) });
  }
  for (const m of findDegrees(text)) {
    const lvl = DEGREE_LEVELS.find((d) => d.level === m.level)!;
    add(m.start, { term: m.level === 'doctorate' ? 'PhD' : lvl.label, key: `degree:${m.level}`, kind: 'degree', level: m.level, forms: [] });
  }
  if (job.statements.clearanceRequired === true && !seen.has('security clearance')) {
    add(text.length + 2, { term: 'Security clearance', key: 'security clearance', kind: 'certification', forms: formsFor('Security clearance', dict) });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.t);
}

function findForm(text: string, t: JobTerm): string | null {
  for (const f of t.forms) {
    const re = termRegExp(f.text, f.caseSensitive, 'g');
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

function degreeLevelsIn(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of findDegrees(t)) out.add(m.level!);
  return out;
}

export function keywordGaps(job: Job, resume: ResumeDocument, profile: Profile, skills: SkillDictionary, resumeId = 'resume'): KeywordGapReport {
  const desc = job.description.trim();
  const terms = desc.length >= 20 ? jobTerms(job, skills) : [];
  if (!terms.length) return { jobId: job.id, resumeId, requirementsFound: false, terms: [] };
  const resumeText = documentText(resume);
  const profText = profileTexts(profile).join('\n');
  const resumeDegrees = degreeLevelsIn(resume.sections.filter((s) => s.kind === 'education').flatMap((s) => s.items.map((i) => i.subheading ?? '')));
  const profileDegrees = degreeLevelsIn(profile.education.map((e) => [e.degree, e.major].filter(Boolean).join(' in ')));
  const clearance = profile.workAuthorization.hasSecurityClearance === 'yes';
  return {
    jobId: job.id,
    resumeId,
    requirementsFound: true,
    terms: terms.map((t) => {
      if (t.kind === 'degree') {
        if (resumeDegrees.has(t.level!)) return { term: t.term, status: 'covered' as const, matchedAs: t.term };
        if (profileDegrees.has(t.level!)) return { term: t.term, status: 'in_profile_not_resume' as const, matchedAs: t.term };
        return { term: t.term, status: 'not_in_profile' as const, matchedAs: null };
      }
      const onResume = findForm(resumeText, t);
      if (onResume) return { term: t.term, status: 'covered' as const, matchedAs: onResume };
      const inProfile = findForm(profText, t) ?? (t.key === 'security clearance' && clearance ? 'security clearance' : null);
      if (inProfile) return { term: t.term, status: 'in_profile_not_resume' as const, matchedAs: inProfile };
      return { term: t.term, status: 'not_in_profile' as const, matchedAs: null };
    }),
  };
}
