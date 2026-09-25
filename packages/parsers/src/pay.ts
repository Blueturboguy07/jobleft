// Pay: from the board's own pay field, or from the posting text. Conservative on purpose: a wrong figure is worse
// than a missing one (parsers O2, O3, O4). Never an estimate, never a default, never another job's pay.
import type { FactEvidence, Pay, PayPeriod } from '@jobleft/contracts';
import { COUNTRY_CURRENCY, CURRENCY_SCALE, CUR_PRE, CUR_SUF, currencyOfMarker } from './currency.ts';
import { clauseEnd, clauseStart, cutOtherJobs, normalizeText, snippet } from './text.ts';

/** The pay the old spike API returned. Kept for callers of `parsePayFromText`. */
export interface ParsedPay {
  min: number | null;
  max: number | null;
  currency: string;
  period: PayPeriod;
}

export interface PayParseOptions {
  /** ISO alpha-2 country of the job (first place). Names a bare "$" (CAD in Canada) or a figure with no marker. */
  country?: string | null;
  /** The job title, for internships whose stipend is the pay. */
  title?: string;
  /** Words that name the job's place (city, region). The tier that names one of them is shown when tiers differ. */
  placeWords?: string[];
}

export interface PayResult {
  pay: Pay;
  evidence: FactEvidence;
}

/** One pay figure the board states in its own field (ATS API, JSON-LD baseSalary). */
export interface BoardPay {
  min: number | null;
  max: number | null;
  currency: string | null;
  /** null when the board does not say (Greenhouse pay_input_ranges). */
  period: PayPeriod | null;
  /** The board's name for this range ("Zone A", "NYC"), when it gives one. */
  label?: string | null;
  /** The board's own words for evidence. */
  text?: string | null;
}

const HOURS_PER_YEAR = 2080;

