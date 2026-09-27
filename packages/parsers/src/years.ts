// Required years of experience (parsers O6): the lowest number that meets the requirement.
// "Must be 18 years or older", "serving customers for over 50 years" and "vests over 4 years" are never read.
import type { FactEvidence } from '@jobleft/contracts';
import { cutOtherJobs, dropOtherRoles, normalizeText, snippet, WORD_NUMBERS } from './text.ts';

export interface YearsResult {
  min: number | null;
  max: number | null;
  evidence: FactEvidence;
}

const NUMW = '(\\d{1,2}(?:\\.5)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|a|an|uno|dos|tres|cuatro|cinco|seis|diez|un|une|deux|trois|quatre|cinq|ein|eine|zwei|drei|vier|fünf|sechs|zehn|um|dois|três)';
// "3+ years", "3-5 years", "3 to 5 years", "three (3) years", "at least 3 years", "3 years or more", "3 yrs".
const MENTION = new RegExp(
  `(?:(at\\s+least|minimum\\s+(?:of\\s+)?|min\\.?\\s*|a\\s+minimum\\s+of|no\\s+less\\s+than|more\\s+than|over|in\\s+excess\\s+of|upwards\\s+of|up\\s+to|mínimo(?:\\s+de)?|al\\s+menos|au\\s+moins|mindestens)\\s+)?` +
  `\\b${NUMW}(?:\\s*\\(\\s*\\d{1,2}\\s*\\))?\\s*(\\+|plus)?\\s*(?:(?:-|–|to|a|à|bis|or)\\s*${NUMW}\\s*(\\+)?\\s*)?` +
  `(?:full[- ]time\\s+|consecutive\\s+|calendar\\s+)?(years?|yrs?|yoe|años|anos|ans|années|jahre|jahren)(?![a-z])(\\s*(?:\\+|or\\s+more|or\\s+longer|or\\s+greater|and\\s+above|minimum|min\\.?))?`,
  'gi',
);

/** Words after the number that show it is an experience requirement. */
const EXP_AFTER = /^[^.;\n]{0,90}?\b(?:experience|experiences|exp\b|expertise|expérience|experiencia|experiência|erfahrung|berufserfahrung|working\b|work(?:ed)?\s+(?:in|with|as|at|on|for)\b|background|practice|practicing|track\s+record|hands[- ]on|in\s+(?:an?|the)\s+(?:[\w-]+\s+){0,3}(?:role|position|setting|environment|capacity|field|industry|function)|(?:building|developing|designing|leading|managing|working|writing|shipping|selling|teaching|supervising|coding|programming|engineering|delivering|running|operating|owning|driving|creating|implementing|deploying|maintaining|supporting|serving|providing|performing|conducting|administering|analyzing|analysing|handling|overseeing|coordinating|recruiting|training|caring|treating|practicing|practising)\b|in\s+(?:[\w&/-]+\s+){0,3}(?:management|sales|engineering|development|design|marketing|finance|accounting|operations|consulting|healthcare|nursing|retail|hospitality|industry|field|role|roles|position|positions|setting|environment|space|domain|capacity|function|leadership|recruiting|research|analytics|product|security|support|education|teaching|law|practice)\b|of\s+(?:[\w-]+\s+){0,3}(?:work|employment|leadership|management|supervis\w+|teaching|sales|driving|nursing|coding|programming|engineering|development|design|accounting|auditing|recruiting|consulting|research))/i;
/** "yoe" and "5 years experience" need no more words. */
const EXP_TIGHT = /^\s*(?:of\s+)?(?:(?:relevant|related|professional|progressive|prior|previous|recent|direct|post-?graduate|post-?licensure|paid|full[- ]time|industry|clinical|work|job)\s+)*(?:experience|exp\b|expérience|experiencia|experiência|erfahrung|berufserfahrung)/i;

