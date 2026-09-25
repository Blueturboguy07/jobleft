// The match lane's dictionaries: skills and credentials (with aliases, context rules and related skills), kinds of
// work (occupation families from job titles) and industries. Loaded once from packages/match/data/*.tsv.
// The data is first-party (written for jobleft); see the header of each file and THIRD_PARTY_NOTICES.md.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeText, fold, tokenize, type Token } from './text.ts';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export type SkillKind = 'lang' | 'tool' | 'skill' | 'method' | 'regime' | 'spoken' | 'cred';

export interface SkillDef {
  id: string;
  name: string;
  kind: SkillKind;
  /** Kinds of work where the skill belongs; null = every kind. */
  families: ReadonlySet<string> | null;
  related: Set<string>;
  /** For credentials: licence or cert. */
  credKind?: 'licence' | 'cert';
  /** For credentials: title phrases (folded words) that suggest the person holds it. */
  impliedBy?: string[][];
}

export interface AliasEntry {
  id: string;
  /** Folded words of the alias. */
  norm: string[];
  /** Exact letters to match when the alias is case-sensitive; null otherwise. */
  raw: string[] | null;
  ctx: string | null;
  text: string;
}

export interface FamilyDef {
  id: string;
  label: string;
  industry: string | null;
  phrases: Array<{ words: string[]; head: boolean; text: string }>;
  related: Map<string, number>;
}

export interface IndustryDef {
  id: string;
  name: string;
  related: Map<string, number>;
}

interface IndustryPhrase { industry: string; words: string[]; strength: 'strong' | 'weak'; text: string }
interface NamePhrase { industry: string; words: string[]; text: string }

const FAMILY_MACROS: Record<string, string[]> = {
  '@tech': ['software', 'data', 'it', 'security', 'sales_eng', 'business_analysis'],
  '@health': ['nursing', 'health_support', 'health_clinical', 'health_admin'],
  '@office': ['admin', 'support', 'hr', 'accounting', 'payroll', 'finance', 'operations', 'sales', 'marketing', 'project', 'legal', 'health_admin', 'real_estate', 'business_analysis'],
  '@trades': ['trades_electrical', 'trades_mech', 'maintenance', 'construction', 'construction_mgmt', 'manufacturing'],
  '@edu': ['teaching', 'childcare', 'training'],
  '@mgmt': ['operations', 'retail', 'food', 'hospitality', 'logistics', 'project', 'construction_mgmt'],
};

function readRows(file: string): string[][] {
  const text = readFileSync(join(DATA_DIR, file), 'utf8');
  const rows: string[][] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    rows.push(line.split('|').map((c) => c.trim()));
  }
  return rows;
}

