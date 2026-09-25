// What a job title says about a person: a recruiting role, a seniority level and a field of work.
// Every finding keeps the words that show it, so each ranking reason can quote the title.
// Traps handled: "Senior Recruiting Coordinator" is a senior recruiter, not an executive; "Executive Assistant",
// "Account Executive" and "Executive Recruiter" are not executives; "Assistant to the CEO" is not a CEO; "Chief of
// Staff" is not a C-level officer; "Talent Partner" and "HR Business Partner" are not firm partners; "Lead
// Generation" is not a lead role; "Strategic Sourcing Manager" is procurement, not recruiting.

import { fold } from './text.ts';

export type Seniority = 'intern' | 'junior' | 'senior' | 'lead' | 'manager' | 'director' | 'vp' | 'exec' | 'founder';

export type Field =
  | 'engineering' | 'data' | 'product' | 'design' | 'marketing' | 'sales' | 'customer' | 'finance' | 'people'
  | 'recruiting' | 'operations' | 'legal' | 'research' | 'healthcare' | 'education' | 'security' | 'it';

export const FIELD_LABELS: Record<Field, string> = {
  engineering: 'engineering', data: 'data and analytics', product: 'product management', design: 'design',
  marketing: 'marketing', sales: 'sales', customer: 'customer success and support', finance: 'finance and accounting',
  people: 'HR and people', recruiting: 'recruiting', operations: 'operations', legal: 'legal', research: 'research',
  healthcare: 'healthcare', education: 'education', security: 'security', it: 'IT',
};

export const SENIORITY_ORDER: Record<Seniority, number> = {
  intern: 0, junior: 1, senior: 3, lead: 4, manager: 5, director: 6, vp: 7, exec: 8, founder: 8,
};

export interface TitleFacts {
  /** The words that show a recruiting role, or null. */
  recruiter: string | null;
  seniority: Seniority | null;
  /** The words that show the seniority. */
  seniorityWords: string | null;
  fields: Map<Field, string>;
}