/** Things with years that are not an experience requirement. */
const NOT_EXP_AFTER = /^\s*(?:of\s+age|old\b|or\s+older|of\s+(?:college|university|school|schooling|education|study|studies|coursework|post-?secondary|high\s+school|service\b(?!\s+experience)|history|operation|business|existence|growth)|in\s+(?:business|operation|a\s+row)|ago\b|consecutive|in\s+a\s+row|degree|college|program|contract|commitment|term|warranty|plan\b|vesting|cliff|guarantee|lease|agreement|residency\s+program|apprenticeship\s+program)/i;
const NOT_EXP_LEAD = /\b(?:age|aged|ages|older\s+than|be\s+at\s+least|must\s+be|vest\w*|vesting|over\s+the\s+(?:next|last|past|previous|coming)|in\s+(?:just\s+)?(?:under|over|less\s+than)|within(?:\s+the)?(?:\s+(?:last|past|first|next))?|in\s+the\s+(?:last|past|next|first)|during\s+the\s+(?:last|past)|for\s+(?:the\s+)?(?:last|past)|every|each|after|once|since|founded|established|serving|served|been|history|anniversary|renew\w*|valid\s+for|commit\w*\s+(?:to|for))\s*$/i;
/** The company or its team has the years ("our team has 20+ years", "a family business with over 50 years"). */
const COMPANY_HAS = /(?:\b(?:we|we've|we're|our\s+(?:[\w-]+\s+){0,2}(?:team|company|firm|founders?|leaders(?:hip)?|clinicians|staff|people|experts|partners|business|organization|family)|the\s+(?:company|firm|team)|founders?|company|firm|business|organization)\s+(?:have|has|bring|brings|combine|combines|boast|boasts|possess|possesses|with)\b[^.;\n]{0,40}$)|\bfor\s+(?:over|more\s+than|nearly|almost|about|close\s+to)\s*$/i;
const PREFERRED = /\b(?:prefer(?:red|ably|ence)?|nice[- ]to[- ]have|a\s+plus|is\s+a\s+plus|bonus|ideally|desired|desirable|would\s+be\s+(?:great|nice|a\s+plus)|an?\s+asset|advantage(?:ous)?|plus\b|optional|deseable|souhaité|wünschenswert)\b/i;
const PREF_HEADING = /^\s*(?:#+\s*)?(?:preferred|nice[- ]to[- ]haves?|bonus|desired|pluses|good[- ]to[- ]have|bonus\s+points|what\s+(?:would|will)\s+make\s+you\s+stand\s+out|additional\s+qualifications|preferred\s+(?:qualifications|skills|experience|requirements))\b/i;
const REQ_HEADING = /^\s*(?:#+\s*)?(?:required|requirements|minimum|basic\s+qualifications|minimum\s+qualifications|must[- ]haves?|what\s+you(?:'ll)?\s+need|what\s+you\s+bring|qualifications|who\s+you\s+are|what\s+we(?:'re|\s+are)?\s+looking\s+for|about\s+you|skills\s+and\s+experience|experience)\b/i;
const DEGREE = /\b(?:bachelor'?s?|master'?s?|mba|ph\.?d|doctorate|doctoral|associate'?s?\s+degree|high\s+school|ged|degree|b\.?s\.?|m\.?s\.?|b\.?a\.?|licen[cs]e|certification|diploma)\b/i;

function num(s: string | undefined): number | null {
  if (!s) return null;
  const k = s.toLowerCase();
  if (/^\d/.test(k)) return Math.floor(parseFloat(k));
  const w = WORD_NUMBERS[k];
  return w === undefined ? null : w;
}

interface Mention {
  index: number;
  end: number;
  min: number;
  max: number | null;
  preferred: boolean;
  sentence: number;
  line: number;
  degree: boolean;
}

function sentenceBounds(text: string): number[] {
  // Start index of each sentence or line.
  const starts = [0];
  const re = /[.!?](?=\s+[A-Z(])|\n|;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // "U.S." and "e.g." are not sentence ends.
    if (m[0] === '.' && /\b(?:[A-Z]|e\.g|i\.e|etc|vs|approx|min|max|yrs?|No)\.?$/.test(text.slice(Math.max(0, m.index - 5), m.index + 1))) continue;
    starts.push(m.index + 1);
  }
  return starts;
}

function indexOfStart(starts: number[], i: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * The years of experience a posting asks for, or null. Alternatives ("5 years, or 3 years with a master's degree")
 * give the lowest; a preferred figure never replaces a required one.
 */
export function parseYearsRequired(input: string): YearsResult | null {
  if (!input) return null;
  const text = dropOtherRoles(cutOtherJobs(normalizeText(input)));
  const sentStarts = sentenceBounds(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lines = text.split('\n');
  // The heading each line sits under (required or preferred).
  const lineKind: Array<'req' | 'pref' | null> = [];
  let kind: 'req' | 'pref' | null = null;
  for (const l of lines) {
    const t = l.trim();
    if (t.length <= 80 && PREF_HEADING.test(t)) kind = 'pref';
    else if (t.length <= 80 && REQ_HEADING.test(t) && !PREFERRED.test(t)) kind = 'req';
    lineKind.push(kind);
  }
  const mentions: Mention[] = [];
  MENTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION.exec(text)) !== null && mentions.length < 300) {
    const idx = m.index, end = idx + m[0].length;
    // The number must stand alone ("W2", "401k" and "H1B" are not years).
    if (idx > 0 && /[A-Za-z0-9$€£]/.test(text[idx - 1]) && !m[1]) continue;
    const qual = (m[1] ?? '').toLowerCase().trim();
    let a = num(m[2]);
    let b = num(m[4]);
    if (a === null) continue;
    // "a year" alone is a requirement only in "a year of experience"; "an" likewise.
    const after = text.slice(end, end + 120);
    const lead = text.slice(Math.max(0, idx - 60), idx);
    if (NOT_EXP_AFTER.test(after)) continue;
    // The qualifier ("over", "at least") is part of the match; the lead phrase runs up to the number.
    const leadQ = (lead + (m[1] ?? '')).replace(/\s+$/, ' ');
    if (NOT_EXP_LEAD.test(lead) || NOT_EXP_LEAD.test(leadQ.trimEnd())) continue;
    // "candidates with over 5 years" is a requirement; "our team has 20+ years" and "for over 50 years" are not.
    if ((COMPANY_HAS.test(lead) || COMPANY_HAS.test(leadQ.trimEnd())) && !/\b(?:candidates?|applicants?|you|your|ideal|successful|someone|somebody|individual|person|professional|looking\s+for|seeking|need|require)\b[^.;\n]{0,40}$/i.test(lead)) continue;
    if (qual === 'up to') continue; // "up to 5 years" is never a minimum
    if (!(EXP_TIGHT.test(after) || EXP_AFTER.test(after))) continue;
    if (/\bage\b|\bold\b/i.test(after.slice(0, 20))) continue;
    if (b !== null && b < a) { const t = a; a = b; b = t; }
    // "6 months to 1 year of experience": the lowest that meets it is under a year.
    if (/\b\d{1,2}\s*(?:months?|mos?)\s*(?:to|-|–|or)\s*$/i.test(lead)) { b = a; a = 0; }
    if (qual === 'more than' || qual === 'over' || qual === 'in excess of' || qual === 'upwards of') b = null;
    if (a > 30 || (b !== null && b > 40)) continue;
    const s = indexOfStart(sentStarts, idx);
    const line = indexOfStart(lineStarts, idx);
    const lineText = lines[line] ?? '';
    const sentText = text.slice(sentStarts[s], sentStarts[s + 1] ?? text.length);
    // Words about another thing in the sentence do not make the years optional: "3-4 years of sales experience
    // (equipment sales experience is a plus)", "1+ years of customer service, preferably in hospitality". A bracket
    // that only says "(preferred)" or "(nice to have)" still does.
    const own = sentText
      .replace(/\(([^)]*)\)/g, (all, inner: string) => (/^\s*(?:strongly\s+)?(?:nice[- ]to[- ]have|preferred|a\s+plus|is\s+a\s+plus|bonus|optional|desired|ideal|ideally)\s*$/i.test(inner) ? all : ' '))
      .replace(/\b(?:preferably|ideally)\s+(?:in|with|within|at|on|as|from|using|including|for|[a-z]+ing)\b[^.;\n]*/gi, ' ');
    const preferred = PREFERRED.test(own) || lineKind[line] === 'pref';
    mentions.push({ index: idx, end, min: a, max: m[3] || m[5] || m[7] ? null : b, preferred, sentence: s, line, degree: DEGREE.test(lineText) });
  }
  if (!mentions.length) return null;
  // "5+ years of experience, or 3 years with an MBA": an alternative in the same sentence needs no experience words.
  // Once per sentence, and only near the mentions, so a long text with no sentence breaks stays fast.
  const seenEnds = new Set(mentions.map((x) => x.end));
  const bySent = new Map<number, Mention>();
  for (const x of mentions) if (!bySent.has(x.sentence)) bySent.set(x.sentence, x);
  const alt = new RegExp(`\\b(?:or|alternatively|otherwise)\\s+(?:with\\s+)?(?:an?\\s+)?(?:[\\w'-]+\\s+){0,4}?${NUMW}\\s*(\\+)?\\s*(?:years?|yrs?)\\b`, 'gi');
  let added = 0;
  for (const base of bySent.values()) {
    const sStart = Math.max(sentStarts[base.sentence], base.index - 400);
    const sEnd = Math.min(sentStarts[base.sentence + 1] ?? text.length, base.end + 400);
    const sent = text.slice(sStart, sEnd);
    alt.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = alt.exec(sent)) !== null && added < 50) {
      const at = sStart + am.index + am[0].length;
      if (seenEnds.has(at) || mentions.some((x) => x.index <= at && x.end >= at)) continue;
      const v = num(am[1]);
      if (v === null || v > 30) continue;
      if (NOT_EXP_AFTER.test(text.slice(at, at + 60))) continue;
      mentions.push({ ...base, index: sStart + am.index, end: at, min: v, max: null });
      seenEnds.add(at);
      added++;
    }
  }
  // A preferred figure is not a requirement: a posting that only prefers years states no required years.
  const pool = mentions.filter((x) => !x.preferred);
  if (!pool.length) return null;
  // Alternatives: "or" between two mentions in one sentence, or lines keyed by degree ("Bachelor's and 4 years" /
  // "Master's and 2 years") give the lowest. Everything else is a joint requirement and gives the highest.
  const bySentence = new Map<number, Mention[]>();
  for (const x of pool) bySentence.set(x.sentence, [...(bySentence.get(x.sentence) ?? []), x]);
  const groups: Array<{ value: Mention; members: Mention[] }> = [];
  for (const [, ms] of bySentence) {
    if (ms.length === 1) { groups.push({ value: ms[0], members: ms }); continue; }
    const between = text.slice(ms[0].end, ms[ms.length - 1].index);
    const alt = /\bor\b|\bwith\s+an?\s+(?:master|bachelor|ph\.?d|advanced|graduate)|\((?:[^)]*\b(?:master|ph\.?d|bachelor|degree)\b)/i.test(between) || /\bor\b/i.test(text.slice(Math.max(0, ms[0].index - 3), ms[ms.length - 1].end));
    const pick = alt ? ms.reduce((p, c) => (c.min < p.min ? c : p)) : ms.reduce((p, c) => (c.min > p.min ? c : p));
    groups.push({ value: pick, members: ms });
  }
  let chosen: Mention;
  const degreeGroups = groups.filter((g) => g.members.every((x) => x.degree));
  const orLines = groups.length > 1 && groups.every((g, i) => i === 0 || /^\s*(?:-\s*)?(?:or|OR)\b|\bor\s*$/m.test(text.slice(groups[i - 1].value.end, g.value.index + 3)));
  if (groups.length > 1 && (degreeGroups.length === groups.length || orLines)) {
    chosen = groups.map((g) => g.value).reduce((p, c) => (c.min < p.min ? c : p));
  } else {
    chosen = groups.map((g) => g.value).reduce((p, c) => (c.min > p.min ? c : p));
  }
  const evidence: FactEvidence = { source: 'description', text: snippet(text, chosen.index, chosen.end, 220) };
  return { min: chosen.min, max: chosen.max, evidence };
}
