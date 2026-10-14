// The language facts of a posting, for a person looking for work in the Netherlands: whether it is written in Dutch,
// and whether it says Dutch is required, a plus, or not required. Read from the posting's own sentences, sentence by
// sentence; a sentence counts only when it is about speaking or writing the language ("fluent in Dutch", "vloeiend
// Nederlands"), not about Dutch law, holidays or universities. The sentence is kept as the evidence.

export type DutchNeed = 'required' | 'preferred' | 'not_required';
export interface LanguageFacts { posting: 'en' | 'nl' | 'other' | null; dutch: DutchNeed | null; evidence?: string }

const NL_WORDS = new Set('de het een en van je jij jouw u wij we ons onze is zijn bent wordt worden voor met bij naar ook als aan te dat die dit wat hoe er niet geen maar om uit tot over door hebt heeft hebben kunt kan zal wil werk functie vacature ervaring jaar binnen onder zoals waar daarnaast samen goed goede'.split(' '));
const EN_WORDS = new Set('the and of to a in for with you your we our is are be will as on at by this that from or an have has work team role experience years who what'.split(' '));

/** The language a posting is written in: Dutch, English, something else, or null for too little text. */
export function postingLanguage(text: string): LanguageFacts['posting'] {
  const words = text.slice(0, 4000).toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 30) return null;
  let nl = 0, en = 0;
  for (const w of words) { if (NL_WORDS.has(w)) nl++; if (EN_WORDS.has(w)) en++; }
  if (nl / words.length >= 0.12 && nl > en * 1.3) return 'nl';
  if (en / words.length >= 0.08) return 'en';
  return 'other';
}

const MENTION = /\b(dutch|nederlands\w*)\b/i;
/** "Dutch" that names something else: Dutch law, the Dutch market, a Dutch university, Dutch holidays. */
const NOT_LANGUAGE = /\b(dutch|nederlandse?)\s+(labou?r|law|laws|market|mortgage|universit\w*|national|holidays?|calendar|ra|rc|regulat\w*|tax|government|msp|intelligence|roots|bank\w*|financial|caramel|compan\w*|clients?|context|landscape|culture|institution\w*|wetgeving|arbeidsrecht|markt|overheid|roots)\b/gi;
/** "Dutch is a plus", "Nederlands is een pré": a plus without a word about speaking or writing. */
const DIRECT_PLUS = /\b(dutch|nederlands)\b[^.;]{0,25}\b(is|als|would be)\b[^.;]{0,12}\b(a plus|an advantage|preferred|useful|een pr[ée]|een pluspunt|pluspunt|een voordeel|handig)/i;
/** Words that make a sentence about speaking or writing a language. */
const SKILL = /\b(fluen\w*|proficien\w*|speak\w*|spoken|writ\w*|command|knowledge of (?:the )?dutch|languages?|native|conversational|[abc][12]\b|beheers\w*|vloeiend\w*|spreek\w*|spreekt|spreken|schrijf\w*|schrijft|taal|talen|moedertaal\w*|communicat\w*|mondeling\w*|schriftelijk\w*|in het nederlands|nederlandstalig\w*)/i;
const NOT_NEEDED = /\b(not (?:required|necessary|needed|essential|a requirement|mandatory)|no dutch|without dutch|niet (?:vereist|nodig|noodzakelijk|verplicht))\b/i;
const PLUS = /\b(plus|preferred|preferabl\w*|preference|advantage|nice to have|bonus|useful|ideally|optional|pr[ée]|pluspunt|voordeel)\b/i;
/** "German or Dutch", "French and/or Dutch": one of several languages, so Dutch itself is not needed. */
// The Dutch "of" means "or" only next to "Nederlands": "command of Dutch" is not a choice.
const EITHER = /\b(or|and\/or)\s+(?:in\s+)?dutch\b|\bdutch\s*,?\s+or\b|\bof\s+(?:het\s+)?nederlands\b|\bnederlands\s*,?\s+of\b/i;

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim().replace(/^[-•·*]\s*/, '');
  return [...t].length > 200 ? [...t].slice(0, 199).join('') + '…' : t;
}

/** What the posting says about Dutch, with the sentence that says it. */
export function dutchNeed(text: string): { need: DutchNeed; evidence: string } | null {
  let plus: string | null = null;
  let notNeeded: string | null = null;
  for (const raw of text.split(/(?<=[.!?;])\s+|\n+/)) {
    const about = raw.replace(NOT_LANGUAGE, ' ');
    if (!MENTION.test(about)) continue;
    const s = clip(raw);
    if (DIRECT_PLUS.test(about)) { plus ??= s; continue; }
    if (!SKILL.test(about)) continue;
    // "(native not required)" is about native level, not about Dutch: brackets do not decide. Nor does "preferably
    // French": that plus is about another language.
    const main = about.replace(/\([^)]*\)/g, ' ').replace(/\b(preferabl\w*|ideally|bij voorkeur)\s+(?!dutch|nederlands|in dutch)\p{L}+/giu, ' ');
    if (NOT_NEEDED.test(main)) { if (PLUS.test(main)) plus ??= s; else notNeeded ??= s; continue; }
    if (PLUS.test(main) || EITHER.test(main)) { plus ??= s; continue; }
    return { need: 'required', evidence: s };
  }
  if (notNeeded) return { need: 'not_required', evidence: notNeeded };
  if (plus) return { need: 'preferred', evidence: plus };
  return null;
}

export function languageFacts(title: string, description: string): LanguageFacts {
  const posting = postingLanguage(`${title}\n${description}`);
  const d = dutchNeed(description);
  return { posting, dutch: d?.need ?? null, ...(d ? { evidence: d.evidence } : {}) };
}

/** Whether the person who leaves out "jobs that need Dutch" should not see this one: it says so, or it is written in Dutch and does not say Dutch is not required. */
export function needsDutch(f: LanguageFacts): boolean {
  return f.dutch === 'required' || (f.posting === 'nl' && f.dutch !== 'not_required');
}
