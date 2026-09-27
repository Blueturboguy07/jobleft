// What the posting itself says about visa sponsorship, security clearance and citizenship. The company's filing
// history is a different fact (static-data). Equal-opportunity boilerplate ("without regard to citizenship") is not
// a statement about this job.
import type { EmploymentType, FactEvidence, PostingStatements } from '@jobleft/contracts';
import { cutOtherJobs, normalizeText, snippet } from './text.ts';

export interface StatementsResult extends PostingStatements {
  evidence: { sponsorship?: FactEvidence; clearanceRequired?: FactEvidence; usCitizenOnly?: FactEvidence };
}

const SPONSOR_NO = /\b(?:(?:unable|not\s+able|cannot|can\s*not|can't|will\s+not|won't|do(?:es)?\s+not|don't|doesn't|is\s+not\s+able\s+to|are\s+not\s+able\s+to)\s+(?:currently\s+)?(?:to\s+)?(?:offer\s+|provide\s+|support\s+)?(?:visa\s+|h-?1b\s+|employment\s+|work\s+)?sponsor(?:ship|ing)?|no\s+(?:visa\s+|h-?1b\s+|employment\s+)?sponsorship|sponsorship\s+(?:is\s+)?(?:not\s+(?:available|offered|provided|possible)|unavailable)|without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+|future\s+|any\s+)?(?:visa\s+|employer\s+|employment\s+|company\s+)?sponsorship|not\s+eligible\s+for\s+(?:visa\s+)?sponsorship|not\s+(?:be\s+)?(?:providing|offering|sponsoring)\s+(?:visa\s+)?sponsorship|sponsorship\s+will\s+not\s+be\s+(?:provided|offered|available|considered)|(?:do(?:es)?\s+not|don't|doesn't|will\s+not|won't|must\s+not|cannot)\s+(?:now\s+or\s+in\s+the\s+future\s+|currently\s+or\s+in\s+the\s+future\s+|now\s+or\s+later\s+|now\s+or\s+at\s+any\s+time\s+in\s+the\s+future\s+)?(?:require|need)\s+(?:(?:visa|employer|employment|immigration|h-?1b|company)\s+)?sponsorship|(?:not|never)\s+(?:now\s+or\s+in\s+the\s+future|currently\s+or\s+in\s+the\s+future)\s+(?:require|need)\s+(?:(?:visa|employer|employment|immigration|h-?1b|company)\s+)?sponsorship)\b/i;
const SPONSOR_YES = /\b(?:(?:we|company|employer|[A-Z][\w&]+)\s+(?:will|can|do(?:es)?|is\s+able\s+to|are\s+able\s+to|may)\s+(?:consider\s+)?(?:offer\s+|provide\s+)?(?:visa\s+|h-?1b\s+)?sponsor(?:ship)?(?!\s+(?:the|our|events?|a\s+team))|(?:visa|h-?1b|employment)\s+sponsorship\s+(?:is\s+)?(?:available|offered|provided|possible)|sponsorship\s+(?:is\s+)?(?:available|offered|provided)|(?:willing|open)\s+to\s+sponsor|will\s+sponsor\s+(?:visas?|h-?1b|qualified|the\s+right)|offers?\s+(?:visa|h-?1b)\s+sponsorship|sponsorship\s+for\s+(?:qualified|eligible)\s+candidates)\b/i;
const CLEARANCE_REQ = /\b(?:(?:active|current|existing)\s+)?(?:ts\/sci|top\s+secret(?:\/sci)?|secret|public\s+trust|dod|doe\s+[lq]|q|l)\s+(?:level\s+)?(?:security\s+)?clearance(?:\s+with\s+(?:full[- ]scope\s+|ci\s+)?poly(?:graph)?)?\s+(?:is\s+)?(?:required|needed|mandatory)|\b(?:must|required\s+to|need\s+to|should)\s+(?:have|hold|possess|maintain|obtain|be\s+able\s+to\s+obtain|be\s+eligible\s+(?:to|for))\s+(?:an?\s+)?(?:active\s+|current\s+)?(?:(?:ts\/sci|top\s+secret|secret|public\s+trust|dod|government|federal|u\.?s\.?\s+government)\s+)?(?:security\s+)?clearance|\bclearance\s+(?:is\s+)?required\b|\brequires?\s+(?:an?\s+)?(?:active\s+)?(?:ts\/sci|top\s+secret|secret|security)\s+clearance|\bability\s+to\s+(?:obtain|get)\s+(?:and\s+maintain\s+)?(?:an?\s+)?(?:(?:ts\/sci|top\s+secret|secret|public\s+trust|dod|government|federal)\s+)?(?:security\s+)?clearance\b|\b(?:active|current)\s+(?:ts\/sci|top\s+secret|secret)\s+clearance\b/i;
const CLEARANCE_NO = /\b(?:no\s+(?:security\s+)?clearance\s+(?:is\s+)?(?:required|needed)|(?:security\s+)?clearance\s+(?:is\s+)?not\s+required|does\s+not\s+require\s+(?:a\s+)?(?:security\s+)?clearance)\b/i;
const CITIZEN_ONLY = /\b(?:(?:must|required\s+to|need\s+to)\s+be\s+(?:a\s+)?(?:u\.?\s?s\.?|united\s+states|american)\s+citizen(?!\s+or\b)(?!\s*(?:,|\/)\s*(?:or\s+)?(?:green\s+card|permanent|lawful|national))|(?:u\.?\s?s\.?|united\s+states)\s+citizenship\s+(?:is\s+)?(?:required|mandatory|a\s+requirement)|(?:open|available)\s+(?:only\s+)?to\s+(?:u\.?\s?s\.?|united\s+states)\s+citizens\s+only|(?:u\.?\s?s\.?|united\s+states)\s+citizens\s+only|only\s+(?:u\.?\s?s\.?|united\s+states)\s+citizens|requires?\s+(?:u\.?\s?s\.?|united\s+states)\s+citizenship)\b/i;
const CITIZEN_OR_PR = /\b(?:u\.?\s?s\.?|united\s+states)\s+citizens?\s*(?:,|\/|or)\s*(?:or\s+)?(?:(?:lawful\s+)?permanent\s+residents?|green\s+card\s+holders?|u\.?s\.?\s+nationals?)|\bu\.?s\.?\s+persons?\b/i;
const EEO = /\b(?:without\s+regard\s+to|regardless\s+of|discriminat\w*|protected\s+(?:veteran|class|characteristic)|equal\s+(?:employment\s+)?opportunity|e-?verify|i-9|form\s+i-9|export\s+control\s+laws?|itar|ear)\b/i;

function find(re: RegExp, text: string): { index: number; end: number } | null {
  const m = re.exec(text);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

function notEeo(text: string, hit: { index: number; end: number } | null): boolean {
  if (!hit) return false;
  const s = text.slice(Math.max(0, hit.index - 80), Math.min(text.length, hit.end + 40));
  return !/\bwithout\s+regard\s+to\b|\bregardless\s+of\b|\bdiscriminat/i.test(s);
}

/** Sponsorship, clearance and US-citizen-only statements in the posting text. null = the posting says nothing. */
export function parseStatements(input: string): StatementsResult {
  const text = cutOtherJobs(normalizeText(input ?? ''));
  const out: StatementsResult = { sponsorship: null, clearanceRequired: null, usCitizenOnly: null, evidence: {} };
  if (!text) return out;
  const no = find(SPONSOR_NO, text);
  const yes = find(SPONSOR_YES, text);
  if (no && notEeo(text, no)) {
    out.sponsorship = 'no';
    out.evidence.sponsorship = { source: 'description', text: snippet(text, no.index, no.end, 240) };
  } else if (yes && notEeo(text, yes) && !/\bnot\b|\bno\b|\bunable\b/i.test(text.slice(Math.max(0, yes.index - 20), yes.index))) {
    out.sponsorship = 'yes';
    out.evidence.sponsorship = { source: 'description', text: snippet(text, yes.index, yes.end, 240) };
  }
  const cr = find(CLEARANCE_REQ, text);
  const cn = find(CLEARANCE_NO, text);
  if (cn) { out.clearanceRequired = false; out.evidence.clearanceRequired = { source: 'description', text: snippet(text, cn.index, cn.end, 240) }; }
  else if (cr && !/\b(?:prefer(?:red)?|a\s+plus|nice\s+to\s+have|desired|bonus)\b/i.test(text.slice(cr.index, Math.min(text.length, cr.end + 30)))) {
    out.clearanceRequired = true; out.evidence.clearanceRequired = { source: 'description', text: snippet(text, cr.index, cr.end, 240) };
  }
  const co = find(CITIZEN_ONLY, text);
  const pr = find(CITIZEN_OR_PR, text);
  if (co && notEeo(text, co) && !(pr && Math.abs(pr.index - co.index) < 40)) {
    out.usCitizenOnly = true; out.evidence.usCitizenOnly = { source: 'description', text: snippet(text, co.index, co.end, 240) };
  } else if (pr && notEeo(text, pr) && !EEO.test(text.slice(Math.max(0, pr.index - 60), pr.index))) {
    out.usCitizenOnly = false; out.evidence.usCitizenOnly = { source: 'description', text: snippet(text, pr.index, pr.end, 240) };
  }
  return out;
}

/** Employment type from a board field or the posting's words. "Per diem" and "PRN" work are part-time-like: "other". */
export function parseEmploymentType(field: string | null | undefined, text = '', title = ''): { value: EmploymentType | null; evidence: FactEvidence | null } {
  const fromWords = (s: string): EmploymentType | null => {
    const c = s.toLowerCase();
    if (/\b(?:intern|internship|co-?op|stagiaire|praktikum|werkstudent)\b/.test(c)) return 'internship';
    if (/\b(?:per\s+diem|prn|pool)\b/.test(c)) return 'other';
    if (/\b(?:part[- ]?time|parttime|teilzeit|medio\s+tiempo|temps\s+partiel)\b/.test(c)) return 'part_time';
    if (/\b(?:temporary|temp|seasonal|fixed[- ]term|interim|locum)\b/.test(c)) return 'temporary';
    if (/\b(?:contract|contractor|freelance|1099|c2c|corp[- ]to[- ]corp|contract[- ]to[- ]hire)\b/.test(c)) return 'contract';
    if (/\b(?:full[- ]?time|fulltime|permanent|vollzeit|tiempo\s+completo|temps\s+plein|cdi|regular)\b/.test(c)) return 'full_time';
    return null;
  };
  if (field) {
    const k = field.toLowerCase().replace(/[^a-z]+/g, '');
    const map: Record<string, EmploymentType> = {
      fulltime: 'full_time', parttime: 'part_time', contract: 'contract', contractor: 'contract', temporary: 'temporary', temp: 'temporary',
      internship: 'internship', intern: 'internship', seasonal: 'temporary', perdiem: 'other', volunteer: 'other', other: 'other',
    };
    const v = map[k] ?? fromWords(field);
    if (v) return { value: v, evidence: { source: 'board_field', text: `Employment type: ${field}`.slice(0, 500) } };
  }
  const tv = fromWords(title);
  if (tv) return { value: tv, evidence: { source: 'title', text: title.slice(0, 500) } };
  const head = normalizeText(text).slice(0, 3000);
  const m = /\b(?:(?:employment|job|position)\s+type|schedule|status)\s*:\s*([^\n.;]{2,40})/i.exec(head)
    ?? /\bthis\s+is\s+an?\s+((?:full|part)[- ]time|temporary|seasonal|contract|per\s+diem|prn)\b/i.exec(head);
  if (m) { const v = fromWords(m[1]); if (v) return { value: v, evidence: { source: 'description', text: snippet(head, m.index, m.index + m[0].length) } }; }
  return { value: null, evidence: null };
}