function list(cell: string | undefined): string[] {
  return (cell ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/** Folded words of a phrase, the same way text is folded. */
export function foldWords(phrase: string): string[] {
  return tokenize(phrase).map((t) => t.norm);
}

function parseAlias(id: string, spec: string): AliasEntry | null {
  let s = spec.trim();
  if (!s) return null;
  let caseSensitive = false;
  if (s.startsWith('=')) { caseSensitive = true; s = s.slice(1); }
  let ctx: string | null = null;
  const at = s.lastIndexOf('@');
  if (at > 0) { ctx = s.slice(at + 1).trim(); s = s.slice(0, at).trim(); }
  const toks = tokenize(s);
  if (!toks.length) return null;
  return { id, norm: toks.map((t) => t.norm), raw: caseSensitive ? toks.map((t) => t.raw) : null, ctx, text: s };
}

function families(cell: string): ReadonlySet<string> | null {
  const out = new Set<string>();
  for (const f of list(cell)) {
    if (f === '*') return null;
    if (FAMILY_MACROS[f]) FAMILY_MACROS[f].forEach((x) => out.add(x));
    else out.add(f);
  }
  return out;
}

// ---------------------------------------------------------------- load

export const SKILLS = new Map<string, SkillDef>();
const ALIASES = new Map<string, AliasEntry[]>();
const ALL_ALIASES: AliasEntry[] = [];

function addAlias(a: AliasEntry): void {
  const key = a.norm[0];
  const arr = ALIASES.get(key) ?? [];
  arr.push(a);
  arr.sort((x, y) => y.norm.length - x.norm.length);
  ALIASES.set(key, arr);
  ALL_ALIASES.push(a);
}

for (const [id, name, kind, fams, aliases, related] of readRows('skills.tsv')) {
  if (SKILLS.has(id)) throw new Error(`skills.tsv: duplicate id ${id}`);
  SKILLS.set(id, { id, name, kind: kind as SkillKind, families: families(fams), related: new Set(list(related)) });
  for (const spec of list(aliases)) { const a = parseAlias(id, spec); if (a) addAlias(a); }
}
for (const [id, name, kind, fams, aliases, implied] of readRows('credentials.tsv')) {
  if (SKILLS.has(id)) throw new Error(`credentials.tsv: id ${id} is also a skill id`);
  SKILLS.set(id, {
    id, name, kind: 'cred', credKind: kind === 'licence' ? 'licence' : 'cert', families: families(fams), related: new Set(),
    impliedBy: list(implied).map(foldTitleWords),
  });
  for (const spec of list(aliases)) { const a = parseAlias(id, spec); if (a) addAlias(a); }
}
// Related skills are symmetric.
for (const s of SKILLS.values()) {
  for (const r of s.related) {
    const other = SKILLS.get(r);
    if (!other) throw new Error(`skills.tsv: ${s.id} names unknown related skill ${r}`);
    other.related.add(s.id);
  }
}

export const FAMILIES = new Map<string, FamilyDef>();
const TITLE_PHRASES = new Map<string, Array<{ family: string; words: string[]; head: boolean; text: string }>>();
const familyRows = readRows('occupations.tsv');
for (const [id, label, industry, phrases] of familyRows) {
  FAMILIES.set(id, { id, label, industry: industry && industry !== '-' ? industry : null, phrases: [], related: new Map() });
  for (const p0 of list(phrases)) {
    const head = p0.endsWith('$');
    const text = head ? p0.slice(0, -1).trim() : p0;
    const words = foldTitleWords(text);
    if (!words.length) continue;
    FAMILIES.get(id)!.phrases.push({ words, head, text });
    const arr = TITLE_PHRASES.get(words[0]) ?? [];
    arr.push({ family: id, words, head, text });
    arr.sort((a, b) => b.words.length - a.words.length);
    TITLE_PHRASES.set(words[0], arr);
  }
}
for (const [id, , , , related] of familyRows) {
  for (const r of list(related)) {
    const [other, w] = r.split(':');
    const weight = Number(w);
    if (!FAMILIES.has(other)) throw new Error(`occupations.tsv: ${id} names unknown family ${other}`);
    FAMILIES.get(id)!.related.set(other, weight);
    const back = FAMILIES.get(other)!.related;
    if (!back.has(id)) back.set(id, weight);
  }
}

export const INDUSTRIES = new Map<string, IndustryDef>();
const IND_PHRASES = new Map<string, IndustryPhrase[]>();
const NAME_PHRASES = new Map<string, NamePhrase[]>();
const industryRows = readRows('industries.tsv');
for (const [id, name, strong, weak, names] of industryRows) {
  INDUSTRIES.set(id, { id, name, related: new Map() });
  const add = (spec: string, strength: 'strong' | 'weak') => {
    const words = foldWords(spec);
    if (!words.length) return;
    const arr = IND_PHRASES.get(words[0]) ?? [];
    arr.push({ industry: id, words, strength, text: spec });
    arr.sort((a, b) => b.words.length - a.words.length || (a.strength === 'strong' ? -1 : 1));
    IND_PHRASES.set(words[0], arr);
  };
  list(strong).forEach((p) => add(p, 'strong'));
  list(weak).forEach((p) => add(p, 'weak'));
  for (const spec of list(names)) {
    const words = foldWords(spec);
    if (!words.length) continue;
    const arr = NAME_PHRASES.get(words[0]) ?? [];
    arr.push({ industry: id, words, text: spec });
    arr.sort((a, b) => b.words.length - a.words.length);
    NAME_PHRASES.set(words[0], arr);
  }
}
for (const [id, , , , , related] of industryRows) {
  for (const r of list(related)) {
    const [other, w] = r.split(':');
    if (!INDUSTRIES.has(other)) throw new Error(`industries.tsv: ${id} names unknown industry ${other}`);
    INDUSTRIES.get(id)!.related.set(other, Number(w));
    const back = INDUSTRIES.get(other)!.related;
    if (!back.has(id)) back.set(id, Number(w));
  }
}

// ---------------------------------------------------------------- context rules

const words = (s: string): Set<string> => {
  const set = new Set<string>();
  for (const w of s.split(/\s+/)) if (w) { set.add(w); set.add(fold(w)); }
  return set;
};
const PROG_WORDS = words('programming language languages code coding coder developer developers development engineer engineers engineering firmware embedded compiler compilers scripting software backend frontend stack framework frameworks typed runtime concurrency');
const PROG_ANCHORS = new Set<string>(PROG_WORDS);
for (const a of ALL_ALIASES) {
  const s = SKILLS.get(a.id)!;
  if (a.norm.length === 1 && !a.raw && !a.ctx && (s.kind === 'lang' || (s.kind === 'tool' && s.families?.has('software')))) PROG_ANCHORS.add(a.norm[0]);
}
for (const extra of ['go', 'golang', 'rust', 'c', 'r', 'swift', 'ruby', 'dart', 'julia', 'node']) PROG_ANCHORS.add(extra);
const STATS_ANCHORS = words('python sas spss stata sql matlab julia statistical statistics programming language studio shiny tidyverse ggplot2 dplyr econometrics regression analytics scala excel tableau pandas numpy');
const IOS_ANCHORS = words('ios xcode objective objc swiftui uikit kotlin android mobile apple cocoa macos app apps iphone ipad watchos');
const OFFICE_ANCHORS = words('excel powerpoint outlook office microsoft ms google sheets docs access word teams suite 365');
const DEVOPS_ANCHORS = words('puppet ansible terraform salt saltstack docker kubernetes k8s configuration jenkins devops infrastructure iac chef helm cloud aws gcp azure charts');
const DATA_ANCHORS = words('python sql pyspark hadoop databricks data etl scala kafka airflow big hdfs presto trino snowflake emr spark models model ai ml prompt prompts openai anthropic gpt fine tuning inference rag embeddings agents learning warehouse pipelines analytics generative llm llms');
const DESIGN_ANCHORS = words('figma adobe xd invision wireframes wireframe prototypes prototype ui ux photoshop illustrator design designs designer mockups');
const LMS_ANCHORS = words('lms learning course courses students instructors google classroom blackboard moodle schoology online canvas platform');
const THERAPY_ANCHORS = words('therapy therapies therapeutic counseling clinical dbt mental behavioral treatment interventions evidence-based evidence modalities trauma anxiety depression cbt emdr');
const ABA_ANCHORS = words('therapy autism behavior behavioral rbt bcba children clients sessions treatment analysis asd therapist');
const ACCT_ANCHORS = words('accounting 50 100 300 intacct quickbooks erp software bookkeeping ledger xero netsuite');
const SPOKEN_ANCHORS = words('fluent fluency bilingual speak speaking spoken written language languages native proficient proficiency conversational english verbal read write');
const TRADES_ANCHORS = words('programming ladder controls automation allen bradley siemens hmi scada troubleshoot troubleshooting motor electrical logic vfd vfds instrumentation');
const HR_ANCHORS = words('ats applicant applicants candidate candidates recruiting recruiter recruiters sourcing hiring requisitions offers interview interviews lever greenhouse workday icims taleo');
const MFG_NEIGHBORS = words('line mechanical electrical product products component components parts manual electronic electronics');
const HEALTH_NEIGHBORS = words('ehr emr systems charting hyperspace certification certified credentialed');
const HEALTH_DOC = words('patient patients clinical hospital nursing nurse nurses ehr emr charting physician physicians medical healthcare clinic bedside');
const SW_DOC = words('software developer developers engineering code api apis sprint sprints deploy deployment jira scrum programming engineers');
const MFG_DOC = words('manufacturing production plant factory components machining soldering assembler');
const WELD_DOC = words('welding welder weld welds fabrication mig tig smaw gmaw fabricator');
const NOT_VERB_NEXT = new Set(['to', 'at', 'in', 'as', 'under', 'within', 'quickly', 'calmly', 'appropriately', 'swiftly', 'when']);

export interface ScanDoc {
  tokens: Token[];
  cache: Map<string, boolean>;
}

function docHas(doc: ScanDoc, key: string, set: Set<string>, min: number): boolean {
  const hit = doc.cache.get(key);
  if (hit !== undefined) return hit;
  const seen = new Set<string>();
  for (const t of doc.tokens) if (set.has(t.norm)) { seen.add(t.norm); if (seen.size >= min) break; }
  const ok = seen.size >= min;
  doc.cache.set(key, ok);
  return ok;
}

function neighbors(doc: ScanDoc, i: number, len: number, span: number, set: Set<string>): boolean {
  const toks = doc.tokens;
  const sent = toks[i].sentence;
  for (let k = Math.max(0, i - span); k < Math.min(toks.length, i + len + span); k++) {
    if (k >= i && k < i + len) continue;
    if (toks[k].sentence !== sent) continue;
    if (set.has(toks[k].norm) || set.has(toks[k].lower)) return true;
  }
  return false;
}

/** True when a one-letter or common-word name ("C", "R", "Go") is written as part of a word ("C-suite", "go-to"). */
function hyphenated(doc: ScanDoc, i: number, len: number): boolean {
  const first = doc.tokens[i];
  const last = doc.tokens[i + len - 1];
  return first.sepBefore.endsWith('-') || last.sepAfter.startsWith('-') || /^\d/.test(doc.tokens[i - 1]?.raw ?? '') && first.sepBefore === '';
}

const NAME_BEFORE = new Set(['in', 'with', 'using', 'of', 'and', 'or', 'like', 'as']);
/** "... in C.", "... with Go, ..." : the word follows a preposition and ends a clause. */
function writtenAsName(doc: ScanDoc, i: number, len: number): boolean {
  const prev = doc.tokens[i - 1];
  const last = doc.tokens[i + len - 1];
  const next = doc.tokens[i + len];
  if (!prev || !NAME_BEFORE.has(prev.lower) || prev.sentence !== doc.tokens[i].sentence) return false;
  if (!next || next.sentence !== last.sentence) return true;
  return /^[,;.:)!?/]/.test(last.sepAfter) || next.lower === 'and' || next.lower === 'or';
}

/** The name is the whole line (a bullet in a list): nothing else on its line. */
function wholeLine(doc: ScanDoc, i: number, len: number): boolean {
  const line = doc.tokens[i].line;
  const before = doc.tokens[i - 1];
  const after = doc.tokens[i + len];
  return (!before || before.line !== line) && (!after || after.line !== line);
}

export const CONTEXT_RULES: Record<string, (doc: ScanDoc, i: number, len: number) => boolean> = {
  prog: (doc, i, len) => {
    if (hyphenated(doc, i, len)) return false;
    const next = doc.tokens[i + len];
    const prev = doc.tokens[i - 1];
    if (next && /^\d/.test(next.raw) && next.sepBefore === '') return false;
    if (prev && /^\d+$/.test(prev.raw)) return false; // "30 C"
    if (neighbors(doc, i, len, 4, PROG_ANCHORS)) return true;
    // "Proficiency in C." or a bullet "- Go" inside a posting about software: the name follows "in", "with",
    // "using" or "of" and ends its clause, or it is the whole line.
    return (writtenAsName(doc, i, len) || wholeLine(doc, i, len)) && docHas(doc, 'prog', PROG_ANCHORS, 3);
  },
  stats: (doc, i, len) => {
    if (hyphenated(doc, i, len)) return false;
    if (neighbors(doc, i, len, 4, STATS_ANCHORS)) return true;
    return (writtenAsName(doc, i, len) || wholeLine(doc, i, len)) && docHas(doc, 'stats', STATS_ANCHORS, 2);
  },
  ios: (doc, i, len) => neighbors(doc, i, len, 6, IOS_ANCHORS),
  office: (doc, i, len) => neighbors(doc, i, len, 4, OFFICE_ANCHORS),
  devops: (doc, i, len) => neighbors(doc, i, len, 6, DEVOPS_ANCHORS),
  data: (doc, i, len) => neighbors(doc, i, len, 6, DATA_ANCHORS),
  design: (doc, i, len) => neighbors(doc, i, len, 5, DESIGN_ANCHORS),
  lms: (doc, i, len) => neighbors(doc, i, len, 5, LMS_ANCHORS),
  therapy: (doc, i, len) => neighbors(doc, i, len, 6, THERAPY_ANCHORS),
  aba: (doc, i, len) => neighbors(doc, i, len, 8, ABA_ANCHORS),
  acct: (doc, i, len) => neighbors(doc, i, len, 4, ACCT_ANCHORS),
  spoken: (doc, i, len) => neighbors(doc, i, len, 3, SPOKEN_ANCHORS),
  trades: (doc, i, len) => neighbors(doc, i, len, 5, TRADES_ANCHORS),
  hr: (doc, i, len) => neighbors(doc, i, len, 8, HR_ANCHORS) || docHas(doc, 'hr', HR_ANCHORS, 3),
  health: (doc, i, len) => neighbors(doc, i, len, 3, HEALTH_NEIGHBORS) || docHas(doc, 'health', HEALTH_DOC, 2),
  sw: (doc) => docHas(doc, 'sw', SW_DOC, 2),
  mfg: (doc, i, len) => neighbors(doc, i, len, 3, MFG_NEIGHBORS) || docHas(doc, 'mfg', MFG_DOC, 1),
  cloud: (doc, i, len) => {
    const next = doc.tokens[i + len];
    if (next && /^(d1|d1\.1|d1\.\d|welding|welder|cwi|d17|d9)$/.test(next.lower)) return false;
    return !docHas(doc, 'weld', WELD_DOC, 2);
  },
  notverb: (doc, i, len) => {
    const next = doc.tokens[i + len];
    if (next && NOT_VERB_NEXT.has(next.lower) && next.sepBefore === '') return false;
    return true;
  },
};

// ---------------------------------------------------------------- scanning

export interface AliasMatch {
  id: string;
  /** Token range [i, i + len). */
  i: number;
  len: number;
  start: number;
  end: number;
  alias: string;
}

export interface ScanOptions {
  /** Skip context rules and case checks (the text is a skill list the person wrote, such as "Go" or "excel"). */
  relaxed?: boolean;
  /** Only these kinds (default: every kind). */
  kinds?: ReadonlySet<SkillKind>;
}

/** Finds every skill and credential named in the tokens, longest alias first, each token used once. */
export function scanSkills(tokens: Token[], opts: ScanOptions = {}): AliasMatch[] {
  const doc: ScanDoc = { tokens, cache: new Map() };
  const out: AliasMatch[] = [];
  let i = 0;
  while (i < tokens.length) {
    const cands = ALIASES.get(tokens[i].norm);
    let matched = 0;
    if (cands) {
      for (const a of cands) {
        const len = a.norm.length;
        if (i + len > tokens.length) continue;
        let ok = true;
        for (let k = 0; k < len; k++) {
          if (tokens[i + k].norm !== a.norm[k]) { ok = false; break; }
          // A multi-word alias must not jump across a line or a sentence.
          if (k > 0 && (tokens[i + k].line !== tokens[i].line)) { ok = false; break; }
        }
        if (!ok) continue;
        if (!opts.relaxed) {
          if (a.raw && a.raw.some((r, k) => tokens[i + k].raw !== r)) continue;
          if (a.ctx) {
            const rule = CONTEXT_RULES[a.ctx];
            if (!rule) throw new Error(`unknown context rule @${a.ctx} on ${a.id}`);
            if (!rule(doc, i, len)) continue;
          }
        }
        const kind = SKILLS.get(a.id)!.kind;
        if (opts.kinds && !opts.kinds.has(kind)) continue;
        out.push({ id: a.id, i, len, start: tokens[i].start, end: tokens[i + len - 1].end, alias: a.text });
        matched = len;
        break;
      }
    }
    i += matched || 1;
  }
  return out;
}

/** Live tokens of a short text (a skill name, a company fact). */
export function tokensOfText(s: string): Token[] {
  return analyzeText(s).live;
}

/** The skill id for a whole term, case and context relaxed ("k8s" -> kubernetes, "go" -> go), or null. */
export function skillIdFor(term: string): string | null {
  const toks = tokenize(term);
  if (!toks.length) return null;
  const cands = ALIASES.get(toks[0].norm) ?? [];
  for (const a of cands) {
    if (a.norm.length !== toks.length) continue;
    if (a.norm.every((w, k) => toks[k].norm === w)) return a.id;
  }
  return null;
}

export function skillName(id: string): string {
  return SKILLS.get(id)?.name ?? id;
}

/** Every alias text of a skill id. */
export function aliasesOf(id: string): string[] {
  return ALL_ALIASES.filter((a) => a.id === id).map((a) => a.text);
}

// ---------------------------------------------------------------- titles and kinds of work

/** Folded words of a title phrase: lower case, "&" is "and", punctuation is a space. */
export function foldTitleWords(s: string): string[] {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').split(/[^\p{L}\p{N}+#]+/u).filter(Boolean).map(fold);
}

export interface TitleFamily {
  family: string;
  /** The words of the title that named it (the title's own words, lower case). */
  phrase: string;
}

/** The kind of work a job title names, or null. The phrase that covers the most words wins; ties go to the last one. */
export function familyOfTitle(title: string): TitleFamily | null {
  // Parts of a title: "Registered Nurse - ICU - Nights", "Software Engineer, Backend", "Cook (Full-Time)".
  const parts = title.split(/\s[-–—|/]\s|[,(){}\[\]:;|]|\s[-–—]|[-–—]\s/);
  let best: { family: string; len: number; end: number; text: string } | null = null;
  let offset = 0;
  for (const part of parts) {
    const w = foldTitleWords(part);
    // "Cook II", "Nurse 3", "Technician - Level 2": a trailing grade does not stop a head-noun match.
    while (w.length > 1 && /^(i|ii|iii|iv|v|vi|[1-6]|l[1-6]|level|grade)$/.test(w[w.length - 1])) w.pop();
    for (let i = 0; i < w.length; i++) {
      const cands = TITLE_PHRASES.get(w[i]);
      if (!cands) continue;
      for (const c of cands) {
        const len = c.words.length;
        if (i + len > w.length) continue;
        if (!c.words.every((x, k) => w[i + k] === x)) continue;
        if (c.head && i + len !== w.length) continue;
        const end = offset + i + len;
        if (!best || len > best.len || (len === best.len && end > best.end)) best = { family: c.family, len, end, text: c.text };
        break;
      }
    }
    offset += w.length + 1;
  }
  // A trade or field word in the title decides when the matched phrase is only a generic role ("HVAC Maintenance
  // Technician" is HVAC work; "HVAC Service Manager" has no phrase at all).
  const words = foldTitleWords(title);
  const domains = new Set<string>();
  for (const [re, fam] of DOMAIN_WORDS) if (re.test(title)) domains.add(fam);
  if (domains.size === 1) {
    const [fam] = domains;
    const generic = !best || GENERIC_HEAD.test(best.text);
    if (!best || (generic && best.family !== fam && !domains.has(best.family))) return { family: fam, phrase: words.join(' ') };
  }
  return best ? { family: best.family, phrase: best.text } : null;
}

/** Trade and field words that name the kind of work whatever the role word after them. */
const DOMAIN_WORDS: Array<[RegExp, string]> = [
  [/\b(hvac|refrigeration|boiler|plumbing|pipefitting)\b/i, 'trades_mech'],
  [/\b(electrical|electrician)\b/i, 'trades_electrical'],
  [/\bpharmacy\b/i, 'health_support'],
  [/\b(warehouse|forklift|distribution center)\b/i, 'logistics'],
  [/\bpayroll\b/i, 'payroll'],
  [/\b(accounting|accounts payable|accounts receivable|bookkeeping)\b/i, 'accounting'],
  [/\b(nursing|rn)\b/i, 'nursing'],
  [/\b(kitchen|restaurant|culinary)\b/i, 'food'],
  [/\b(retail|store)\b/i, 'retail'],
  [/\b(classroom|teaching)\b/i, 'teaching'],
  [/\b(marketing|seo|social media)\b/i, 'marketing'],
  [/\b(recruiting|talent acquisition|human resources)\b/i, 'hr'],
  [/\b(construction)\b/i, 'construction'],
  [/\b(fleet|trucking|cdl)\b/i, 'driving'],
];
/** Role words that say nothing about the field on their own. */
const GENERIC_HEAD = /^(maintenance )?(technician|tech|mechanic|specialist|coordinator|assistant|clerk|associate|manager|supervisor|lead|worker|operator|installer|inspector|analyst|administrator|representative|agent|helper|trainee|apprentice|maintenance technician|maintenance mechanic|maintenance worker|service technician|field service technician|general manager|operations manager)$/i;

/** How close two kinds of work are: 1 = the same, 0 = unrelated. */
export function familyRelatedness(a: string, b: string): number {
  if (a === b) return 1;
  return FAMILIES.get(a)?.related.get(b) ?? 0;
}

export function familyLabel(id: string): string {
  return FAMILIES.get(id)?.label ?? id;
}

// ---------------------------------------------------------------- industries

export interface IndustryHit {
  industry: string;
  strength: 'strong' | 'weak';
  start: number;
  end: number;
  phrase: string;
}

/** Industry phrases in the tokens, longest first, each token used once. */
export function scanIndustries(tokens: Token[]): IndustryHit[] {
  const out: IndustryHit[] = [];
  let i = 0;
  while (i < tokens.length) {
    const cands = IND_PHRASES.get(tokens[i].norm);
    let matched = 0;
    if (cands) {
      for (const c of cands) {
        const len = c.words.length;
        if (i + len > tokens.length) continue;
        let ok = true;
        for (let k = 0; k < len; k++) {
          if (tokens[i + k].norm !== c.words[k] || tokens[i + k].line !== tokens[i].line) { ok = false; break; }
        }
        if (!ok) continue;
        out.push({ industry: c.industry, strength: c.strength, start: tokens[i].start, end: tokens[i + len - 1].end, phrase: c.text });
        matched = len;
        break;
      }
    }
    i += matched || 1;
  }
  return out;
}

/** The industry an employer's name names ("Mercy Hospital" -> healthcare), from the phrase nearest the end, or null. */
export function industryOfName(name: string): { industry: string; phrase: string } | null {
  const toks = tokenize(name);
  let best: { industry: string; phrase: string; end: number; len: number } | null = null;
  let i = 0;
  while (i < toks.length) {
    const cands = NAME_PHRASES.get(toks[i].norm);
    let matched = 0;
    if (cands) {
      for (const c of cands) {
        const len = c.words.length;
        if (i + len > toks.length) continue;
        if (!c.words.every((w, k) => toks[i + k].norm === w)) continue;
        const end = i + len;
        if (!best || end > best.end || (end === best.end && len > best.len)) {
          best = { industry: c.industry, phrase: name.slice(toks[i].start, toks[i + len - 1].end), end, len };
        }
        matched = len;
        break;
      }
    }
    i += matched || 1;
  }
  return best ? { industry: best.industry, phrase: best.phrase } : null;
}

export function industryName(id: string): string {
  return INDUSTRIES.get(id)?.name ?? id;
}

export function industryRelatedness(a: string, b: string): number {
  if (a === b) return 1;
  return INDUSTRIES.get(a)?.related.get(b) ?? 0;
}

// ---------------------------------------------------------------- the SkillDictionary shape

/**
 * The match lane's skill dictionary in the `SkillDictionary` shape of @jobleft/static-data, so other packages can use
 * the same names: canonical("k8s") = "Kubernetes"; extract() never reads "Java" out of "JavaScript".
 */
export const matchSkillDictionary = {
  canonical(term: string): string | null {
    const id = skillIdFor(term);
    return id ? skillName(id) : null;
  },
  aliases(canonical: string): string[] {
    const id = skillIdFor(canonical);
    return id ? aliasesOf(id) : [];
  },
  extract(text: string): string[] {
    const a = analyzeText(text);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of scanSkills(a.live)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(skillName(m.id));
    }
    return out;
  },
};

/** Counts for the README and tests. */
export function taxonomyStats(): { skills: number; credentials: number; aliases: number; families: number; titlePhrases: number; industries: number; nonTechSkills: number } {
  let creds = 0, nonTech = 0;
  const tech = new Set(FAMILY_MACROS['@tech']);
  for (const s of SKILLS.values()) {
    if (s.kind === 'cred') creds++;
    if (!s.families || [...s.families].some((f) => !tech.has(f))) nonTech++;
  }
  let phrases = 0;
  for (const f of FAMILIES.values()) phrases += f.phrases.length;
  return { skills: SKILLS.size - creds, credentials: creds, aliases: ALL_ALIASES.length, families: FAMILIES.size, titlePhrases: phrases, industries: INDUSTRIES.size, nonTechSkills: nonTech };
}
