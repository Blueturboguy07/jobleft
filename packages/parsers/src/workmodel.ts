// Work model (onsite, hybrid, remote) and where a remote job is open (parsers O8, O9).
// "Remote patient monitoring" or "remote teams" never make a job remote. When the posting says two different
// things, the stricter reading wins (onsite over hybrid over remote), so the looser one is never shown as certain.
import type { FactEvidence, RemoteScope, WorkModel } from '@jobleft/contracts';
import { AU_STATE_CODES, CA_PROVINCE_CODES, COUNTRIES, MACRO_REGIONS } from './geo-world.ts';
import { US_STATES } from './geo-us.ts';
import { parseLocationText } from './places.ts';
import { clip, cutOtherJobs, keyOf, normalizeText, snippet } from './text.ts';

export interface WorkModelFields {
  /** The board's own field: "remote", "hybrid", "on-site", "OnSite", "TELECOMMUTE", "unspecified", ... */
  workplaceType?: string | null;
  /** A board flag that says the job is remote (Ashby isRemote also covers hybrid, so it is weak). */
  remote?: boolean | null;
  /** The location field(s). */
  location?: string | null;
  locations?: string[];
  title?: string | null;
}

export interface WorkModelResult {
  workModel: WorkModel | null;
  remoteScope: RemoteScope | null;
  evidence: { workModel?: FactEvidence; remoteScope?: FactEvidence };
}

interface Signal { model: WorkModel; source: FactEvidence['source']; text: string; strong: boolean }

const STRICT: Record<WorkModel, number> = { onsite: 3, hybrid: 2, remote: 1 };

/** Reads a board's workplace field. Unknown values give null. */
export function workModelFromField(v: string | null | undefined): WorkModel | null {
  if (!v) return null;
  const k = keyOf(v).replace(/\s+/g, '');
  if (['remote', 'telecommute', 'fullyremote', 'remoteonly', 'workfromhome', 'wfh', 'distributed', 'virtual'].includes(k)) return 'remote';
  if (['hybrid', 'hybridremote', 'flexible', 'partiallyremote', 'remotehybrid'].includes(k)) return 'hybrid';
  if (['onsite', 'office', 'inoffice', 'inperson', 'onpremise', 'onpremises', 'officebased', 'site', 'presencial'].includes(k)) return 'onsite';
  return null;
}

// Phrases in the posting text. Each is specific enough that "remote sensing" or "hybrid cloud" never matches.
type TextModel = WorkModel | 'notremote';