export function annualize(v: number | null, period: PayPeriod): number | null {
  if (v === null) return null;
  switch (period) {
    case 'year': return v;
    case 'month': return Math.round(v * 12);
    case 'week': return Math.round(v * 52);
    case 'day': return Math.round(v * 260);
    case 'hour': return Math.round(v * HOURS_PER_YEAR);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Numbers

/** Reads "60,000", "60.000", "60 000", "60'000", "1,20,000", "18.50", "18,50", "60.000,00". null when unreadable. */
export function parseNumber(tok: string): number | null {
  const t = tok.replace(/\s/g, ' ');
  if (!/^\d/.test(t)) return null;
  const seps = t.match(/[.,' ]/g) ?? [];
  if (seps.length === 0) return Number(t);
  const groups = t.split(/[.,' ]/);
  const lastIdx = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','), t.lastIndexOf("'"), t.lastIndexOf(' '));
  const lastSep = t[lastIdx];
  const tail = t.slice(lastIdx + 1);
  const kinds = new Set(seps);
  const allThree = groups.slice(1).every((g) => g.length === 3);
  const indian = groups.length >= 3 && groups[groups.length - 1].length === 3 && groups.slice(1, -1).every((g) => g.length === 2);
  if (kinds.size > 1) {
    if ((lastSep === '.' || lastSep === ',') && tail.length <= 2 && seps.filter((s) => s === lastSep).length === 1) {
      const head = groups.slice(0, -1);
      if (!head.slice(1).every((g) => g.length === 3)) return null;
      return Number(head.join('') + '.' + tail);
    }
    return allThree ? Number(groups.join('')) : null;
  }
  if (lastSep === ' ' || lastSep === "'") return allThree ? Number(groups.join('')) : null;
  if (seps.length > 1) {
    if (allThree || indian) return Number(groups.join(''));
    return null;
  }
  // One separator: three digits after it is a thousands mark ("60,000", "60.000"); one or two is a decimal mark.
  if (tail.length === 3) return Number(groups.join(''));
  if (tail.length <= 2) return Number(groups[0] + '.' + tail);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Periods

const PERIOD_FILLER = /^(?:\s*(?:gross|brutto|brut|bruts|brute|bruto|brutos|brutas|lordi|lordo|net|nett|before\s+tax(?:es)?|pre-?tax|usd|eur|cad|gbp|aud|chf|base(?:\s+(?:salary|pay))?|salary|in\s+base\s+pay|of\s+base|dollars|euros|\(|\))(?![a-z]))*/i;

const PERIOD_AFTER: Array<[RegExp, PayPeriod]> = [
  [/^\s*(?:\/|per|an|a|each|la|por|par|pro|de\s+l'|l')\s*(?:hours?|hrs?|horas?|heures?|stunden?|std|ora)(?![a-z])/i, 'hour'],
  [/^\s*(?:per\s*)?\/\s*(?:per\s+|an?\s+)?(?:h|hr|hrs|hour)(?![a-z])/i, 'hour'],
  [/^\s*(?:hourly|p\/h|ph|p\.h\.|an?\s+hr|hr)(?![a-z])/i, 'hour'],
  [/^\s*(?:\/|per|an|a|al|por|par|pro|all'|l')\s*(?:years?|yrs?|annum|anos?|años?|an|jahr|anno)(?![a-z])/i, 'year'],
  [/^\s*(?:per\s*)?\/\s*(?:per\s+|an?\s+)?(?:yearly|annually|annum|y|yr|year)(?![a-z])/i, 'year'],
  [/^\s*(?:annual(?:ly)?|yearly|per\s+annum|p\.\s?a\.?|pa|anual(?:es)?|annuel(?:le)?s?|jährlich|jahrlich|annui|annuo|annua|anuais|lpa)(?![a-z])/i, 'year'],
  [/^\s*(?:\/|per|a|al|por|par|pro|au)\s*(?:months?|mo|mos|mth|mes|meses|mois|monat|mese|mês)(?![a-z])/i, 'month'],
  [/^\s*\/\s*(?:per\s+)?(?:m|mo|month|mth)(?![a-z])/i, 'month'],
  [/^\s*(?:monthly|mensual(?:es)?|mensuel(?:le)?s?|monatlich|mensile|mensais|mensal|p\.\s?m\.|pcm)(?![a-z])/i, 'month'],
  [/^\s*(?:\/|per|a|por|par|pro)\s*(?:weeks?|wk|wks|semanas?|semaines?|woche|settimana)(?![a-z])/i, 'week'],
  [/^\s*(?:weekly|semanal(?:es)?|hebdomadaire|wöchentlich|wochentlich)(?![a-z])/i, 'week'],
  [/^\s*(?:\/|per|a|al|por|par|pro)\s*(?:days?|d[ií]as?|jours?|tag|giorno)(?![a-z])/i, 'day'],
  [/^\s*(?:daily|diarios?|journalier|täglich|taglich)(?![a-z])/i, 'day'],
];

/** "per mile", "per visit", "a shift": pay per unit of work. The contract has no such period, so it is never shown. */
const UNIT_AFTER = /^\s*(?:\/|per|a|an|each|por|par)\s*(?:mile|mi|km|load|loads|delivery|deliveries|visit|visits|session|sessions|class|classes|case|cases|unit|units|piece|pieces|patient|patients|shift|shifts|call|calls|stop|stops|job|project|word|words|page|pages|lesson|lessons|student|students|child|game|games|event|events|appointment|appointments|procedure|procedures|sq\.?\s?ft|square\s+f(?:oo|ee)t|test|tests|task|tasks|survey|surveys|interview|interviews|hour\s+of\s+overtime|diem|night|weekend|referral|hire)(?![a-z])/i;

/** A period named before the figure ("Hourly rate: $18", "annual salary of", "時給"). The nearest one wins. */
const PERIOD_BEFORE: Array<[RegExp, PayPeriod]> = [
  [/\b(?:hourly|per\s+hour|an\s+hour|by\s+the\s+hour|stundenlohn|stündlich|por\s+hora|horaire|taux\s+horaire)\b|時給|시급/gi, 'hour'],
  [/\b(?:annual(?:ly)?|yearly|per\s+year|a\s+year|per\s+annum|anual|annuel(?:le)?|jährlich|jahresgehalt|bruttojahresgehalt|ral)\b|年収|年俸|연봉/gi, 'year'],
  [/\b(?:monthly|per\s+month|a\s+month|mensual(?:es)?|mensuel(?:le)?|monatlich|monatsgehalt|mensal)\b|月給|월급/gi, 'month'],
  [/\b(?:weekly|per\s+week|a\s+week|semanal)\b|週給|주급/gi, 'week'],
  [/\b(?:daily|per\s+day|a\s+day|day\s+rate|daily\s+rate|diario)\b|日給|일급/gi, 'day'],
];

function periodAfter(s0: string): { period: PayPeriod; len: number } | null {
  // A period word on the next line starts a new item ("$135,000 - $182,000\nAnnual incentive potential").
  const nl = s0.indexOf('\n');
  const s = nl >= 0 ? s0.slice(0, nl) : s0;
  const filler = PERIOD_FILLER.exec(s);
  const skip = filler ? filler[0].length : 0;
  const rest = s.slice(skip);
  for (const [re, p] of PERIOD_AFTER) {
    const m = re.exec(rest);
    if (m) return { period: p, len: skip + m[0].length };
  }
  return null;
}

function periodBefore(s: string): PayPeriod | null {
  let best: { at: number; p: PayPeriod } | null = null;
  for (const [re, p] of PERIOD_BEFORE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) if (!best || m.index > best.at) best = { at: m.index, p };
  }
  return best ? best.p : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Context words

/** Words that show a figure is NOT this job's base pay (bonus, benefits, company money, estimates, ...). */
const STRONG_EXCL = new RegExp('\\b(?:' + [
  'bonus(?:es)?', 'sign[- ]?(?:on|in|ing)', 'signing', 'retention', 'referrals?', 'relocation', 'relo', 'stipends?', 'allowances?',
  'reimburs\\w*', 'tuition', '401\\s?\\(?k\\)?', '403\\s?\\(?b\\)?', 'match(?:ing|ed)?', 'hsa', 'fsa', 'contribut\\w*', 'pension',
  'retirement', 'equity', 'stock', 'rsus?', 'shares', 'commissions?', 'tips?', 'gratuit\\w*', 'differentials?', 'diffs?',
  'premiums?', 'incentives?', 'overtime', 'holiday\\s+pay', 'on[- ]call', 'call[- ]?back', 'revenues?', 'arr', 'mrr', 'gmv',
  'funding', 'funded', 'raised', 'raise', 'raising', 'valuation', 'series\\s+[a-f]', 'seed', 'invest\\w*', 'budget\\w*',
  'assets', 'aum', 'loans?', 'credits?', 'discounts?', 'donat\\w*', 'grants?', 'prizes?', 'awards?', 'fees?', 'costs?',
  'prices?', 'pricing', 'deposits?', 'coverage', 'lifetime', 'vouchers?', 'tickets?', 'gift', 'cell\\s?phone', 'phone',
  'internet', 'gym', 'wellness', 'meals?', 'lunch\\w*', 'commut\\w*', 'transit', 'parking', 'housing', 'rent', 'home\\s+office',
  'equipment', 'learning', 'conference', 'books?', '(?:certification|license|licensing|licensure|exam)\\s+(?:fees?|costs?)', 'ceus?', 'insurance', 'deductible',
  'copay', 'savings', 'facilit\\w*', 'deals?', 'acv', 'tcv', 'quota', 'portfolio', 'volume', 'transactions?', 'spend\\w*',
  'valued?', 'worth', 'fines?', 'penalt\\w*', 'damages', 'settlement',
  'scholarships?', 'minimum\\s+wage', 'return\\s+offer', 'full[- ]time\\s+offer', 'paid\\s+time\\s+off', 'pto', 'valeur',
  'vales?', 'restaurant', 'cesta', 'despensa', 'primes?', 'prämie', 'provision', 'bono', 'bonificaci[oó]n', 'comisi[oó]n(?:es)?',
  'propinas', 'gorjetas', 'rimborso', 'reembolso', 'remboursement', 'erstattung', 'zuschuss', 'indemnit\\w*', 'salary\\s+estimates?', 'pay\\s+estimates?', 'estimated\\s+(?:salary|pay|wage)', 'est\\.',
  'glassdoor', 'indeed', 'ziprecruiter', 'levels\\.fyi', 'salary\\.com', 'market\\s+(?:data|rate\\s+data|size)', 'contract\\s+value',
  'patients?', 'customers?', 'clients?', 'employees?', 'members?', 'users?', 'households?', 'companies', 'businesses',
  'hra', 'fertility', 'adoption', 'child\s?care', 'dependent\s+care', 'caregiving', 'family\s+planning', 'surrogacy', 'ivf',
  'medical', 'dental', 'vision', 'health', 'healthcare', 'eap', 'disability', 'life', 'well-?being', 'perks?', 'subsid\w*',
].join('|') + ')\\b', 'gi');

/** Third-party or market figures: "the national average salary is", "median pay for nurses". */
const MARKET_PHRASE = /\b(?:median|average|avg|typical|mean)\s+(?:\w+\s+){0,2}(?:salary|salaries|pay|wages?|rates?|income|earnings)\b|\b(?:national|industry|market|regional|state)\s+(?:average|median|mean|norm)\b|\b(?:salary|pay|wage)\s+(?:data|surveys?|benchmarks?)\b/i;
/** Words right after a figure that show company money, not pay ("$2M in annual sales"). */
const AFTER_EXCL = /\b(?:sales|orders|revenue|arr|gmv|funding|loans?|deals?|contracts?|spend|budget|volume|assets|in\s+(?:annual\s+|yearly\s+)?(?:sales|revenue|funding|savings|value))\b/i;

/** Words that show a figure is pay. */
const PAY_CUE = /\b(?:starting\s+at|starts\s+at|ctc|cost\s+to\s+company|pay|paid|pays|hourly|salaried|salary|salaries|salario|salário|sueldo|compensation|comp|wages?|rates?|earn\w*|income|remuneration|rémunération|remuneração|remuneraci[oó]n|\w*gehalt|vergütung|verguetung|\w*lohn|verdienst|salaire|retribuzione|stipendio|ral|range|pago|paga|paye|stipend)\b|時給|月給|年収|年俸|日給|給与|시급|연봉|월급/gi;
const BASE_CUE = /\b(?:base|basic|fixed|fixe|fijo|grundgehalt|garantizado|guaranteed)\b/gi;
const TOTAL_CUE = /\b(?:ote|on[- ]target(?:\s+earnings)?|total\s+(?:target\s+)?(?:compensation|comp|cash|pay|package|earnings|rewards?|remuneration)|at\s+plan|target\s+(?:earnings|compensation|comp|cash|total)|earning\s+potential|income\s+potential|potential\s+(?:earnings|income)|(?:with|including|incl\.?|inclusive\s+of)\s+(?:commissions?|bonus(?:es)?|tips|incentives?|variable)|uncapped|package|pacchetto|paquete|pacote|incluso\s+bonus|variable\s+incluid[oa])\b/gi;
/** "plus a $4/hr differential", "additional $2/hr": a figure added on top of another. */
const ADDITIVE = /(?:\bplus\b|\+|\badditional\b|\bextra\b|\bin\s+addition\b|\badded\b|\bon\s+top\s+of\b|\bup\s+to\s+an\s+additional\b)/gi;
/** Stipends that are a benefit, never the pay of an internship. */
const BENEFIT_STIPEND = /\b(?:learning|wellness|phone|cell\w*|internet|remote|home[- ]office|wfh|work[- ]from[- ]home|commut\w*|transit|transport\w*|meal|lunch|food|education\w*|development|fitness|gym|tech\w*|travel|reloc\w*|housing|equipment|book|conference|health|lifestyle|monthly\s+wellness|utility|utilities|mobile|coworking|co-working|workspace|office)\s+(?:and\s+\w+\s+)?stipends?\b|\bstipends?\s+(?:for|to\s+cover|towards?)\b/i;
const INTERN_TITLE = /\b(?:intern|interns|internship|co-?op|fellow|fellowship|resident|residency|extern|externship|apprentice|trainee|stagiaire|praktikant|werkstudent|becario|estagi[aá]ri[oa]|pasante)\b/i;

const BENEFIT_LINE = /\b(?:benefits?|perks|stipends?|commut\w*|reimburs\w*|allowances?|bonus(?:es)?|hsa|fsa|hra|tuition|wellness|referral)\b/i;

function lastMatch(re: RegExp, s: string): { at: number; end: number; text: string } | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let best: { at: number; end: number; text: string } | null = null;
  while ((m = re.exec(s)) !== null) {
    best = { at: m.index, end: m.index + m[0].length, text: m[0] };
    if (m[0].length === 0) re.lastIndex++;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning

interface Amount {
  start: number;
  end: number;
  value: number;
  marker: string | null;
  mult: 'k' | 'lakh' | 'man' | null;
  big: boolean;
  plus: boolean;
  period: PayPeriod | null;
  /** End of the explicit period text, or `end` when there is none. */
  periodEnd: number;
  unit: boolean;
  hint: 'upto' | 'from' | null;
  pct: boolean;
}

const NUM_RE = /\d+(?:(?:[.,']|[ \xa0](?=\d{3}(?![\d])))\d+)*/g;
const BIG_AFTER = /^\s?(?:million|millions|mil(?:l)?\b|mn\b|mm\b|m\b|M\b|billion|billions|bn\b|b\b|B\b|trillion|tn\b|t\b|T\b|crores?|cr\b|milliards?|millones|milhões|milh[oõ]es|mio\.?|mrd\.?)/;
const K_AFTER = /^\s?(?:[kK](?![a-zA-Z])|thousand\b|tsd\.?|mille\b)/;
const LAKH_AFTER = /^\s?(?:lakhs?|lacs?|lpa\b)/i;
const MAN_AFTER = /^\s?万/;
const TAIL_REJECT = /^\s*(?:%|percent|per\s*cent|pct|years?(?![a-z])|yrs?(?![a-z])|-?year(?![a-z])|months?\s+(?:of|experience)|employees|people|users|customers|members|clients|hotels|locations|stores|sq(?![a-z])|square|ft(?![a-z])|feet|miles|km|hours?\s+(?:of|per\s+week|a\s+week|weekly)|x(?![a-z])|times|days?\s+(?:of|per|a)|kg|lbs?|pounds\s+(?:of|lifting)|students|beds|patients|countries|cities|states|languages)/i;
const HINT_UPTO = /(?:up\s+to|as\s+much\s+as|maximum\s+(?:of\s+)?|max\.?\s*:?|no\s+more\s+than|capped\s+at|hasta|jusqu'?\s*[àa]|bis\s+zu|até)\s*$/i;
const HINT_FROM = /(?:\bfrom|starting\s+(?:at|from|pay\s+(?:of|at|is)?|rate\s+(?:of|at|is)?|wage\s+(?:of|at|is)?|salary\s+(?:of|at|is)?|base\s+(?:of|at)?)?|starts\s+at|beginning\s+at|begins?\s+at|will\s+begin\s+at|minimum\s+(?:of\s+)?|min\.?\s*:?|at\s+least|no\s+less\s+than|a\s+partir\s+de|desde|ab|à\s+partir\s+de|starting\s+off\s+at|start\s+at|guaranteed)\s*$/i;
// "or more" after the figure and its period: "$19.00/hr+", "2,800,000円〜" (a wave dash with no second figure).
const HINT_AFTER_FROM = /^\s*(?:(?:minimum|min\.?|or\s+more|and\s+up|and\s+above|or\s+higher)(?![a-z])|\+(?=[ \t]*(?:$|[.,;:)\n]))|[〜～](?!\s*[\d¥￥$€£]))/i;
const HINT_AFTER_UPTO = /^\s*(?:maximum|max\.?|or\s+less)(?![a-z])/i;

function scanAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  NUM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUM_RE.exec(text)) !== null) {
    const numStart = m.index;
    const prevCh = numStart > 0 ? text[numStart - 1] : '';
    // Inside a word or a code ("W2", "E3", "B2B", "H1B", "COVID19"): not money.
    if (/[A-Za-z]/.test(prevCh) && !/[$€£¥₹₩₪₺₱฿₫₴₦₾]/.test(prevCh)) {
      const before2 = text.slice(Math.max(0, numStart - 4), numStart);
      if (!/(?:USD|EUR|GBP|CAD|AUD|CHF|INR|Rs|R\$|RM|Rp)$/.test(before2)) continue;
    }
    let raw = m[0];
    // Codes with a hyphen or a letter glued on are not money: "W-2", "I-9", "COVID-19", "H-1B", "2B".
    if (/[A-Za-z]-$/.test(text.slice(Math.max(0, numStart - 2), numStart))) continue;
    const glued = text.slice(numStart + raw.length, numStart + raw.length + 12);
    if (/^[A-Za-z]/.test(glued) && !/^(?:[kKmMbBtT](?![A-Za-z])|lakhs?|lpa|lacs?|per|an?(?=\s)|hrs?|hour|hourly|yrs?|year|yearly|annum|annual(?:ly)?|months?|monthly|mo|wks?|weeks?|weekly|days?|daily|ph|pa|p\.|usd|eur|gbp|cad|aud|chf|inr|mxn|brl)(?![a-z])/i.test(glued)) continue;
    // Marker before: "$", "USD ", "US$", "€ ", "(" between marker and number is allowed ("$(76,000").
    const sliceStart = Math.max(0, numStart - 8);
    const before = text.slice(sliceStart, numStart).replace(/\(\s*$/, '');
    const pre = CUR_PRE.exec(before);
    let marker: string | null = pre ? pre[1].trim() : null;
    const start = pre ? sliceStart + before.lastIndexOf(pre[1]) : numStart;
    // "60 000 €" groups thousands with a space; "$20 401(k)" does not. A space group needs a marker after it.
    if (/[ \xa0]/.test(raw)) {
      const afterRaw = text.slice(numStart + raw.length, numStart + raw.length + 12);
      if (!CUR_SUF.exec(afterRaw) && !K_AFTER.test(afterRaw)) raw = raw.split(/[ \xa0]/)[0];
    }
    const numEnd = numStart + raw.length;
    NUM_RE.lastIndex = numEnd;
    // Retirement plan names are never money: "401k", "401(k)", "403(b)", "457b".
    if (/^(?:401|403|457)$/.test(raw) && /^\s?(?:\(\s?[kb]\s?\)|[kKbB](?![a-zA-Z]))/.test(text.slice(numEnd, numEnd + 5))) continue;
    const value0 = parseNumber(raw);
    if (value0 === null) continue;
    let pos = numEnd;
    let lpa = false;
    let mult: Amount['mult'] = null;
    let big = false;
    const after = text.slice(pos, pos + 24);
    const bigM = BIG_AFTER.exec(after);
    if (bigM && !/^\s?(?:m|M)\s*(?:\/|per\b|a\b)/.test(after)) { big = true; pos += bigM[0].length; }
    else {
      const k = K_AFTER.exec(after);
      if (k) { mult = 'k'; pos += k[0].length; }
      else {
        const l = LAKH_AFTER.exec(after);
        if (l) { mult = 'lakh'; pos += l[0].length; if (/lpa/i.test(l[0])) lpa = true; }
        else {
          const man = MAN_AFTER.exec(after);
          if (man) { mult = 'man'; pos += man[0].length; }
        }
      }
    }
    // "$165,000+ per year" is "or more"; "$75,000 + bonus" adds something else. Only the first is read, and the
    // "+" of the second stays in the text as a separator.
    let plus = false;
    const PLUS_MORE = /^\+(?=\s*(?:$|[\/.,;:)\n]|per\b|an?\s|hourly|annually|yearly|\/|or\b|and\s+up))/i;
    if (PLUS_MORE.test(text.slice(pos, pos + 20))) { plus = true; pos += 1; }
    const suf = CUR_SUF.exec(text.slice(pos, pos + 24));
    if (suf) {
      if (!marker) marker = suf[1];
      pos += suf[0].length;
    }
    if (!plus && PLUS_MORE.test(text.slice(pos, pos + 20))) { plus = true; pos += 1; }
    const tail = text.slice(pos, pos + 40);
    const pct = /^\s*(?:%|percent|per\s*cent)/i.test(tail);
    let unit = false;
    let period: PayPeriod | null = null;
    let periodEnd = pos;
    const pa = periodAfter(tail);
    if (pa) { period = pa.period; periodEnd = pos + pa.len; }
    else if (lpa) period = 'year';
    else if (UNIT_AFTER.test(tail)) unit = true;
    if (!pa && TAIL_REJECT.test(tail)) {
      // "3 - 5 years", "$10 to 15 percent": never money.
      out.push({ start, end: pos, value: value0, marker, mult, big: true, plus, period: null, periodEnd: pos, unit, hint: null, pct: true });
      NUM_RE.lastIndex = Math.max(NUM_RE.lastIndex, pos);
      continue;
    }
    let value = value0;
    if (mult === 'k') value *= 1000;
    else if (mult === 'lakh') value *= 100000;
    else if (mult === 'man') value *= 10000;
    const lead = text.slice(Math.max(0, start - 40), start);
    let hint: Amount['hint'] = HINT_UPTO.test(lead) ? 'upto' : HINT_FROM.test(lead) ? 'from' : null;
    const afterAll = text.slice(periodEnd, periodEnd + 20);
    if (!hint && (plus || HINT_AFTER_FROM.test(afterAll))) hint = 'from';
    else if (!hint && HINT_AFTER_UPTO.test(afterAll)) hint = 'upto';
    out.push({ start, end: pos, value, marker, mult, big, plus, period, periodEnd, unit, hint, pct });
    NUM_RE.lastIndex = Math.max(NUM_RE.lastIndex, pos);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Candidates

type Kind = 'base' | 'pay' | 'none' | 'total';
const KIND_RANK: Record<Kind, number> = { base: 3, pay: 2, none: 1, total: 0 };

interface Cand {
  start: number;
  end: number;
  min: number | null;
  max: number | null;
  currency: string;
  period: PayPeriod;
  explicit: boolean;
  kind: Kind;
  score: number;
  label: string;
}

const CONNECTOR = /^\s*(?:(?:minimum|min\.?|starting|base|to\s+start|\/(?:hr|hour|h|yr|year)|per\s+(?:hour|year)|annually|hourly)\s*)?(?:-|–|—|~|〜|～|to|through|thru|and|à|a|au|bis|hasta|até|ate|e|y|et|und|tot)\s*(?:(?:(?:go(?:es)?\s+|can\s+go\s+|could\s+go\s+)?up\s+to|a\s+maximum\s+of|max(?:imum)?\.?|of)\s*)?$/i;

function scaleOk(v: number, period: PayPeriod, currency: string): boolean {
  const usd = v / (CURRENCY_SCALE[currency] ?? 1);
  switch (period) {
    case 'hour': return usd >= 2 && usd <= 1000;
    case 'day': return usd >= 30 && usd <= 5000;
    case 'week': return usd >= 150 && usd <= 25000;
    case 'month': return usd >= 400 && usd <= 120000;
    case 'year': return usd >= 8000 && usd <= 3000000;
  }
}

function inferPeriod(v: number, currency: string, beforePeriod: PayPeriod | null): PayPeriod | null {
  if (beforePeriod && scaleOk(v, beforePeriod, currency)) return beforePeriod;
  const usd = v / (CURRENCY_SCALE[currency] ?? 1);
  if (usd >= 10000) return 'year';
  if (usd >= 5 && usd <= 250) return 'hour';
  return null;
}

function resolveCurrency(marker: string | null, country: string | null | undefined): string | null {
  if (marker) return currencyOfMarker(marker, country ?? null);
  return null;
}

interface Pair { a: Amount; b: Amount | null }

function pairAmounts(text: string, amounts: Amount[], country: string | null | undefined): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const a = amounts[i];
    const b = amounts[i + 1];
    if (b && !a.pct && !b.pct) {
      const gap = text.slice(a.periodEnd, b.start);
      if (gap.length <= 30 && CONNECTOR.test(gap)) {
        const ca = resolveCurrency(a.marker, country), cb = resolveCurrency(b.marker, country);
        const dollarish = (x: string | null) => x === null || ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN'].includes(x);
        const compatible = !ca || !cb || ca === cb || ((b.marker === '$' || a.marker === '$') && dollarish(ca) && dollarish(cb));
        if (compatible) {
          pairs.push({ a, b });
          i++;
          continue;
        }
      }
    }
    pairs.push({ a, b: null });
  }
  return pairs;
}

function contextKind(text: string, start: number, end: number, prevEnd: number, title: string | undefined): { kind: Kind; excluded: boolean; cue: boolean } {
  // Before: the clause that leads to the figure, cut at the previous figure. "(" is not a cut.
  const cs = clauseStart(text, start, /[.!?;\n•|]/);
  const from = Math.max(cs, prevEnd, start - 90);
  // Finished asides are not the figure's context: "hourly rate (inclusive of shift differential) of $42".
  let before = text.slice(from, start).replace(/\([^()]*\)/g, (x) => ' '.repeat(x.length));
  // Phrases that mention a bonus without being one: "bonus eligibility", "eligible for a bonus".
  before = before.replace(/\b(?:bonus|commission|incentive|equity)[- ]?eligib\w*|\beligib\w*\s+(?:for\s+)?(?:an?\s+)?(?:annual\s+|quarterly\s+|performance\s+)?(?:bonus(?:es)?|commissions?|incentives?|equity)\b/gi, (s) => ' '.repeat(s.length));
  // After: the words glued to the figure, up to the next separator.
  let after = text.slice(end, Math.min(text.length, end + 60));
  const cut = after.search(/[.;!?\n,(+]|\s(?:plus|and|with|or|y|et|und|e)\s|\s-\s/i);
  if (cut >= 0) after = after.slice(0, cut);
  const afterWords = after.trim().split(/\s+/).slice(0, 5).join(' ');

  // An internship's stipend is its pay; a learning or phone stipend is a benefit.
  const window = text.slice(Math.max(0, start - 60), Math.min(text.length, end + 40));
  const stipendIsPay = !!title && INTERN_TITLE.test(title) && !BENEFIT_STIPEND.test(window);
  const isExcl = (m: { text: string } | null) => !!m && !(stipendIsPay && /^stipends?$/i.test(m.text));

  let kind: Kind = 'none';
  let excluded = false;
  if (afterWords) {
    if (lastMatch(BASE_CUE, afterWords)) kind = 'base';
    else if (lastMatch(TOTAL_CUE, afterWords)) kind = 'total';
    else if (isExcl(lastMatch(STRONG_EXCL, afterWords)) || AFTER_EXCL.test(afterWords) || /\bper\s+diem\b/i.test(afterWords)) excluded = true;
  }
  if (MARKET_PHRASE.test(before)) excluded = true;
  const ex = lastMatch(STRONG_EXCL, before);
  const pc = lastMatch(PAY_CUE, before);
  const bc = lastMatch(BASE_CUE, before);
  const tc = lastMatch(TOTAL_CUE, before);
  const add = lastMatch(ADDITIVE, before);
  const nearestCue = Math.max(pc?.at ?? -1, bc?.at ?? -1, tc?.at ?? -1);
  const insideTotal = !!(ex && tc && ex.at >= tc.at && ex.at < tc.end);
  if (ex && !insideTotal && ex.at > nearestCue && isExcl(ex)) excluded = true;
  // "$48/hr plus a $4/hr night differential": a figure added to an earlier one in the same clause is not the base.
  if (add && add.at > nearestCue && prevEnd > cs) excluded = true;
  if (excluded) return { kind, excluded, cue: false };
  if (kind === 'none') {
    if (bc && (!tc || bc.at > tc.at)) kind = 'base';
    else if (tc) kind = 'total';
    else if (pc) kind = 'pay';
    else if (ex && stipendIsPay) kind = 'pay';
  }
  // A figure alone on its line, under a short benefit line ("Commuter benefit:" then "$500 per month"), is that benefit.
  if (kind === 'none' && !excluded && text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() === '') {
    const above = text.slice(0, text.lastIndexOf('\n', start - 1) + 1).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    if (above.length <= 80 && BENEFIT_LINE.test(above) && !HEADING_CUE.test(above)) return { kind, excluded: true, cue: false };
  }
  return { kind, excluded, cue: kind !== 'none' };
}

const HEADING_CUE = /\b(?:pay|salary|salaries|compensation|wages?|rates?|remuneration|rémunération|salario|sueldo|gehalt|vergütung|pay\s+transparency|pay\s+range|pay\s+zones?|base\s+pay)\b/i;

function headingCue(text: string, start: number): boolean {
  // A pay heading or lead-in on one of the lines above ("Compensation", "Pay Range", "the following US Pay Zones:").
  const back = text.slice(Math.max(0, start - 700), start);
  const lines = back.split('\n').slice(0, -1).map((l) => l.trim()).filter(Boolean).slice(-5);
  return lines.some((l) => (l.length <= 70 || /:\s*$/.test(l)) && l.length <= 200 && HEADING_CUE.test(l) && !/^\W*(?:benefits?|perks)\b/i.test(l));
}

function buildCandidates(text: string, opts: PayParseOptions): Cand[] {
  const amounts = scanAmounts(text);
  const pairs = pairAmounts(text, amounts, opts.country);
  const out: Cand[] = [];
  let prevEnd = 0;
  let prevKind: Kind = 'none';
  let prevCandEnd = -1;
  for (const { a, b } of pairs) {
    const start = a.start;
    const last = b ?? a;
    const end = Math.max(last.periodEnd, last.end);
    const thisPrevEnd = prevEnd;
    prevEnd = end;
    if (a.big || (b && b.big) || a.pct || (b && b.pct) || a.unit || (b && b.unit)) continue;
    const marker = a.marker ?? b?.marker ?? null;
    let currency = resolveCurrency(marker, opts.country);
    // A marker right after the range ("80,000 - 95,000 (CAD)") names the currency of a bare "$".
    const tailCur = /^\s*\(?\s*(USD|CAD|AUD|NZD|SGD|HKD|MXN|EUR|GBP|CHF)\b/.exec(text.slice(end, end + 12));
    if (tailCur && (!currency || marker === '$')) currency = currencyOfMarker(tailCur[1], opts.country);
    let noMarker = false;
    if (!currency) {
      // No marker at all: only with a "k" or a stated period, a pay cue, and a known country ("LPA" is India's).
      const country = opts.country ?? null;
      if (a.mult === 'lakh' || b?.mult === 'lakh') currency = 'INR';
      else if (!country || !COUNTRY_CURRENCY[country]) continue;
      else currency = COUNTRY_CURRENCY[country];
      noMarker = true;
    }
    let va = a.value, vb = b ? b.value : null;
    // A dropped zero ("$90,00 to $130,000", "$130,00 - $190,000"): the short side is thousands too.
    if (b && vb !== null && va < 1000 && vb >= 10000 && /^\d{2,3},\d{2}$/.test(text.slice(a.start, a.end).replace(/^[^\d]+/, '').trim())) va *= 1000;
    // "$120-150k", "120k - 150": a "k" on one side belongs to both.
    if (b) {
      if (a.mult === 'k' && !b.mult && vb !== null && vb < 1000 && va >= 1000) vb *= 1000;
      if (b.mult === 'k' && !a.mult && va < 1000 && vb !== null && vb >= 1000) va *= 1000;
      // "12-18 LPA", "12 - 18 lakhs": the lakh belongs to both.
      if (b.mult === 'lakh' && !a.mult && va < 1000) va *= 100000;
    }
    if ((a.mult === 'lakh' || b?.mult === 'lakh') && noMarker) currency = 'INR';
    let period: PayPeriod | null = b?.period ?? a.period ?? null;
    if (b && a.period && b.period && a.period !== b.period) continue;
    const explicit = period !== null;
    const ctx = contextKind(text, start, end, thisPrevEnd, opts.title);
    if (ctx.excluded) continue;
    // Tiers in one sentence share the first tier's kind: "OTE is $120K to $140K in Phoenix, $125K to $150K in Denver".
    if (ctx.kind === 'none' && prevCandEnd >= 0 && !/[.!?;\n]/.test(text.slice(prevCandEnd, start).replace(/\b(?:[A-Z]|[a-z]{1,3})\.(?=\s*[a-z0-9])/g, ''))) {
      ctx.kind = prevKind; ctx.cue = prevKind !== 'none';
    }
    const heading = headingCue(text, start);
    if (noMarker && !(ctx.cue || heading)) continue;
    // A figure with no currency needs a "k", a period after it, or a period word in its own label ("Hourly rate: 25.00").
    if (noMarker && !explicit && !(a.mult || b?.mult)) {
      // Only right after a label that ends in ":" (or "of", "is"): "Hourly rate: 25.00", "an hourly wage of 18.50".
      const label = text.slice(Math.max(clauseStart(text, start, /[.!?;\n•|]/), thisPrevEnd, start - 60), start);
      if (!(periodBefore(label) && lastMatch(PAY_CUE, label) && /(?::|\bof|\bis)\s*$/i.test(label))) continue;
    }
    // A range of salary size with a pay word close by, but not in its own clause ("... with an $125,000 to
    // $145,000. Base salary may vary ..."). Only for ranges and "k" figures, never for small numbers.
    let wide = false;
    if (!explicit && !ctx.cue && !heading && (b || a.mult === 'k')) {
      const back = text.slice(Math.max(0, start - 250), start);
      const next = text.slice(end, end + 60);
      const cueBack = lastMatch(PAY_CUE, back), exBack = lastMatch(STRONG_EXCL, back);
      wide = (!!cueBack && (!exBack || exBack.at < cueBack.at)) || /^[\s.)]*(?:the\s+)?(?:\w+\s+)?(?:base\s+)?(?:salary|pay|compensation)\b/i.test(next)
        // "US Zone 2: $206,125 - $242,500", "Tier B: $90K - $110K": a pay-zone label right before a salary-size range.
        || (!!b && /\b(?:zone|tier|band|geo|region|location|market|level|grade)\s*[\w-]{0,4}\s*:\s*$/i.test(text.slice(Math.max(0, start - 30), start)));
      if (wide && (vb ?? va) / (CURRENCY_SCALE[currency] ?? 1) < 20000) wide = false;
    }
    if (!explicit) {
      if (!ctx.cue && !heading && !wide) continue;
      const cs = clauseStart(text, start, /[.!?;\n•|]/);
      const pb = periodBefore(text.slice(Math.max(cs, thisPrevEnd, start - 120), start));
      period = inferPeriod(vb ?? va, currency, pb);
      if (!period) continue;
    }
    if (period === null) continue;
    let min: number | null, max: number | null;
    if (b && vb !== null) {
      if (va > vb) {
        if (va / vb > 1.5) continue;
        [va, vb] = [vb, va];
      }
      // "up to $95,000-$130,000" is still the range 95,000 to 130,000.
      min = va; max = vb;
    } else {
      min = va; max = va;
      if (a.hint === 'upto') min = null;
      else if (a.hint === 'from') max = null;
    }
    const lo = min ?? max!, hi = max ?? min!;
    if (!(lo > 0) || !scaleOk(lo, period, currency) || !scaleOk(hi, period, currency)) continue;
    const ratio = hi / lo;
    if (ratio > (ctx.kind === 'total' ? 8 : 5)) continue;
    let score = 0;
    if (explicit) score += 1;
    if (heading) score += 1;
    if (b) score += 0.5;
    prevKind = ctx.kind; prevCandEnd = end;
    const labelStart = Math.max(clauseStart(text, start, /[.!?;\n•|]/), thisPrevEnd, start - 90);
    out.push({
      start, end, min, max, currency, period, explicit, kind: ctx.kind, score,
      label: text.slice(labelStart, start) + ' ' + text.slice(end, Math.min(clauseEnd(text, end, /[.!?;\n•|]/), end + 50)),
    });
  }
  return out;
}

function same(a: Cand, b: Cand): boolean {
  if (a.currency !== b.currency) return false;
  const near = (x: number | null, y: number | null) => (x === null && y === null) || (x !== null && y !== null && Math.abs(x - y) <= Math.max(1, 0.03 * Math.max(x, y)));
  return near(annualize(a.min, a.period), annualize(b.min, b.period)) && near(annualize(a.max, a.period), annualize(b.max, b.period));
}

function inside(single: Cand, range: Cand): boolean {
  if (single.currency !== range.currency || single.period !== range.period) return false;
  if (range.min === null || range.max === null) return false;
  const v = single.min ?? single.max;
  return v !== null && v >= range.min && v <= range.max && (single.min === null || single.max === null || single.min === single.max);
}

function toPay(c: Cand, source: Pay['source'], ranges: number): Pay {
  return {
    min: c.min, max: c.max, currency: c.currency, period: c.period, source, ranges,
    annualMin: annualize(c.min, c.period), annualMax: annualize(c.max, c.period),
  };
}

/**
 * Pay stated in a posting's text. Returns null when the text states none.
 * Several different ranges (tiers by city or level): the one that names the job's place, else the first; `ranges`
 * says how many there are. Bonuses, stipends, benefits, company money, estimates and other jobs' pay are never read.
 */
export function parsePay(text: string, opts: PayParseOptions = {}): PayResult | null {
  if (!text) return null;
  const clean = cutOtherJobs(normalizeText(text));
  if (!/\d/.test(clean)) return null;
  const cands = buildCandidates(clean, opts);
  if (cands.length === 0) return null;
  // A total (OTE, "with commission") figure is used only when nothing else is stated.
  const nonTotal = cands.filter((c) => c.kind !== 'total');
  const pool = nonTotal.length ? nonTotal : cands;
  // Distinct ranges, in text order.
  const distinct: Cand[] = [];
  for (const c of pool) {
    if (distinct.some((d) => same(d, c) || inside(c, d))) continue;
    const idx = distinct.findIndex((d) => inside(d, c));
    if (idx >= 0) { distinct[idx] = c; continue; }
    distinct.push(c);
  }
  let chosen = distinct[0];
  if (distinct.length > 1) {
    const words = (opts.placeWords ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
    if (words.length) {
      const hits = distinct.filter((d) => words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(d.label)));
      if (hits.length === 1) chosen = hits[0];
    }
    if (chosen === distinct[0]) {
      // Prefer the strongest-cued figure when the first one is weak (no period, no cue word nearby).
      const best = [...distinct].sort((x, y) => KIND_RANK[y.kind] - KIND_RANK[x.kind] || y.score - x.score || x.start - y.start)[0];
      if (KIND_RANK[best.kind] > KIND_RANK[chosen.kind]) chosen = best;
    }
  }
  const pay = toPay(chosen, 'description', distinct.length);
  const quote = distinct.length > 1
    ? snippet(clean, distinct[0].start, distinct[distinct.length - 1].end, 480)
    : snippet(clean, chosen.start, chosen.end, 240);
  return { pay, evidence: { source: 'description', text: quote } };
}

/**
 * The first plausible pay figure or range in a text, or null. Kept for the crawler's spike API.
 * Same rules as parsePay (bonuses, benefits and company money are never read).
 */
export function parsePayFromText(text: string): ParsedPay | null {
  const r = parsePay(text);
  if (!r) return null;
  return { min: r.pay.min, max: r.pay.max, currency: r.pay.currency, period: r.pay.period };
}

/**
 * Pay from the board's own field(s). Zero and negative figures mean "not set". A figure with no period takes the
 * period the posting text states for the same numbers, else a period that fits its size (under 500 an hour, from
 * 10,000 a year); a figure that fits neither is not used.
 */
export function payFromBoard(pays: BoardPay[], opts: { text?: string; country?: string | null; placeWords?: string[] } = {}): PayResult | null {
  const good: Array<{ min: number | null; max: number | null; currency: string; period: PayPeriod; label: string; text: string }> = [];
  const fromText = opts.text ? parsePay(opts.text, { country: opts.country }) : null;
  for (const p of pays) {
    let min = p.min !== null && Number.isFinite(p.min) && p.min > 0 ? p.min : null;
    let max = p.max !== null && Number.isFinite(p.max) && p.max > 0 ? p.max : null;
    if (min === null && max === null) continue;
    if (min !== null && max !== null && min > max) [min, max] = [max, min];
    const currency = (p.currency && /^[A-Za-z]{3}$/.test(p.currency.trim())) ? p.currency.trim().toUpperCase()
      : (opts.country && COUNTRY_CURRENCY[opts.country]) || null;
    if (!currency) continue;
    let period = p.period;
    if (!period) {
      if (fromText && fromText.pay.currency === currency && ((fromText.pay.min !== null && min !== null && Math.abs(fromText.pay.min - min) < 1) || (fromText.pay.max !== null && max !== null && Math.abs(fromText.pay.max - max) < 1))) {
        period = fromText.pay.period;
      } else {
        const v = (max ?? min)! / (CURRENCY_SCALE[currency] ?? 1);
        period = v < 500 ? 'hour' : v >= 10000 ? 'year' : null;
      }
    }
    if (!period) continue;
    if (!scaleOk((min ?? max)!, period, currency) || !scaleOk((max ?? min)!, period, currency)) continue;
    const shown = [p.label, [min, max].filter((x) => x !== null).join(' - '), currency, period].filter(Boolean).join(' ');
    // The board's own words are the evidence only when they hold a figure; boilerplate such as "Minimum and maximum
    // wage or salary for the position." gives way to the figures themselves.
    good.push({ min, max, currency, period, label: p.label ?? '', text: p.text && /\d/.test(p.text) ? p.text : shown });
  }
  if (good.length === 0) return null;
  const distinct: typeof good = [];
  for (const g of good) {
    if (distinct.some((d) => d.min === g.min && d.max === g.max && d.currency === g.currency && d.period === g.period)) continue;
    distinct.push(g);
  }
  let chosen = distinct[0];
  if (distinct.length > 1 && opts.placeWords?.length) {
    const hits = distinct.filter((d) => opts.placeWords!.some((w) => w.length >= 2 && d.label.toLowerCase().includes(w.toLowerCase())));
    if (hits.length === 1) chosen = hits[0];
  }
  const pay: Pay = {
    min: chosen.min, max: chosen.max, currency: chosen.currency, period: chosen.period, source: 'board_field',
    ranges: distinct.length, annualMin: annualize(chosen.min, chosen.period), annualMax: annualize(chosen.max, chosen.period),
  };
  const text = distinct.length > 1 ? distinct.map((d) => d.text).join('; ') : chosen.text;
  return { pay, evidence: { source: 'board_field', text: text.slice(0, 500) } };
}
