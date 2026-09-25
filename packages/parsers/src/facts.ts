// One call for all facts of a posting: pay, places, US or not, work model and remote area, employment type,
// seniority, required years and the posting's own statements, each with its evidence.
// Never throws: a fact that cannot be read is null (unknown) and a warning says why (parsers O11).
import type {
  EmploymentType, ExperienceLevel, FactEvidence, JobEvidence, Level, Pay, Place, PostingStatements, RemoteScope, WorkModel,
} from '@jobleft/contracts';
import type { PostingInput } from './board.ts';
import { htmlToText } from './html.ts';
import { parseLevel } from './level.ts';
import { parsePay, payFromBoard, type PayResult } from './pay.ts';
import { parseLocationText, placeFromAddress, placeInCountry, placesFromText, textExcludesUs, usFromFacts } from './places.ts';
import { parseEmploymentType, parseStatements } from './statements.ts';
import { clip, keyOf } from './text.ts';
import { US_STATES } from './geo-us.ts';
import { parseWorkModel } from './workmodel.ts';
import { parseYearsRequired } from './years.ts';

export interface PostingFacts {
  pay: Pay | null;
  places: Place[];
  isUs: boolean | null;
  workModel: WorkModel | null;
  remoteScope: RemoteScope | null;
  employmentType: EmploymentType | null;
  level: Level | null;
  levels: ExperienceLevel[];
  yearsRequired: { min: number | null; max: number | null } | null;
  statements: PostingStatements;
  evidence: JobEvidence;
  /** The plain text the facts were read from (the whole posting; never cut short). */
  description: string;
  /** Why a fact is unknown when a reader failed (not when the posting simply does not state it). */
  warnings: string[];
}

const GENERIC_LOCATION = /^\s*(?:multiple(?:\s+locations?)?|various(?:\s+locations?)?|several\s+locations|many\s+locations|n\/?a|tbd|tba|see\s+(?:job\s+)?description|location\s+flexible|flexible|\d+\s+locations?|nowhere(?:,\s*xx)?|home|remote)\s*$/i;

/** Every field in the shape the readers expect; anything else becomes "not given" (a bad field never throws). */
function sanitize(raw: unknown): PostingInput {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const arr = <T>(v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : []);
  return {
    title: str(o.title) ?? '',
    location: str(o.location), locations: strs(o.locations), countries: strs(o.countries),
    addresses: arr(o.addresses), pay: arr(o.pay),
    descriptionHtml: str(o.descriptionHtml), description: str(o.description), extraText: str(o.extraText),
    workplaceType: str(o.workplaceType), remote: typeof o.remote === 'boolean' ? o.remote : null,
    employmentType: str(o.employmentType), seniority: str(o.seniority),
    experienceMonths: typeof o.experienceMonths === 'number' && Number.isFinite(o.experienceMonths) ? o.experienceMonths : null,
  };
}

