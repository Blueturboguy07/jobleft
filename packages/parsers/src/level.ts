// Seniority (parsers O5, O10): from what the posting asks for, not from one word in the title.
// The title gives a reading with a strength; stated years confirm it, refine it by one step, or overrule a grade
// ("Engineer III" asking for 0-2 years is entry level). "Senior Care Aide", "Staff Nurse", "Internal Audit" and
// "Shift Manager" never become Senior, Lead/Staff, Intern or Director by one word.
import { experienceLevelOf, type ExperienceLevel, type FactEvidence, type Level } from '@jobleft/contracts';
import { clip, cutOtherJobs, normalizeText, snippet } from './text.ts';

export const BUCKETS: readonly ExperienceLevel[] = ['intern_new_grad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec'];
const idx = (b: ExperienceLevel) => BUCKETS.indexOf(b);

type Strength = 'strong' | 'medium' | 'weak';
interface TitleReading { level: Level; strength: Strength; buckets?: ExperienceLevel[] }

// Words that make "senior" mean older people, not seniority.
const ELDER = /\bsenior\s+(?:care|living|center|centre|services?|housing|community|communities|citizens?|homes?|residences?|residents|apartments?|health|nutrition|companions?|caregivers?|day|daycare|adults?|meals|programs?|outreach|lifestyle|placement|advisor\s+for|high)\b|\bseniors\b|\bfor\s+seniors\b/i;
const TECH_NOUN = '(?:software|engineer|engineering|developer|data|machine|ml|ai|product|designer|design|scientist|research|researcher|architect|security|site\\s+reliability|sre|infrastructure|platform|backend|back-end|frontend|front-end|full[- ]?stack|mobile|ios|android|systems?|technical|program\\s+manager|tpm|ux|ui|analytics|analyst|devops|cloud|network|solutions|hardware|firmware|embedded|quantitative|applied|member\\s+of\\s+technical|infra|test|qa|quality|performance|compiler|graphics|robotics|computer\\s+vision|nlp)';
const STAFF_TECH = new RegExp(`\\bstaff\\s+(?:[\\w-]+\\s+){0,2}${TECH_NOUN}\\b|\\bsenior\\s+staff\\b|\\bprincipal\\s+staff\\b`, 'i');
const PRINCIPAL_TECH = new RegExp(`\\bprincipal\\s+(?:[\\w-]+\\s+){0,2}(?:${TECH_NOUN.slice(3, -1)}|consultant|associate|investigator|pm|account|manager|program|member|advisor|counsel|scientist|statistician|economist)\\b`, 'i');
const SCHOOL = /\b(?:school|schools|elementary|middle|high|academy|charter|k-?12|k-?8|campus|education|isd|usd|district|montessori|preschool|primary|secondary)\b/i;
const IC_MANAGER = /\b(?:product|project|program|programme|account|accounts|case|care|property|relationship|territory|community|social\s+media|content|brand|category|customer\s+success|success|technical\s+account|partner|partnerships?|partner\s+development|wealth|portfolio|asset|fund|key\s+account|client|client\s+success|client\s+services|campaign|marketing|product\s+marketing|growth|lifecycle|channel|events?|office|practice|release|scrum|delivery|implementation|onboarding|renewals?|solutions?|vendor|payroll|benefits|compensation|talent|recruiting|digital|e-?commerce|merchandising|inventory|demand|pricing|revenue|risk|compliance|policy|research|analytics|quality|privacy|incident|problem|service\s+delivery|training|curriculum|grants?|fundraising|donor|volunteer|sourcing|procurement|purchasing|contracts?|claims|billing|collections?|loan|mortgage|underwriting|investment|treasury|tax|audit|strategic\s+sourcing|vendor|bdr|sdr|global\s+mobility|workforce|wfm|clinical\s+research|study|trial|site|territory\s+sales|field\s+marketing|demand\s+generation|partner\s+marketing|developer\s+relations)\s+manager\b/i;
const SHIFT_LEAD = /\b(?:shift|crew|floor|keyholder|key\s+holder)\s+(?:lead|leader|supervisor|manager|captain)\b|\blead\s+(?:cashier|barista|crew|sales\s+associate|associate|server|host|bartender|cook|line\s+cook|dishwasher|housekeeper|room\s+attendant|banquet\s+server|teller)\b|\bkeyholder\b/i;
const OCCUPATION_ENTRY = /\b(?:cashier|barista|crew\s+member|team\s+member|sales\s+associate|store\s+associate|retail\s+associate|warehouse\s+(?:associate|worker|operative)|package\s+handler|material\s+handler|picker|packer|stocker|stock\s+(?:associate|clerk)|dishwasher|busser|bus\s+person|host(?:ess)?|server|food\s+runner|runner|line\s+cook|prep\s+cook|cook|dietary\s+aide|housekeeper|room\s+attendant|janitor|custodian|cleaner|caregiver|home\s+health\s+aide|personal\s+care\s+aide|care\s+aide|certified\s+nursing\s+assistant|cna|nursing\s+assistant|patient\s+care\s+(?:tech|technician|assistant)|medical\s+assistant|phlebotomist|pharmacy\s+technician|receptionist|front\s+desk\s+(?:agent|associate|clerk)|customer\s+service\s+(?:representative|rep|associate|agent)|call\s+center\s+(?:agent|representative)|delivery\s+driver|courier|driver\s+helper|security\s+(?:officer|guard)|laborer|general\s+labor|groundskeeper|landscaper|lifeguard|camp\s+counselor|tutor|teacher\s+aide|teaching\s+assistant|paraprofessional|para\s+educator|paraeducator|direct\s+support\s+professional|dsp|behavior\s+technician|rbt|bank\s+teller|teller|data\s+entry|clerk|mail\s+clerk|valet|bellman|bell\s+attendant|barback|car\s+wash|merchandiser|brand\s+ambassador|canvasser|usher|concierge|dishroom|crew|cookie\s+crew|bagger|greeter|sandwich\s+artist|delivery\s+(?:associate|courier)|shopper|order\s+picker|forklift\s+operator|machine\s+operator|production\s+(?:associate|worker|operator)|assembler|sorter|loader|unloader|mover|helper|attendant|scribe|medical\s+receptionist|scheduler|sales\s+development\s+representative|business\s+development\s+representative|sdr|bdr|patient\s+(?:access|services)\s+(?:representative|rep|associate|specialist))\b/i;

