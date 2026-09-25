import type { Level } from './types.ts';

/**
 * Job level from the title, then from the description. Deliberately generic: it must work for
 * nurses, cashiers and bankers as well as engineers. (freehire's seniority dictionary is IT-centric
 * and its vocabulary stops at intern / junior / middle / senior / lead / staff / principal / c_level.)
 *
 * Order matters: the most senior marker in the title wins over a junior-sounding word
 * ("Associate Director" is a director, "Assistant Manager" is a manager).
 */
const TITLE_RULES: Array<[Level, RegExp]> = [
  ['intern', /\b(intern|internship|co-?op|apprentice|trainee|work[- ]study|student worker)\b/i],
  ['exec', /\b(chief [a-z]+ officer|ceo|cfo|cto|coo|cmo|cio|(?<!vice[ -])president|general manager|managing director|founder)\b/i],
  ['vp', /\b(vp|v\.p\.|vice president|svp|evp|avp)\b/i],
  ['director', /\b(director|head of|regional manager|district manager)\b/i],
  ['principal', /\b(principal|distinguished|fellow)\b/i],
  ['staff', /\bstaff\b(?!\s+(nurse|accountant|attorney|pharmacist|physician|therapist|assistant|writer|psychologist|counselor))/i],
  ['lead', /\b(lead|team lead|tech lead|supervisor|charge nurse|foreman|shift lead|team leader)\b/i],
  ['manager', /\b(manager|mgr|superintendent)\b/i],
  ['senior', /\b(senior|sr\.?|level 3|l3|lvl 3)\b/i],
  ['mid', /\b(level 2|l2|lvl 2|mid[- ]level|intermediate)\b/i],
  ['entry', /\b(junior|jr\.?|entry[- ]level|associate|assistant|coordinator|graduate|new grad|level 1|l1|lvl 1)\b/i],
];

export function levelFromTitle(title: string): Level | null {
  const t = title.trim();
  if (!t) return null;
  for (const [level, re] of TITLE_RULES) if (re.test(t)) return level;
  // Trailing roman numeral, upper case only ("Registered Nurse II"). Never the pronoun "I".
  const roman = /(?:\s|-|,)(I|II|III|IV|V)$/.exec(t);
  if (roman) {
    if (roman[1] === 'I') return 'entry';
    if (roman[1] === 'II') return 'mid';
    return 'senior';
  }
  return null;
}

/** "5+ years of experience" gives a rough level. Weak signal, used only when the title says nothing. */
export function levelFromDescription(desc: string): Level | null {
  const m = /\b(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?)\b[^.\n]{0,40}\bexperience/i.exec(desc);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y <= 1) return 'entry';
  if (y <= 4) return 'mid';
  return 'senior';
}