function safe<T>(warnings: string[], what: string, f: () => T, fallback: T): T {
  try { return f(); } catch (e) {
    warnings.push(`${what} could not be read: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    return fallback;
  }
}

function placeWords(places: Place[]): string[] {
  const out: string[] = [];
  for (const p of places) {
    if (p.city) out.push(p.city);
    if (p.region && p.region.length > 2) out.push(p.region);
    // A tier written for "Colorado" names a job in Denver, CO.
    if (p.country === 'US' && p.region && US_STATES[p.region]) out.push(US_STATES[p.region]);
  }
  return out;
}

function sameRange(a: Pay, b: Pay): boolean {
  const near = (x: number | null, y: number | null) => x !== null && y !== null && Math.abs(x - y) <= Math.max(0.5, 0.01 * Math.max(x, y));
  const same = (x: number | null, y: number | null) => (x === null && y === null) || near(x, y);
  if (a.currency !== b.currency || a.period !== b.period) return false;
  if (same(a.min, b.min) && same(a.max, b.max)) return true;
  // "starting at $17/hour" in the text and 17-17 in the field state the same pay.
  return (near(a.min, b.min) && (a.max === null || b.max === null || a.max === a.min || b.max === b.min))
    || (near(a.max, b.max) && (a.min === null || b.min === null));
}

/** All facts of one posting. Deterministic and offline. */
export function extractFacts(raw: PostingInput): PostingFacts {
  const warnings: string[] = [];
  const input = sanitize(raw);
  const evidence: JobEvidence = {};
  const title = typeof input?.title === 'string' ? input.title : '';
  const description = safe(warnings, 'description', () => {
    if (typeof input.description === 'string' && input.description.trim()) return input.description.includes('<') && /<\/?(?:p|div|br|li|ul|h\d|span|strong|b)\b/i.test(input.description) ? htmlToText(input.description) : input.description;
    return htmlToText(input.descriptionHtml ?? '');
  }, '');
  const extra = typeof input.extraText === 'string' ? htmlToText(input.extraText) : '';

  // Places: structured addresses, then every location text, then (only when the board gives none) the posting text.
  const locTexts = [input.location ?? '', ...(input.locations ?? [])].map((s) => (typeof s === 'string' ? s : '')).filter((s) => s.trim());
  const places: Place[] = [];
  const locRegions: string[] = [];
  let excludesUs = false;
  let placeEv: FactEvidence | undefined;
  safe(warnings, 'places', () => {
    // Gate 1 (single builder): when the primary location names only a remote area ("Remote - Canada", "Remote
    // (Global)"), the board's other location texts (Greenhouse offices) and its structured address are the company's
    // offices, not places the job is in. The remote area alone says where the job is open.
    let remoteAreaOnly = false;
    for (const [i, lt] of locTexts.entries()) {
      if (GENERIC_LOCATION.test(lt) && !/remote/i.test(lt)) continue;
      const r = parseLocationText(lt, { context: description });
      for (const p of r.places) if (!places.some((q) => q.city === p.city && q.region === p.region && q.country === p.country)) places.push(p);
      for (const x of r.remoteRegions) if (!locRegions.includes(x)) locRegions.push(x);
      if (r.excludesUs) excludesUs = true;
      if (i === 0 && /remote/i.test(lt) && !places.some((p) => p.city || p.region) && (locRegions.length > 0 || places.length > 0)) { remoteAreaOnly = true; break; }
    }
    if (places.length) placeEv = { source: 'location_text', text: clip((remoteAreaOnly ? locTexts.slice(0, 1) : locTexts).join('; '), 500) };
    const addrPlaces = remoteAreaOnly ? [] : (input.addresses ?? []).map((a) => placeFromAddress(a, description)).filter((p): p is Place => !!p);
    // The countries the board states in structured fields. A bare city in the location text is read in one of them
    // ("Sudbury" with a US address or a board country of US is Sudbury, MA).
    const stated = [...(input.countries ?? []).filter((c) => typeof c === 'string').map((c) => (c.toUpperCase() === 'UK' ? 'GB' : c.toUpperCase())), ...addrPlaces.map((p) => p.country ?? '')]
      .filter((c, i, all) => /^[A-Z]{2}$/.test(c) && all.indexOf(c) === i);
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      if (!p.city) continue;
      const addr = addrPlaces.find((q) => q.city && q.country && q.city.toLowerCase() === p.city!.toLowerCase());
      // The structured address for the same city states its country and region: it wins over a guess from the name.
      if (addr && addr.country !== p.country && keyOf(p.text) === keyOf(p.city)) { places[i] = { ...p, region: addr.region, country: addr.country }; continue; }
      if (!stated.length || (p.country && stated.includes(p.country)) || keyOf(p.text) !== keyOf(p.city)) continue;
      for (const cc of stated) { const q = placeInCountry(p, cc, description); if (q) { places[i] = q; break; } }
    }
    for (const p of addrPlaces) {
      // An address that repeats a place from the location text adds nothing; one that fills in a country does.
      const same = places.find((q) => q.city && p.city && q.city.toLowerCase() === p.city.toLowerCase());
      if (same) { if (!same.country && p.country) same.country = p.country; if (!same.region && p.region) same.region = p.region; continue; }
      places.push(p);
      placeEv = placeEv ?? { source: 'board_field', text: clip(p.text, 500) };
    }
    if (!places.length && !locRegions.length) {
      const fromText = placesFromText([title, description].join('\n'));
      if (fromText.places.length) { places.push(...fromText.places); placeEv = { source: 'description', text: clip(fromText.evidence ?? fromText.places.map((p) => p.text).join('; '), 500) }; }
    }
  }, undefined);
  if (placeEv && places.length) evidence.places = placeEv;

  // Work model and remote area. A pasted posting has no location field: its "Location:" line stands in for it.
  const textLocation = !locTexts.length && placeEv?.source === 'description' ? placeEv.text.replace(/^.*?(?:location|locations|ubicaci[oó]n|standort|lieu)\s*[:\-–]\s*/i, '') : null;
  const wm = safe(warnings, 'work model', () => parseWorkModel([title, description].join('\n'), {
    workplaceType: input.workplaceType ?? null, remote: input.remote ?? null, location: input.location ?? textLocation ?? null,
    locations: input.locations ?? [], title,
  }), { workModel: null, remoteScope: null, evidence: {} });
  if (wm.evidence.workModel) evidence.workModel = wm.evidence.workModel;
  if (wm.evidence.remoteScope) evidence.remoteScope = wm.evidence.remoteScope;

  // US or not. Board country codes first; a remote job limited to other areas is not a US job.
  const boardCountries = (input.countries ?? []).filter((c) => typeof c === 'string');
  let isUs = safe(warnings, 'country', () => usFromFacts(places, wm.remoteScope?.regions ?? locRegions, boardCountries), null);
  if (excludesUs && !places.some((p) => p.country === 'US')) isUs = false;
  if (wm.workModel === 'remote' && wm.remoteScope && wm.remoteScope.regions.length) {
    const open = wm.remoteScope.regions.some((r) => r === 'US' || r === 'NA' || r === 'AMER' || r === 'WORLDWIDE');
    if (!open && !places.some((p) => p.country === 'US' && (p.city || p.region))) isUs = false;
    if (open && isUs === null) isUs = true;
  }
  // A remote job the posting says is not open to people in the US ("Internationally located candidates only (not in
  // US, CA, UK)"): not a US job, and its remote area is not the whole world.
  const notUs = wm.workModel === 'remote' && !places.some((p) => p.country === 'US' && (p.city || p.region)) ? safe(warnings, 'country', () => textExcludesUs(description), null) : null;
  if (notUs && wm.remoteScope) {
    isUs = false;
    wm.remoteScope = { regions: wm.remoteScope.regions.filter((r) => !['US', 'NA', 'AMER', 'WORLDWIDE'].includes(r)), text: clip(`${wm.remoteScope.text}; ${notUs}`, 500) };
    evidence.remoteScope = { source: 'description', text: clip(notUs, 500) };
  } else if (notUs && isUs !== false) isUs = false;
  const country = places.find((p) => p.country)?.country ?? (boardCountries.length === 1 ? boardCountries[0].toUpperCase() : null) ?? (isUs ? 'US' : null);

  // Pay: the posting text and the board's field. When both state pay and they differ, the text wins (it is what a
  // reader of the posting sees) and `ranges` counts both.
  const payText = [title, description, extra].filter(Boolean).join('\n');
  const words = placeWords(places);
  const fromText: PayResult | null = safe(warnings, 'pay', () => parsePay(payText, { country, title, placeWords: words }), null);
  const fromBoard: PayResult | null = safe(warnings, 'pay field', () => (input.pay?.length ? payFromBoard(input.pay, { text: payText, country, placeWords: words }) : null), null);
  let pay: Pay | null = null;
  if (fromBoard && fromText) {
    if (sameRange(fromBoard.pay, fromText.pay)) { pay = { ...fromBoard.pay, ranges: Math.max(fromBoard.pay.ranges, fromText.pay.ranges) }; evidence.pay = fromBoard.evidence; }
    else { pay = { ...fromText.pay, ranges: Math.max(2, fromText.pay.ranges) }; evidence.pay = { source: 'description', text: clip(`${fromText.evidence.text} (the board's pay field says: ${fromBoard.evidence.text})`, 500) }; }
  } else if (fromBoard) { pay = fromBoard.pay; evidence.pay = fromBoard.evidence; }
  else if (fromText) {
    pay = fromText.pay;
    evidence.pay = fromText.evidence.text && title && fromText.evidence.text.includes(title.trim()) ? { source: 'title', text: fromText.evidence.text } : fromText.evidence;
  }

  // Years, level, employment type, statements.
  const years = safe(warnings, 'years', () => {
    const y = parseYearsRequired(description);
    if (y) return y;
    const months = input.experienceMonths;
    if (typeof months === 'number' && months >= 12) return { min: Math.floor(months / 12), max: null, evidence: { source: 'board_field' as const, text: `Experience required: ${months} months` } };
    return null;
  }, null);
  if (years) evidence.years = years.evidence;
  const emp = safe(warnings, 'employment type', () => parseEmploymentType(input.employmentType ?? null, description, title), { value: null, evidence: null });
  if (emp.evidence) evidence.employmentType = emp.evidence;
  const lv = safe(warnings, 'level', () => parseLevel({ title, text: description, years: years ? { min: years.min, max: years.max, evidence: years.evidence } : null, boardSeniority: input.seniority ?? null, employmentType: emp.value }), { level: null, levels: [], evidence: null });
  if (lv.evidence && lv.levels.length) evidence.level = lv.evidence;
  const st = safe(warnings, 'statements', () => parseStatements(description), { sponsorship: null, clearanceRequired: null, usCitizenOnly: null, evidence: {} });
  if (st.evidence.sponsorship) evidence.sponsorship = st.evidence.sponsorship;
  if (st.evidence.clearanceRequired) evidence.clearanceRequired = st.evidence.clearanceRequired;
  if (st.evidence.usCitizenOnly) evidence.usCitizenOnly = st.evidence.usCitizenOnly;

  return {
    pay, places, isUs,
    workModel: wm.workModel, remoteScope: wm.workModel === 'remote' ? wm.remoteScope : null,
    employmentType: emp.value,
    level: lv.levels.length ? lv.level : null, levels: lv.levels,
    yearsRequired: years ? { min: years.min, max: years.max } : null,
    statements: { sponsorship: st.sponsorship, clearanceRequired: st.clearanceRequired, usCitizenOnly: st.usCitizenOnly },
    evidence, description, warnings,
  };
}