const TEXT_RULES: Array<{ re: RegExp; model: TextModel }> = [
  // Negations: "this is not a remote position" rules out remote, and fits onsite or hybrid.
  { re: /\b(?:this\s+is\s+)?not\s+(?:a\s+)?(?:fully\s+)?remote\s+(?:position|role|job|opportunity)\b|\b(?:no|not)\s+remote\s+(?:work|option|options|opportunit\w+)\b|\bremote\s+work\s+is\s+not\s+(?:available|possible|an\s+option|offered|permitted)\b|\bnot\s+eligible\s+for\s+remote\b|\bthis\s+(?:role|position|job)\s+(?:is\s+not|isn't|cannot\s+be)\s+(?:performed\s+)?remote(?:ly)?\b|\bno\s+remote\b/i, model: 'notremote' },
  { re: /\b(?:this|the)\s+(?:is\s+an?\s+)?(?:role|position|job|opportunity)\s+(?:is|will\s+be)\s+(?:a\s+)?(?:100%\s+|fully\s+|entirely\s+|completely\s+)?(?:on-?site|in[- ]office|in[- ]person|office[- ]based)\b|\bthis\s+is\s+an?\s+(?:full[- ]time,?\s+)?(?:on-?site|in[- ]office|in[- ]person|office[- ]based)\s+(?:role|position|job|opportunity)\b/i, model: 'onsite' },
  { re: /\b(?:100%|fully|full[- ]time|five\s+days|5\s+days)\s+(?:on-?site|in[- ]office|in[- ]person|in\s+the\s+office)\b|\bon-?site\s+(?:role|position|job|opportunity|five|5)\b|\b(?:5|five)\s+days\s+(?:a|per)\s+week\s+(?:in|at)\s+(?:the|our)\s+office\b/i, model: 'onsite' },
  { re: /\b(?:must|required\s+to|expected\s+to|need\s+to|will\s+need\s+to)\s+(?:work|be|report)\s+(?:on-?site|in[- ]person|in\s+(?:the|our)\s+office|onsite|in\s+office)\b/i, model: 'onsite' },
  { re: /\b(?:on-?site|in[- ]office|in[- ]person|in\s+the\s+office)\s+(?:at\s+least\s+|a\s+minimum\s+of\s+|about\s+|roughly\s+)?\d{1,2}\s*%\s+of\s+the\s+time\b/i, model: 'hybrid' },
  // Hybrid: a schedule of office days, or the word with a work noun.
  { re: /\bhybrid\s+(?:schedule|arrangement|setup|set-up|basis|remote|in-office|office|work(?:ing)?\s+(?:model|schedule|arrangement|pattern|mode|setup|policy|environment|structure|opportunity))\b|\bhybrid\s+work(?:ing)?\s*:|\b(?:a|an|this|is|as|our)\s+(?:full[- ]time,?\s+)?hybrid\s+(?:role|position|job|opportunity)\b(?!\s+(?:between|combining|that\s+combines|spanning|bridging|blending|mixing|across|of)\b)|\b(?:offers?\s+an?|on\s+an?|follows?\s+an?|we\s+(?:use|follow|operate|work)\s+(?:an?\s+)?)\s*hybrid\b(?!\s+(?:cloud|apps?|mobile|vehicles?|cars?|infrastructure|it\b|seeds?|search|approach|integration|events?|classroom|learning|teaching|instruction|environments?|solutions?|architecture|model\b(?!\s+of\s+work)|systems?|storage|network|deployments?|workloads?|data|engines?|powertrains?|electric|varieties|species|courses?|format|technolog\w+|methods?|strateg\w+|teams?\b))/i, model: 'hybrid' },
  { re: /\b(?:this|the)\s+(?:role|position|job|opportunity)\s+is\s+(?:a\s+)?hybrid\b(?!\s+(?:of|between)\b)|\bhybrid\s+(?:in|from|out\s+of|at)\s+(?:our\s+)?[A-Z]/, model: 'hybrid' },
  { re: /\b(?:\d|one|two|three|four)\s*(?:\+|or\s+more)?\s*(?:days?|x)\s*(?:a|per|each|\/|every)\s*week\s+(?:in|at|from|on)\s+(?:the\s+|our\s+)?(?:office|hq|headquarters|studio|campus|site|location|clinic|facility|lab)\b/i, model: 'hybrid' },
  { re: /\b(?:in[- ](?:the[- ])?office|on-?site|in[- ]person)\s+(?:at\s+least\s+|a\s+minimum\s+of\s+)?(?:\d|one|two|three|four)\s*(?:\+|or\s+more)?\s*(?:days?|x|times)\s*(?:a|per|each|\/)?\s*(?:week)?\b/i, model: 'hybrid' },
  { re: /\b(?:split|divided)\s+between\s+(?:home|remote)\s+and\s+(?:the\s+)?office\b|\bpartially\s+remote\b|\bflexible\s+hybrid\b|\bpartly\s+remote\b/i, model: 'hybrid' },
  // Remote: the job itself is remote.
  { re: /\b(?:this|the)\s+(?:is\s+(?:a|an)\s+)?(?:role|position|job|opportunity)\s+(?:is\s+)?(?:a\s+)?(?:100%\s+|fully\s+|completely\s+|entirely\s+|permanently\s+)?remote\b(?!\s+(?:patient|sensing|monitoring|support|access|desktop|control|site|locations?|areas?))/i, model: 'remote' },
  { re: /\b(?:100%|fully|completely|entirely|permanently)\s+remote\b(?!\s+(?:patient|sensing|monitoring|support|access|desktop|control|teams?|company|companies|program|programs|workforce|employees|culture|policy|staff|option|options|organization|org|environment|world))|\bremote[- ](?:only|position|role|job|opportunity|based\s+(?:role|position))\b/i, model: 'remote' },
  { re: /\b(?:can|will|may)\s+(?:be\s+)?(?:work(?:ed)?|performed|done|based)\s+(?:fully\s+|100%\s+)?remote(?:ly)?\s+(?:from\s+)?(?:anywhere|in|within|across)\b|\bwork\s+(?:fully\s+)?remotely\s+from\s+(?:anywhere|home|your\s+home)\b|\bwork\s+from\s+(?:home|anywhere)\s+(?:position|role|job|opportunity|full[- ]time)\b/i, model: 'remote' },
  { re: /\b(?:trabajo|posición|puesto)\s+(?:100%\s+)?remoto\b|\b100%\s+remoto\b|\b(?:100%\s+)?télétravail\s+(?:complet|total|à\s+100)|\bfull\s+remote\b|\b100%\s+(?:home\s*office|homeoffice)\b/i, model: 'remote' },
];

/** A part-week office schedule in the same sentence turns an "onsite" phrase into hybrid ("onsite ~2 days per week"). */
const PART_WEEK = /\b(?:[1-4]|one|two|three|four|~\s?[1-4])\s*(?:\+\s*)?(?:days?|x)\s*(?:a|per|each|\/|every)\s*week\b|\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?)\s*(?:-|–|to|through)\s*(?:tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?)\b|\b\d{1,2}\s*%\s+of\s+the\s+time\b|\bhalf\s+(?:of\s+)?the\s+(?:time|week)\b|\b(?:M|T|W|Th|F)\s*,\s*(?:M|T|W|Th|F)\s*,?\s*(?:and\s+)?(?:M|T|W|Th|F)\b/i;


// Area limits for a remote job.
const TZ_REGION: Array<[RegExp, string]> = [
  [/\b(?:est|edt|et|eastern|cst|cdt|ct|central|mst|mdt|mt|mountain|pst|pdt|pt|pacific|us|u\.s\.|north\s+american?)\b/i, 'NA'],
  [/\b(?:gmt|bst|cet|cest|eet|wet|eu|european|europe|uk|emea|central\s+european)\b/i, 'EU'],
  [/\b(?:ist|india|indian)\b/i, 'IN'],
  [/\b(?:aest|aedt|awst|australian|anz)\b/i, 'AU'],
  [/\b(?:apac|sgt|hkt|jst|asia)\b/i, 'APAC'],
  [/\b(?:brt|art|clt|cot|latam|latin\s+america)\b/i, 'LATAM'],
];
const LIMIT_RULES: RegExp[] = [
  /\b(?:must|need\s+to|required\s+to|should|will\s+need\s+to|are\s+required\s+to)\s+(?:be\s+)?(?:physically\s+)?(?:located|based|reside|residing|live|living|resident)\s+(?:in|within|inside)\s+(?:the\s+|one\s+of\s+the\s+)?([^.;\n]{2,200})/gi,
  /\b(?:open|available)\s+(?:only\s+)?to\s+(?:candidates|applicants|residents|people|individuals|those)\s+(?:who\s+(?:are|live)\s+)?(?:located|based|residing|living)?\s*(?:in|within|from)\s+(?:the\s+)?([^.;\n]{2,200})/gi,
  /\b(?:we\s+(?:can|are\s+able\s+to|currently)\s+(?:only\s+)?(?:hire|employ|consider\s+candidates)|we\s+are\s+(?:only\s+)?(?:able\s+to\s+)?hiring|hiring\s+(?:only\s+)?(?:in|from))\s+(?:in\s+|from\s+)?(?:the\s+following\s+(?:states|countries|locations)\s*:?\s*)?(?:the\s+)?([^.;\n]{2,200})/gi,
  /\bremote\s*(?:\(|-|–|,)?\s*(?:in|within|from|across)?\s*(?:the\s+)?((?:US|U\.S\.A?\.?|USA|United\s+States|Canada|UK|United\s+Kingdom|Europe|EU|EMEA|India|LATAM|APAC|Mexico|Brazil|Germany|Australia)\b[^.;\n]{0,40})/gi,
  /\b((?:US|U\.S\.|USA|Canada|UK|EU|EMEA|India|LATAM|APAC|Mexico|Brazil|Germany|Philippines|Australia)[- ]only)\b/gi,
  /\b(?:in|from)\s+(?:the\s+)?following\s+(?:states?|locations|countries)\s*:?\s*([^.\n]{2,300})/gi,
  /\b(?:within|inside)\s+(?:a\s+)?(\d{1,3}[- ]?(?:miles?|mi|km|kilometers?)\s+(?:radius\s+)?(?:of|from)\s+(?:our\s+|the\s+)?[A-Z][\w.' ]{2,40})/g,
  /\b(?:within\s+)?(?:commuting|driving|reasonable\s+commuting)\s+distance\s+(?:of|to|from)\s+(?:our\s+|the\s+)?([A-Z][\w.' ,]{2,60})/g,
  /\b(?:must|able\s+to|willing\s+to|need\s+to|should|required\s+to|expected\s+to)\s+(?:work|overlap|be\s+available|keep|maintain)[^.;\n]{0,40}?\b((?:EST|EDT|ET|Eastern|CST|CDT|CT|Central|MST|MDT|MT|Mountain|PST|PDT|PT|Pacific|GMT|BST|CET|CEST|EU|European|UK|IST|AEST|APAC|US|U\.S\.)(?:\s*(?:\/|or|and)\s*(?:EST|ET|Eastern|CST|CT|Central|MST|MT|Mountain|PST|PT|Pacific))*\s*(?:time\s*zones?|hours|business\s+hours|working\s+hours|time)?)/g,
];

const STATE_NAME_RE = new RegExp('\\b(' + Object.values(US_STATES).map((n) => n.replace(/\./g, '\\.')).join('|') + ')\\b', 'g');
const STATE_CODE_RE = /\b([A-Z]{2})\b/g;

/** The areas an area-limit phrase names: ISO countries, macro regions, and US states (as "US"). */
export function regionsOfArea(area: string): { regions: string[]; states: string[] } {
  const regions = new Set<string>();
  const states = new Set<string>();
  const a = area.replace(/\([^)]*\)/g, (m) => ' ' + m.slice(1, -1) + ' ');
  // States by name and by code.
  STATE_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATE_NAME_RE.exec(a)) !== null) {
    const code = Object.entries(US_STATES).find(([, n]) => n === m![1])?.[0];
    // "Georgia" in "Tbilisi, Georgia" is the country; the rest of the list decides.
    if (code) states.add(code);
  }
  STATE_CODE_RE.lastIndex = 0;
  const codes: string[] = [];
  while ((m = STATE_CODE_RE.exec(a)) !== null) codes.push(m[1]);
  const stateCodes = codes.filter((c) => US_STATES[c] && !['US', 'EU', 'UK'].includes(c));
  // A run of two or more state codes is a state list ("AZ, CO, FL, GA or TX"); a lone code is kept only next to "state".
  if (stateCodes.length >= 2 || (stateCodes.length === 1 && /\bstates?\b/i.test(a))) for (const c of stateCodes) states.add(c);
  if (states.size) regions.add('US');
  const k = ' ' + keyOf(a) + ' ';
  for (const [cc, names] of Object.entries(COUNTRIES)) {
    for (const n of names) {
      const nk = keyOf(n);
      if (nk.length < 2 || nk === 'georgia country') continue;
      if (nk.length <= 3 && !new RegExp(`(?:^|[^A-Za-z])${n.replace(/\./g, '\\.')}(?:[^A-Za-z]|$)`).test(a)) continue;
      if (k.includes(' ' + nk + ' ')) { regions.add(cc); break; }
    }
  }
  if (/\bgeorgia\b/i.test(a) && /\b(?:tbilisi|batumi|kutaisi|country)\b/i.test(a)) { regions.add('GE'); states.delete('GA'); if (!states.size) regions.delete('US'); }
  for (const [name, r] of Object.entries(MACRO_REGIONS)) {
    if (name.length <= 3) { if (new RegExp(`\\b${name}\\b`, 'i').test(a) && (name !== 'eu' || /\bEU\b/.test(a))) regions.add(r); continue; }
    if (k.includes(' ' + keyOf(name) + ' ')) regions.add(r);
  }
  if (/\b(?:US|U\.S\.A?\.?|USA)\b/.test(a)) regions.add('US');
  for (const c of codes) if (CA_PROVINCE_CODES[c] && /\bcanad/i.test(a)) regions.add('CA');
  for (const c of codes) if (AU_STATE_CODES[c] && /\baustral/i.test(a)) regions.add('AU');
  // Only a time zone named: map it to its area.
  if (!regions.size) for (const [re, r] of TZ_REGION) if (re.test(a)) { regions.add(r); break; }
  // "within 50 miles of Denver": the country of that place.
  if (!regions.size && /\b(?:miles?|mi|km|kilometers?|distance)\b/i.test(a)) {
    const place = a.replace(/^.*?\b(?:of|to|from)\s+(?:our\s+|the\s+)?/i, '');
    const ps = parseLocationText(place).places;
    for (const p of ps) if (p.country) regions.add(p.country);
  }
  return { regions: [...regions], states: [...states] };
}

/** "If you are near one of our offices, you'll be hybrid": a condition for some people, not the job's model. */
const CONDITIONAL = /\b(?:if\s+(?:you\s+(?:are|live|reside|'re)|you're|located|local|based)|for\s+(?:those|candidates|employees|people|team\s+members|members)\s+(?:who\s+(?:live|are|reside)|near|within|living|located|based|in)|(?:those|members|employees|candidates|people|anyone|staff|team\s+members)(?:\s+\w+){0,3}\s+(?:who|that)\s+(?:live|are\s+located|reside|are\s+based|are\s+within|are\s+near)|those\s+near|when\s+(?:near|local)|unless)\b/i;
/** "Providers may work a hybrid schedule": an option, not the job's model. */
const OPTIONAL = /\b(?:may|can|could|might|option(?:al|ally)?\s+to|choose\s+to|opportunity\s+to|flexibility\s+to|are\s+welcome\s+to)\s+(?:\w+\s+){0,3}$/i;

function sentenceAround(text: string, start: number, end: number): { lead: string; trail: string } {
  const sStart = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf('\n', start - 1), start - 200);
  let sEnd = text.length;
  for (const c of ['.', '\n']) { const i = text.indexOf(c, end); if (i >= 0 && i < sEnd) sEnd = i; }
  sEnd = Math.min(sEnd, end + 200);
  return { lead: text.slice(Math.max(0, sStart + 1), start), trail: text.slice(end, sEnd) };
}

function textSignals(text: string): Array<Signal | { model: 'notremote'; source: 'description'; text: string; strong: true }> {
  const out: Array<Signal | { model: 'notremote'; source: 'description'; text: string; strong: true }> = [];
  for (const { re, model } of TEXT_RULES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    let tries = 0;
    while ((m = g.exec(text)) !== null && tries++ < 20) {
      const { lead, trail } = sentenceAround(text, m.index, m.index + m[0].length);
      // "not remote-only", "remote-first, but not remote-only": a negated phrase says nothing.
      if (model === 'remote' && /\bnot\s+(?:a\s+|an\s+)?(?:fully\s+)?$/i.test(lead)) continue;
      if (CONDITIONAL.test(lead) || CONDITIONAL.test(trail) || OPTIONAL.test(lead)) continue;
      // "Whether you're coming in regularly or are part of our fully remote program": a company policy, not this job.
      if (/\bwhether\b/i.test(lead) || /\bour\s+(?:\w+\s+){0,2}$/i.test(lead) && model === 'remote') continue;
      let mm: TextModel = model;
      if (mm === 'onsite' && PART_WEEK.test(lead + m[0] + trail)) mm = 'hybrid';
      const sig = { source: 'description' as const, text: snippet(text, m.index, m.index + m[0].length, 220), strong: true as const };
      out.push(mm === 'notremote' ? { model: 'notremote', ...sig } : { model: mm, ...sig });
      break;
    }
  }
  return out;
}

const TITLE_RULE = /\((?:[^)]*\b)?(remote|hybrid|on-?site|in[- ]office)\b[^)]*\)|(?:^|[-–—|:,/]\s*)(remote|hybrid|on-?site)(?:\s*(?:[-–—|:,/(]|$)|\s+(?:in|within|us|usa|uk|canada|eu|emea|only|position|role|opportunity|option)\b)|^(remote|hybrid)\s+(?!patient|sensing|monitoring|support|access|desktop|control|pilot|operations?|care|monitor|device|systems?)/i;

function titleSignal(title: string | null | undefined): Signal | null {
  if (!title) return null;
  const m = TITLE_RULE.exec(title);
  if (!m) return null;
  const word = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
  const model = workModelFromField(word);
  return model ? { model, source: 'title', text: clip(title, 200), strong: true } : null;
}

/**
 * The work model and the remote area of a job. `text` is the posting text; `fields` are the board's fields.
 * Returns nulls when nothing supports a value (never "Onsite" by default).
 */
export function parseWorkModel(text: string, fields: WorkModelFields = {}): WorkModelResult {
  const body = cutOtherJobs(normalizeText(text ?? ''));
  const signals: Signal[] = [];
  const field = workModelFromField(fields.workplaceType ?? null);
  if (field) signals.push({ model: field, source: 'board_field', text: `Workplace type: ${fields.workplaceType}`, strong: true });
  const locTexts = [fields.location ?? '', ...(fields.locations ?? [])].filter(Boolean);
  const locRegions: string[] = [];
  let locRemoteText: string | null = null;
  for (const lt of locTexts) {
    const lp = parseLocationText(lt);
    for (const m of lp.workModels) signals.push({ model: m, source: 'location_text', text: clip(lt, 200), strong: true });
    for (const r of lp.remoteRegions) if (!locRegions.includes(r)) locRegions.push(r);
    if (lp.remoteText && !locRemoteText) locRemoteText = lp.remoteText;
  }
  const ts = titleSignal(fields.title);
  if (ts) signals.push(ts);
  const fromText = textSignals(body);
  // "Not a remote position" rules remote out: it is onsite unless another source says hybrid.
  const notRemote = fromText.find((x) => x.model === 'notremote');
  for (const x of fromText) if (x.model !== 'notremote') signals.push(x as Signal);
  if (notRemote) {
    const hybrid = signals.some((x) => x.model === 'hybrid');
    signals.push({ model: hybrid ? 'hybrid' : 'onsite', source: 'description', text: notRemote.text, strong: true });
  }
  if (!signals.length && fields.remote === true) signals.push({ model: 'remote', source: 'board_field', text: 'The board marks this job remote', strong: false });

  let workModel: WorkModel | null = null;
  let evidence: FactEvidence | undefined;
  if (signals.length) {
    // The strictest stated model wins: a board field that says Remote next to "3 days a week in the office" is hybrid.
    const strong = signals.filter((s) => s.strong);
    const pool = strong.length ? strong : signals;
    const best = [...pool].sort((a, b) => STRICT[b.model] - STRICT[a.model])[0];
    workModel = best.model;
    evidence = { source: best.source, text: best.text };
  }

  // Remote area: from the location text, then from limit phrases in the posting.
  let remoteScope: RemoteScope | null = null;
  let scopeEvidence: FactEvidence | undefined;
  const limitTexts: string[] = [];
  const regions = new Set<string>(locRegions);
  for (const re of LIMIT_RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const area = m[1] ?? '';
      // "authorized to work in the US" is work authorisation, not a place limit.
      const lead = body.slice(Math.max(0, m.index - 60), m.index);
      if (/\bauthori[sz]ed\s+to\s+work\b|\beligib\w*\s+to\s+work\b|\bsponsor/i.test(lead + m[0])) continue;
      const r = regionsOfArea(area);
      if (!r.regions.length) continue;
      for (const x of r.regions) regions.add(x);
      limitTexts.push(snippet(body, m.index, m.index + m[0].length, 220));
      if (limitTexts.length >= 3) break;
    }
  }
  if (workModel === 'remote' && (regions.size || locRemoteText || limitTexts.length)) {
    const words = [locRemoteText, ...limitTexts].filter(Boolean) as string[];
    remoteScope = { regions: [...regions], text: clip(words.join('; ') || 'Remote', 500) };
    scopeEvidence = { source: limitTexts.length ? 'description' : 'location_text', text: clip(words.join('; '), 500) };
  }
  const ev: WorkModelResult['evidence'] = {};
  if (evidence) ev.workModel = evidence;
  if (scopeEvidence && remoteScope) ev.remoteScope = scopeEvidence;
  return { workModel, remoteScope, evidence: ev };
}