/** Title text for matching: lower case, accents removed, separators as spaces, padded with spaces. */
function norm(title: string): string {
  let s = fold(title);
  s = s.replace(/[‐-―]/g, '-');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[|/,;:()[\]{}"'!?·•@.]+/g, ' ');
  s = s.replace(/\s-\s/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return ` ${s} `;
}

function find(s: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(s);
    if (m) return m[0].trim();
  }
  return null;
}

// ---------------------------------------------------------------- recruiting

const RECRUITER = [
  / (?:senior |sr |lead |principal |staff )?(?:technical |tech |university |campus |executive |corporate |global |talent )?recruit(?:er|ers|ing|ment)(?: [a-z]+)?/,
  / talent acquisition(?: [a-z]+)?/,
  / talent (?:partner|sourcer|lead|scout|advisor|business partner|team)/,
  / head of talent /,
  / (?:technical |talent )?sourcer /,
  / talent sourcing /,
];

// ---------------------------------------------------------------- seniority

/** Phrases that mention a senior role but belong to someone else, or are not a seniority at all. */
const NOT_SENIORITY = [
  / (?:executive |personal |administrative |office )?(?:assistant|coordinator|advisor|adviser|aide|associate)(?: to| for) (?:the )?[a-z ]+/,
  / office of the [a-z]+/,
  / chief of staff(?: to [a-z ]+)?/,
  / executive (?:assistant|coordinator|administrator|admin|recruiter|recruiting|search|chef|producer|editor|protection|support|briefing|business partner|communications)/,
  / account executive/,
  / (?:sales|business development|client) executive/,
  / lead (?:generation|gen|qualification|nurturing|management specialist)/,
  / (?:talent|people|hr|human resources|business|channel|alliance|alliances|solutions|strategic|account|partner|sales|customer|success|implementation|integration|technology|learning|brand|creative|finance|marketing|product|growth|community|agency|client|university|campus|ecosystem) partners?(?: [a-z]+)?/,
  / partner (?:manager|management|success|marketing|engineer|operations|development|programs|enablement|sales|lead|director)/,
  / (?:product|process|service|content|platform|feature|technical|data|system|application|budget|risk) owner/,
];

const SENIORITY_PATTERNS: Array<[Seniority, RegExp[]]> = [
  ['intern', [/ (?:intern|internship|co-op|coop|summer analyst|summer associate|working student|student) /]],
  ['founder', [/ (?:co-? ?founder|cofounder|founder|founding partner|owner) /]],
  ['exec', [
    / (?:ceo|cto|cfo|coo|cmo|cpo|cio|ciso|cro|chro|cdo|cso|cco|cao|clo|cbo) /,
    / chief [a-z ]*officer /,
    / chief (?:executive|technology|financial|operating|marketing|product|information|revenue|people|data|security|legal|business|strategy|commercial|medical|nursing|scientific|design|growth|customer|digital|compliance|risk|investment|creative)\b/,
    / (?:managing|general|senior|equity) partner /,
    /^ partner /,
    / (?<!vice )(?<!-)president /,
  ]],
  ['vp', [/ (?:senior |executive |group )?(?:vice president|vice-president|vp|svp|evp|gvp|avp) /]],
  ['director', [/ (?:senior |associate |assistant |group |executive |managing )?director /, / head of [a-z]+/, /^ head /]],
  ['manager', [/ (?:senior |sr )?(?:manager|mgr) /]],
  ['lead', [/ (?:principal|distinguished|lead|tech lead|team lead) /, / staff (?:[a-z]+ ){0,2}(?:engineer|developer|scientist|designer|researcher|architect|product manager|swe|sre|analyst)s? /]],
  ['senior', [/ (?:senior|sr|snr|iii|iv) /]],
  ['junior', [/ (?:junior|jr|entry level|entry-level|graduate|new grad|trainee|apprentice) /]],
];

// ---------------------------------------------------------------- fields

const FIELD_PATTERNS: Array<[Field, RegExp[]]> = [
  ['recruiting', RECRUITER],
  ['security', [/ (?:security|infosec|cybersecurity|cyber security|appsec|penetration|soc analyst)/]],
  ['data', [/ (?:data|analytics|machine learning|ml|ai|artificial intelligence|statistic[a-z]*|business intelligence|bi|quantitative|quant|deep learning|nlp)\b/]],
  ['engineering', [
    / (?:software|swe|sde|developer|programmer|devops|sre|site reliability|backend|back-end|back end|frontend|front-end|front end|full[- ]?stack|fullstack|firmware|embedded|qa|quality assurance|test automation|sdet)\b/,
    / (?<!sales |solutions |pre-?sales |support |field |customer |success |implementation |deployment |forward deployed )engineer(?:s|ing)? /,
    / (?:technical|tech) lead /, / architect /, / cto /,
  ]],
  ['product', [/ product (?:manager|management|owner|lead|director|head|vp)| (?:head|director|vp|vice president) of product(?! design| marketing)| apm | cpo /]],
  ['design', [/ (?:designer|design|ux|ui|user experience|user research|researcher ux|creative director|illustrator|art director)\b/]],
  ['marketing', [/ (?:marketing|growth|content|seo|sem|brand|communications|comms|public relations|pr|social media|demand gen[a-z]*|copywriter|community manager|cmo)\b/]],
  ['sales', [/ (?:sales|account executive|account manager|business development|bdr|sdr|partnerships|solutions engineer|sales engineer|pre-?sales|solutions consultant)\b/]],
  ['customer', [/ (?:customer success|customer support|support|customer experience|client services|customer service|implementation|onboarding specialist|technical account manager)\b/]],
  ['finance', [/ (?:finance|financial|accountant|accounting|controller|fp and a|treasury|tax|audit|auditor|investment|investor relations|actuary|cfo|bookkeeper|payroll)\b/]],
  ['people', [/ (?:human resources|hr|people operations|people partner|people ops|hrbp|people and culture|compensation|benefits|learning and development|l and d|chro|people team)\b/]],
  ['operations', [/ (?:operations|ops|logistics|supply chain|procurement|strategic sourcing|sourcing manager|purchasing|program manager|project manager|business operations|coo|facilities)\b/]],
  ['legal', [/ (?:legal|counsel|attorney|lawyer|paralegal|compliance|clo)\b/]],
  ['research', [/ (?:research scientist|researcher|research engineer|scientist|postdoc|phd)\b/]],
  ['healthcare', [/ (?:nurse|rn|physician|doctor|clinical|clinician|medical|pharmacist|therapist|dentist|surgeon|healthcare|patient)\b/]],
  ['education', [/ (?:teacher|professor|lecturer|instructor|tutor|educator|faculty|curriculum)\b/]],
  ['it', [/ (?:it support|it manager|help desk|helpdesk|system administrator|sysadmin|network administrator|it specialist|desktop support)\b/]],
];

/** Reads a title. Pure and deterministic. */
export function readTitle(title: string | null | undefined): TitleFacts {
  const facts: TitleFacts = { recruiter: null, seniority: null, seniorityWords: null, fields: new Map() };
  if (!title || !title.trim()) return facts;
  const s = norm(title);
  facts.recruiter = find(s, RECRUITER);

  let rest = s;
  for (const p of NOT_SENIORITY) rest = rest.replace(new RegExp(p.source, 'g'), ' ');
  rest = ` ${rest.replace(/\s+/g, ' ').trim()} `;
  // An assistant vice president is a senior staff title in banks, not a VP.
  rest = rest.replace(/ (?:avp|assistant vice president) /g, ' senior ');
  // "Chief of Staff" is a senior staff role, not an officer.
  const chiefOfStaff = / chief of staff /.test(s);
  for (const [level, patterns] of SENIORITY_PATTERNS) {
    const hit = find(rest, patterns);
    if (hit) { facts.seniority = level; facts.seniorityWords = hit; break; }
  }
  if (!facts.seniority && chiefOfStaff) { facts.seniority = 'lead'; facts.seniorityWords = 'chief of staff'; }
  // "Senior Recruiting Coordinator", "Senior Executive Assistant": the removed phrase must not hide "senior".
  if (!facts.seniority) {
    const hit = find(s, SENIORITY_PATTERNS.find(([l]) => l === 'senior')![1]);
    if (hit) { facts.seniority = 'senior'; facts.seniorityWords = hit; }
  }

  for (const [field, patterns] of FIELD_PATTERNS) {
    const hit = find(s, patterns);
    if (hit) facts.fields.set(field, hit);
  }
  // A recruiter's title names the field they hire for only through words like "Technical"; the role is recruiting.
  if (facts.recruiter) {
    for (const f of [...facts.fields.keys()]) if (f !== 'recruiting') facts.fields.delete(f);
  }
  return facts;
}

/** Fields shared by two titles (for "same field as the job"). Recruiting is not a shared field for this purpose. */
export function sharedFields(a: TitleFacts, b: TitleFacts): Field[] {
  const out: Field[] = [];
  for (const f of a.fields.keys()) if (f !== 'recruiting' && b.fields.has(f)) out.push(f);
  return out;
}