function t(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

/** The level a title states, with how much to trust it. Null when the title names none. */
export function readTitle(title: string): TitleReading | null {
  let s = t(normalizeText(title));
  if (!s) return null;
  // Words that look like levels but are not: "Internal", "International", "Internist" never match \bintern\b.
  const elder = ELDER.test(s);
  // Intern and trainee (never "Internship Coordinator").
  if (/\b(?:intern|interns|internship|internships|co-?op|apprentice|apprenticeship|trainee|traineeship|work[- ]study|student\s+(?:worker|assistant|employee|intern|associate)|summer\s+(?:associate|analyst|intern|analyst\s+program)|stagiaire|praktikant(?:in)?|praktikum|werkstudent(?:in)?|becari[oa]|pasant[ea]|pasantía|estagi[aá]ri[oa]|est[aá]gio|alternan(?:ce|t|te)|apprenti|azubi|ausbildung|インターン|인턴)\b/i.test(s)
    && !/\b(?:intern|internship|apprentice(?:ship)?|co-?op|trainee)\s+(?:program\s+)?(?:coordinator|manager|director|recruiter|lead|specialist|supervisor|advisor|mentor|instructor|trainer)\b/i.test(s)
    && !/\b(?:manager|director|coordinator|recruiter|supervisor)\s+(?:of|for),?\s+(?:the\s+)?(?:intern|internship|apprentice)/i.test(s)) {
    return { level: 'intern', strength: 'strong' };
  }
  if (/^stage\s*[-–:]|\bstage\s+(?:de|en|d')\b/i.test(s)) return { level: 'intern', strength: 'strong' };
  if (/\b(?:new\s+grad(?:uate)?s?|recent\s+grad(?:uate)?s?|university\s+grad(?:uate)?|graduate\s+(?:program|scheme|trainee|rotational|programme)|early\s+career|campus\s+hire|new-grad|(?:nurse|rn|pharmacy)\s+residency|residency\s+program|graduate\s+nurse|class\s+of\s+20\d\d|20\d\d\s+grad(?:uate)?s?|university\s+hire|college\s+hire)\b/i.test(s)
    || /^(?:graduate|grad)\b(?!\s+(?:student|assistant|research|teaching|admissions|school|studies|coordinator|advisor|program\s+manager))/i.test(s)
    || /\bgraduate\s+(?!student|assistant|research|teaching|admissions|school|studies|coordinator|advisor|program\s+manager|medical\s+education)[a-z]+(?:\s+[a-z]+)?\s+(?:executive|analyst|engineer|consultant|scientist|associate|developer)\b/i.test(s)) {
    return { level: 'intern', strength: 'strong', buckets: ['intern_new_grad', 'entry'] };
  }
  if (/\bresident\s+(?:physician|pharmacist|dentist|doctor)\b|\b(?:pgy|pgy-\d)\b/i.test(s)) return { level: 'intern', strength: 'strong' };
  // Executives.
  if (/\bchief\s+(?:[\w&-]+\s+){0,3}officer\b|\b(?:ceo|cfo|cto|coo|cmo|cio|ciso|chro)\b(?![-\w])|\b(?:co-?)?founder\b|\bmanaging\s+director\b|\bgeneral\s+counsel\b|\bexecutive\s+director\b|\bexecutive\s+vice\s+president\b|\bhead\s+of\s+school\b|\bsuperintendent\s+of\s+schools\b|\bpresident\b(?<!vice[ -]president)(?!\s+of\s+(?:the\s+)?(?:club|student|pta|chapter))/i.test(s)
    && !/\bvice[ -]president\b/i.test(s.replace(/\bexecutive\s+vice\s+president\b/i, ''))) {
    return { level: 'exec', strength: 'strong' };
  }
  if (/^(?:equity\s+|managing\s+|senior\s+|salaried\s+|income\s+|full\s+)?partner\b(?!\s+(?:[\w-]+\s+)?(?:manager|success|marketing|development|operations|engineer|sales|account|relations|program|solutions|enablement|support|specialist|associate|lead|director|experience|onboarding|integrations?|ecosystem|alliances?|care|advocate))/i.test(s)) {
    return { level: 'exec', strength: 'strong' };
  }
  // Vice presidents.
  if (/\b(?:vp|v\.p\.|vice[- ]president|svp|evp|avp|senior\s+vice\s+president|assistant\s+vice\s+president)\b/i.test(s)) return { level: 'vp', strength: 'strong' };
  // Directors and heads (occupational "Activities Director" or "Funeral Director" are not executives).
  if (/\b(?:activit(?:y|ies)|funeral|choir|music|camp|youth|athletic|children'?s|worship|dietary|food\s+service|nutrition|recreation|wellness|fitness|program|site|residential|admissions|enrollment|clinical\s+program|daycare|center|centre|store|shop|branch|salon|spa|kitchen|catering|tour|cruise|casting|creative|art|design|account|client|agency|technical\s+program)\s+director\b/i.test(s) && !/\b(?:senior|executive|regional|global|group|national)\b/i.test(s)) {
    return { level: 'manager', strength: 'medium' };
  }
  if (/\b(?:director|directeur|directrice|diretor|diretora|direktor|leiter\s+(?:der|des)|head\s+of|chief\s+of\s+staff)\b/i.test(s)) return { level: 'director', strength: 'strong' };
  if (/\bgeneral\s+manager\b/i.test(s)) {
    if (/\b(?:senior|group|regional|division|business\s+unit|country|apac|emea|americas|north\s+america|global|worldwide|product\s+line|vp)\b/i.test(s)) return { level: 'director', strength: 'strong' };
    return { level: 'manager', strength: 'strong' };
  }
  // School principals (never "Principal Engineer").
  if (/\bprincipal\b/i.test(s) && !PRINCIPAL_TECH.test(s)) {
    if (/\b(?:assistant|vice|associate|deputy)\s+principal\b/i.test(s)) return { level: 'manager', strength: 'strong' };
    if (SCHOOL.test(s) || /^principal\s*$/i.test(s)) return { level: 'director', strength: 'strong' };
    if (/^principal\s*[,\-–:]/i.test(s)) return { level: 'principal', strength: 'medium' };
  }
  if (/\b(?:distinguished|technical\s+fellow|senior\s+principal)\b/i.test(s) || PRINCIPAL_TECH.test(s) || /^principal\b/i.test(s)) {
    if (PRINCIPAL_TECH.test(s) || /\b(?:distinguished|fellow)\b/i.test(s)) return { level: 'principal', strength: 'medium' };
  }
  if (/\b(?:post-?doc(?:toral)?|postdoctoral)\b/i.test(s) || /\b(?:research|clinical|teaching|graduate)\s+fellow\b/i.test(s)) return { level: 'entry', strength: 'medium' };
  // Staff (tech sense only; "Staff Nurse", "Staff Accountant" are not a level).
  if (STAFF_TECH.test(s) && !/\bmember\s+of\s+(?:the\s+)?technical\s+staff\b/i.test(s)) return { level: 'staff', strength: 'medium' };
  // Shift-level leads at stores and restaurants: first-line roles, not Lead/Staff or Director.
  if (SHIFT_LEAD.test(s)) return { level: 'entry', strength: 'medium', buckets: ['entry', 'mid'] };
  // People managers, supervisors and leads.
  if (/\b(?:assistant|asst\.?|associate)\s+(?:store\s+|restaurant\s+|general\s+|branch\s+|office\s+|department\s+|shift\s+)?(?:manager|mgr)\b/i.test(s)) return { level: 'mid', strength: 'medium', buckets: ['mid', 'lead_staff'] };
  const senior = !elder && /\b(?:senior|sr\.?|snr|s[eê]nior|senior-level)(?![\w-])/i.test(s.replace(/\bsenior\s+(?:high|living|care)\b/gi, ''));
  if (/\b(?:manager|mgr|gerente|gestionnaire|responsable|jefe|jefa)\b/i.test(s)) {
    if (/\b(?:engineering|people|team|store|restaurant|branch|plant|warehouse|nurse|nursing|unit|department|operations|ops|general|district|area|regional|facility|facilities|site|shift\s+operations|practice|clinic|center|centre|production|manufacturing|maintenance|construction|kitchen|hotel|front\s+office|service|services\s+operations|call\s+center|contact\s+center|customer\s+service|security|finance|accounting|hr|human\s+resources|it|software|development|design|data|analytics|sales|support|success)\s+manager\b|\bmanager,?\s+(?:of\s+)?(?:engineering|software|people|operations|team|sales|support|customer|finance|accounting|design|data|analytics|product\s+(?:management|design)|marketing|hr|it|security|services|wfm|cx)/i.test(s)
      && !IC_MANAGER.test(s)) return { level: 'manager', strength: 'strong' };
    if (IC_MANAGER.test(s)) {
      if (/\b(?:group|principal|director)\b/i.test(s)) return { level: 'staff', strength: 'medium' };
      return { level: senior ? 'senior' : 'mid', strength: 'medium', buckets: senior ? ['senior'] : ['mid', 'senior'] };
    }
    return { level: 'manager', strength: 'medium' };
  }
  if (/\b(?:supervisor|supervisora|foreman|forewoman|foreperson|charge\s+nurse|crew\s+chief|superintendent|head\s+(?:chef|coach|cook|cashier|teller|lifeguard|custodian|baker|bartender|nurse|of\s+department)|executive\s+chef|chef\s+de\s+cuisine|sous\s+chef|encargad[oa]|coordenador(?:a)?|capataz|team\s+leader|teamleiter|líder|lider)\b/i.test(s)) {
    return { level: 'lead', strength: /\bsous\s+chef\b/i.test(s) ? 'medium' : 'strong' };
  }
  if (/\b(?:lead|leader)\b(?!\s+(?:generation|gen|abatement|paint|based|safe|safety\s+inspector|hazard|poisoning|qualification|development\s+representative|nurturing|scoring|routing|management\s+specialist))/i.test(s) && !/\blead\s+(?:generation|gen)\b/i.test(s)) {
    if (/\b(?:lead|leader)\s+(?:teacher|educator|instructor|caregiver|technician|tech|mechanic|carpenter|electrician|plumber|welder|operator|driver|installer|painter|groundskeeper|custodian|janitor|guard|officer|clerk|agent|representative|rep|specialist|coordinator)\b/i.test(s) && !senior) {
      return { level: 'lead', strength: 'medium', buckets: ['mid', 'lead_staff'] };
    }
    return { level: 'lead', strength: 'medium' };
  }
  // Senior (never "Senior Care Aide" or "Senior Living Cook").
  if (senior) return { level: 'senior', strength: 'medium' };
  if (/\b(?:semi[- ]?senior|ssr|pleno|mid[- ]?level|mid[- ]senior|intermediate|journeyman|journeyperson|experienced)\b/i.test(s)) return { level: 'mid', strength: 'medium' };
  if (/\bmaster\s+(?:electrician|plumber|carpenter|technician|mechanic|welder|barber|stylist)\b/i.test(s)) return { level: 'senior', strength: 'medium' };
  if (/\b(?:junior|jr\.?|j[uú]nior|entry[- ]level|entry)\b(?![\w-])/i.test(s)) return { level: 'entry', strength: 'medium' };
  // Grades: "Nurse II", "Engineer III", "Analyst IV", "Level 2", "L4", "IC3".
  const roman = /(?:\s|-|,|^)(I{1,3}|IV|V)(?:\s*(?:$|[-–,(/|])|\s+(?:-|–))/.exec(s);
  if (roman && !/\b(?:world\s+war|type|phase|class|tier|stage|grade|part|chapter|title)\s+(?:I{1,3}|IV|V)\b/i.test(s) && !/\bI\s+(?:am|will|want|have)\b/.test(s)) {
    const g = roman[1];
    const lv: Level = g === 'I' ? 'entry' : g === 'II' ? 'mid' : g === 'III' ? 'senior' : g === 'IV' ? 'senior' : 'staff';
    return { level: lv, strength: 'medium' };
  }
  const lvl = /\b(?:level|lvl|grade)\s*([1-5])\b/i.exec(s);
  if (lvl) {
    const n = Number(lvl[1]);
    return { level: n === 1 ? 'entry' : n === 2 ? 'mid' : n === 3 ? 'senior' : n === 4 ? 'senior' : 'staff', strength: 'weak' };
  }
  const ladder = /\b(?:L|IC|E|P|T|SWE)\s?-?([1-8])\b/.exec(s);
  if (ladder && /\b(?:engineer|developer|scientist|designer|analyst|manager|swe)\b/i.test(s)) {
    const n = Number(ladder[1]);
    const lv: Level = n <= 2 ? 'entry' : n === 3 ? 'entry' : n === 4 ? 'mid' : n === 5 ? 'senior' : n === 6 ? 'staff' : 'principal';
    return { level: lv, strength: 'weak' };
  }
  if (/\b(?:associate|assistant|coordinator|asistente|auxiliar|assistente|ayudante)\b/i.test(s) && !/\bassociate\s+(?:professor|dean|partner|general\s+counsel|attorney|dentist|veterinarian|physician)\b/i.test(s)) {
    return { level: 'entry', strength: 'weak' };
  }
  if (OCCUPATION_ENTRY.test(s) && !/\b(?:driver\s+trainer|cdl|class\s+a)\b/i.test(s)) return { level: 'entry', strength: 'weak' };
  return null;
}

/** Fine-grained level from a title alone (the spike API). Occupation defaults are not applied here. */
export function levelFromTitle(title: string): Level | null {
  const r = readTitle(title);
  if (!r) return null;
  if (r.strength === 'weak' && OCCUPATION_ENTRY.test(title) && !/\b(?:associate|assistant|coordinator)\b/i.test(title)) return null;
  return r.level;
}

/** Buckets for a number of years ("3+ years" is Mid Level). */
export function bucketsForYears(min: number, max: number | null = null): ExperienceLevel[] {
  if (min <= 0) return ['entry'];
  if (min === 1) return max !== null && max >= 3 ? ['entry', 'mid'] : ['entry'];
  if (min === 2) return ['entry', 'mid'];
  if (min <= 4) return max !== null && max >= 6 ? ['mid', 'senior'] : ['mid'];
  if (min <= 9) return ['senior'];
  return ['senior', 'lead_staff'];
}

/** The filter buckets for a level and required years. Years refine the level by one step, or overrule a grade. */
export function levelsOf(level: Level | null, years: { min: number | null; max: number | null } | null): ExperienceLevel[] {
  const yb = years && years.min !== null ? bucketsForYears(years.min, years.max) : [];
  if (!level) return yb;
  const lb = experienceLevelOf(level);
  if (!yb.length) return [lb];
  const d = Math.min(...yb.map((b) => Math.abs(idx(b) - idx(lb))));
  if (d === 0) return [lb];
  if (d === 1) return sortBuckets([lb, ...yb.filter((b) => Math.abs(idx(b) - idx(lb)) <= 1)]);
  return yb;
}

function sortBuckets(bs: ExperienceLevel[]): ExperienceLevel[] {
  return [...new Set(bs)].sort((a, b) => idx(a) - idx(b));
}

function levelOfBucket(b: ExperienceLevel): Level {
  switch (b) {
    case 'intern_new_grad': return 'intern';
    case 'entry': return 'entry';
    case 'mid': return 'mid';
    case 'senior': return 'senior';
    case 'lead_staff': return 'lead';
    case 'director_exec': return 'director';
  }
}

const NEW_GRAD_TEXT = /\b(?:new\s+grad(?:uate)?s?\s+(?:are\s+)?(?:welcome|encouraged|considered)|recent\s+(?:college\s+|university\s+)?grad(?:uate)?s?\s+(?:are\s+)?(?:welcome|encouraged)|(?:open\s+to|welcome|ideal\s+for)\s+(?:new|recent)\s+grad(?:uate)?s?|graduating\s+(?:in|by)\s+(?:20\d\d|spring|summer|fall|winter|december|may|june)|new\s+graduate\s+(?:nurses?|rns?)\s+(?:are\s+)?welcome)\b/i;
const NO_EXP_TEXT = /\b(?:no\s+(?:prior\s+|previous\s+|professional\s+|work\s+)?experience\s+(?:is\s+)?(?:required|necessary|needed)|(?:we\s+will|we'll|will)\s+train(?:\s+you)?\b|(?:paid\s+)?training\s+(?:is\s+)?provided|entry[- ]level\s+(?:position|role|opportunity|job)|this\s+is\s+an\s+entry[- ]level|willing\s+to\s+train|experience\s+(?:is\s+)?not\s+(?:required|necessary)|sin\s+experiencia|no\s+se\s+requiere\s+experiencia)\b/i;
const NOT_ENTRY = /\bnot\s+(?:an?\s+)?(?:entry[- ]level|new\s+grad)/i;

export interface LevelInput {
  title: string;
  text?: string | null;
  years?: { min: number | null; max: number | null } | null;
  /** A board's own seniority field (Recruitee experience_code, Personio seniority, ...). */
  boardSeniority?: string | null;
  employmentType?: string | null;
}

export interface LevelResult {
  level: Level | null;
  levels: ExperienceLevel[];
  evidence: FactEvidence | null;
}

/** Reads a board's seniority field. */
export function bucketsFromBoardSeniority(v: string | null | undefined): ExperienceLevel[] {
  if (!v) return [];
  const k = v.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (/\b(?:student|intern|internship|trainee|graduate|new grad|apprentice)\b/.test(k)) return ['intern_new_grad'];
  if (/\b(?:entry|junior|beginner|associate)\b/.test(k)) return ['entry'];
  if (/\b(?:mid|intermediate)\b/.test(k)) return ['mid'];
  if (/\b(?:experienced|senior|expert|advanced)\b/.test(k)) return ['senior'];
  if (/\b(?:manager|lead|supervisor)\b/.test(k)) return ['lead_staff'];
  if (/\b(?:executive|director|head|vp|c level)\b/.test(k)) return ['director_exec'];
  return [];
}

/** Seniority from the title, the posting text, the stated years and any board field. */
export function parseLevel(input: LevelInput): LevelResult {
  const title = t(normalizeText(input.title ?? ''));
  const text = cutOtherJobs(normalizeText(input.text ?? ''));
  const years = input.years && input.years.min !== null ? input.years : null;
  const reading = title ? readTitle(title) : null;
  const titleEv: FactEvidence = { source: 'title', text: clip(title, 300) };
  const board = bucketsFromBoardSeniority(input.boardSeniority);
  const internType = input.employmentType === 'internship';

  // Text cues, used when the title and years say little.
  const head = text.slice(0, 20000);
  const newGrad = NEW_GRAD_TEXT.exec(head);
  const noExp = NOT_ENTRY.test(head) ? null : NO_EXP_TEXT.exec(head);
  const yearsBuckets = years ? bucketsForYears(years.min!, years.max) : [];
  const yearsEv: FactEvidence | null = years ? { source: 'description', text: 'Asks for ' + (years.max !== null && years.max !== years.min ? `${years.min}-${years.max}` : `${years.min}+`) + ' years of experience' } : null;

  if (reading && reading.strength === 'strong') {
    const b = reading.buckets ?? [experienceLevelOf(reading.level)];
    return { level: reading.level, levels: sortBuckets(b), evidence: titleEv };
  }
  if (board.length && (!reading || reading.strength !== 'medium')) {
    return { level: levelOfBucket(board[0]), levels: board, evidence: { source: 'board_field', text: `Seniority: ${input.boardSeniority}` } };
  }
  if (internType && !reading) return { level: 'intern', levels: ['intern_new_grad'], evidence: { source: 'board_field', text: 'Employment type: internship' } };
  if (reading && reading.strength === 'medium') {
    const tb = reading.buckets ?? [experienceLevelOf(reading.level)];
    if (yearsBuckets.length) {
      const d = Math.min(...tb.flatMap((a) => yearsBuckets.map((b) => Math.abs(idx(a) - idx(b)))));
      if (d === 0) {
        const both = tb.filter((a) => yearsBuckets.includes(a));
        return { level: reading.level, levels: sortBuckets(both.length ? both : tb), evidence: titleEv };
      }
      if (d === 1) {
        const near = yearsBuckets.filter((b) => tb.some((a) => Math.abs(idx(a) - idx(b)) <= 1));
        const mainTitle = tb.reduce((p, c) => (Math.abs(idx(c) - idx(near[0])) < Math.abs(idx(p) - idx(near[0])) ? c : p));
        return { level: reading.level, levels: sortBuckets([mainTitle, ...near]), evidence: titleEv };
      }
      // Two or more steps apart: the stated years decide ("Staff Engineer, 0-3 years" is entry level).
      return { level: levelOfBucket(yearsBuckets[0]), levels: yearsBuckets, evidence: yearsEv };
    }
    if (newGrad && idx(tb[0]) <= idx('entry')) return { level: reading.level, levels: sortBuckets(['intern_new_grad', 'entry']), evidence: titleEv };
    return { level: reading.level, levels: sortBuckets(tb), evidence: titleEv };
  }
  // Weak title words ("Associate", "Assistant", "Cashier") and no title word at all: years decide first.
  if (yearsBuckets.length) {
    const lv = reading && yearsBuckets.includes(experienceLevelOf(reading.level)) ? reading.level : levelOfBucket(yearsBuckets[0]);
    return { level: lv, levels: yearsBuckets, evidence: yearsEv };
  }
  if (newGrad) return { level: 'entry', levels: ['intern_new_grad', 'entry'], evidence: { source: 'description', text: snippet(head, newGrad.index, newGrad.index + newGrad[0].length) } };
  if (noExp) return { level: 'entry', levels: ['entry'], evidence: { source: 'description', text: snippet(head, noExp.index, noExp.index + noExp[0].length) } };
  if (reading) return { level: reading.level, levels: sortBuckets(reading.buckets ?? [experienceLevelOf(reading.level)]), evidence: titleEv };
  return { level: null, levels: [], evidence: null };
}

/** "5+ years of experience" gives a rough level. Weak signal, used only when the title says nothing (spike API). */
export function levelFromDescription(desc: string): Level | null {
  const m = /\b(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?)\b[^.\n]{0,40}\bexperience/i.exec(desc ?? '');
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y <= 1) return 'entry';
  if (y <= 4) return 'mid';
  return 'senior';
}
