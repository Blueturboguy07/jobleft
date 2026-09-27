// Filter helpers: what each filter control shows, whether it is active, and the chip summary of the drawer.
// Pure functions (unit tested under Node).

import { EXPERIENCE_LEVEL_LABELS, type CompanyStage, type EmploymentType, type JobFilter, type JobSort, type Profile, type WorkModel } from '@jobleft/contracts';
import { ALL_COUNTRIES, COMMON_COUNTRY_CODES } from './countries.ts';

export const TYPE_OPTIONS: Array<{ value: EmploymentType; label: string }> = [
  { value: 'full_time', label: 'Full-time' }, { value: 'contract', label: 'Contract' }, { value: 'part_time', label: 'Part-time' },
  { value: 'internship', label: 'Internship' }, { value: 'temporary', label: 'Temporary' },
];
export const MODEL_OPTIONS: Array<{ value: WorkModel; label: string }> = [
  { value: 'onsite', label: 'Onsite' }, { value: 'hybrid', label: 'Hybrid' }, { value: 'remote', label: 'Remote' },
];
export const LEVEL_OPTIONS = Object.entries(EXPERIENCE_LEVEL_LABELS).map(([value, label]) => ({ value: value as keyof typeof EXPERIENCE_LEVEL_LABELS, label }));
export const POSTED_OPTIONS: Array<{ value: NonNullable<JobFilter['postedWithin']>; label: string }> = [
  { value: '24h', label: 'Past 24 hours' }, { value: '3d', label: 'Past 3 days' }, { value: '7d', label: 'Past week' }, { value: '30d', label: 'Past month' },
];
export const STAGE_OPTIONS: Array<{ value: CompanyStage; label: string }> = [
  { value: 'early', label: 'Early stage' }, { value: 'growth', label: 'Growth stage' }, { value: 'late', label: 'Late stage' }, { value: 'public', label: 'Public company' },
];
/** Every country (the common ones first); pickers that show buttons use COMMON_COUNTRY_OPTIONS and search the rest. */
export const COUNTRY_OPTIONS = ALL_COUNTRIES;
export const COMMON_COUNTRY_OPTIONS = ALL_COUNTRIES.filter((c) => COMMON_COUNTRY_CODES.includes(c.value));
export const SORT_OPTIONS: Array<{ value: JobSort; label: string }> = [
  { value: 'recommended', label: 'Recommended' }, { value: 'top_matched', label: 'Top matched' }, { value: 'most_recent', label: 'Most recent' },
];
export const JOB_FUNCTION_SUGGESTIONS = [
  'Software Engineering', 'Data & Analytics', 'Product', 'Design', 'Nursing', 'Healthcare', 'Accounting & Finance', 'Marketing',
  'Sales', 'Customer Success', 'Operations', 'Human Resources', 'Legal',
];

/**
 * How the minimum yearly pay filter decides (JL-feed-25): the top of a stated range counts, so a range can start
 * below the amount ("$19.50-$60 an hour" passes $100K, its top being $124.8K a year).
 */
export const PAY_FILTER_NOTE = 'A job counts when the top of its stated pay range reaches this amount, so its range can start lower. Jobs with no stated pay are left out unless you tick the box above. Hourly pay counts as its yearly amount (2,080 hours). Pay in other currencies is not compared.';

/** Removes empty lists and false switches so equal filters compare equal and saved filters stay small. */
export function cleanFilter(f: JobFilter): JobFilter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as JobFilter;
}

export function sameFilter(a: JobFilter, b: JobFilter): boolean {
  const norm = (f: JobFilter) => JSON.stringify(Object.entries(cleanFilter(f)).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, Array.isArray(v) ? [...v].map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).sort() : v]));
  return norm(a) === norm(b);
}

export function activeCount(f: JobFilter): number {
  return Object.keys(cleanFilter(f)).filter((k) => k !== 'includeUnknown' && k !== 'status').length;
}

function firstPlus(labels: string[], empty: string): string {
  if (!labels.length) return empty;
  return labels.length === 1 ? labels[0]! : `${labels[0]} (+${labels.length - 1})`;
}

export function countryLabel(f: JobFilter): string {
  const c = f.countries ?? [];
  const names = c.map((x) => COUNTRY_OPTIONS.find((o) => o.value === x)?.label ?? x);
  const places = (f.places ?? []).map((p) => p.text);
  return firstPlus([...places, ...names], 'Location');
}
export const functionLabel = (f: JobFilter) => firstPlus(f.jobFunctions ?? [], 'Job function');
export const levelLabel = (f: JobFilter) => firstPlus((f.levels ?? []).map((l) => EXPERIENCE_LEVEL_LABELS[l]), 'Experience level');
export const typeLabel = (f: JobFilter) => firstPlus((f.employmentTypes ?? []).map((t) => TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t), 'Job type');
export const modelLabel = (f: JobFilter) => firstPlus((f.workModels ?? []).map((t) => MODEL_OPTIONS.find((o) => o.value === t)?.label ?? t), 'Work model');
export const postedLabel = (f: JobFilter) => (f.postedWithin ? POSTED_OPTIONS.find((o) => o.value === f.postedWithin)!.label : 'Date posted');
export const industryLabel = (f: JobFilter) => firstPlus(f.industries ?? [], 'Industry');
export const yearsLabel = (f: JobFilter) => (f.maxYearsRequired !== undefined ? `Up to ${f.maxYearsRequired} years` : 'Years of experience');
export const payLabel = (f: JobFilter) => (f.minAnnualPayUsd !== undefined ? `$${Math.round(f.minAnnualPayUsd / 1000)}K+ a year` : 'Pay');

/** The read-only chip summary at the top of the All Filters drawer. */
export function summaryChips(f: JobFilter): string[] {
  const out: string[] = [];
  out.push(...(f.jobFunctions ?? []));
  out.push(...(f.employmentTypes ?? []).map((t) => TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t));
  out.push(...(f.workModels ?? []).map((t) => MODEL_OPTIONS.find((o) => o.value === t)?.label ?? t));
  out.push(...(f.levels ?? []).map((l) => EXPERIENCE_LEVEL_LABELS[l]));
  out.push(...(f.places ?? []).map((p) => (p.radiusMiles ? `${p.text} (${p.radiusMiles} mi)` : p.text)));
  out.push(...(f.countries ?? []).map((c) => COUNTRY_OPTIONS.find((o) => o.value === c)?.label ?? c));
  if (f.postedWithin) out.push(postedLabel(f));
  if (f.maxYearsRequired !== undefined) out.push(yearsLabel(f));
  if (f.minAnnualPayUsd !== undefined) out.push(payLabel(f));
  if (f.h1bSponsorship) out.push('H-1B sponsor likely');
  if (f.excludeClearanceRequired) out.push('No clearance required');
  if (f.excludeUsCitizenOnly) out.push('Not US citizens only');
  out.push(...(f.industries ?? []));
  out.push(...(f.skills ?? []));
  if (f.roleTypes?.length) out.push(...f.roleTypes.map((r) => (r === 'ic' ? 'Individual contributor' : 'Manager')));
  if (f.companies?.length) out.push(`${f.companies.length} ${f.companies.length === 1 ? 'company' : 'companies'}`);
  if (f.excludedCompanies?.length) out.push(`Excluding ${f.excludedCompanies.length} ${f.excludedCompanies.length === 1 ? 'company' : 'companies'}`);
  out.push(...(f.companyStages ?? []).map((s) => STAGE_OPTIONS.find((o) => o.value === s)?.label ?? s));
  if (f.excludeStaffingAgencies) out.push('No staffing agencies');
  if (f.excludedTitles?.length) out.push(`Excluding titles: ${f.excludedTitles.join(', ')}`);
  if (f.excludedSkills?.length) out.push(`Excluding skills: ${f.excludedSkills.join(', ')}`);
  if (f.excludedIndustries?.length) out.push(`Excluding industries: ${f.excludedIndustries.join(', ')}`);
  return out;
}

/** A short name for a new saved filter: "Software Engineering, US". */
export function suggestName(f: JobFilter): string {
  const parts = [f.jobFunctions?.[0], f.places?.[0]?.text ?? f.countries?.[0]].filter(Boolean) as string[];
  return (parts.join(', ') || 'My filter').slice(0, 120);
}

/**
 * Filters on facts this build has for no job (company industry, stage, staffing agency). They can only match nothing
 * (or, for an exclusion, change nothing), so the screens do not offer them; an older saved filter may still hold them.
 */
export function noDataFilters(f: JobFilter): string[] {
  const out: string[] = [];
  if (f.industries?.length) out.push('industry');
  if (f.excludedIndustries?.length) out.push('industries to leave out');
  if (f.companyStages?.length) out.push('company stage');
  if (f.excludeStaffingAgencies) out.push('staffing agencies');
  return out;
}

export function withoutNoDataFilters(f: JobFilter): JobFilter {
  const { industries: _i, excludedIndustries: _e, companyStages: _c, excludeStaffingAgencies: _s, ...rest } = f;
  return cleanFilter(rest);
}

/**
 * The name of a place from the place list, with its region and (outside the US) its country, so that five towns
 * called Austin read apart (JL-feed-5): "Austin, TX", "Portland, Victoria, Australia".
 */
export function placeLabel(p: { text: string; city?: string | null; region?: string | null; country?: string | null }): string {
  const name = (p.city || p.text).trim();
  let country: string | null = null;
  if (p.country && p.country !== 'US') {
    try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(p.country) ?? p.country; } catch { country = p.country; }
  }
  return [name, p.region?.trim() || null, country].filter(Boolean).join(', ');
}

/** The starting filter from the profile's preferences. */
export function filterFromProfile(p: Profile | null | undefined): JobFilter {
  if (!p) return {};
  const pr = p.preferences;
  return cleanFilter({
    jobFunctions: pr.jobFunctions, employmentTypes: pr.employmentTypes, workModels: pr.workModels, levels: pr.levels,
    countries: pr.countries, places: pr.places,
  });
}

/** Toggles a value in an optional list. */
export function toggle<T>(list: T[] | undefined, v: T): T[] {
  const l = list ?? [];
  return l.includes(v) ? l.filter((x) => x !== v) : [...l, v];
}

/** The filter-bar popovers. Each one owns some fields of the filter and the "include unknown" boxes of those fields. */
export type FilterSection = 'location' | 'function' | 'level' | 'type' | 'model' | 'posted' | 'industry' | 'years' | 'pay';
type UnknownKey = NonNullable<JobFilter['includeUnknown']>[number];
const SECTION_FIELDS: Record<FilterSection, { keys: Array<keyof JobFilter>; unknown: UnknownKey[] }> = {
  location: { keys: ['countries', 'places'], unknown: ['place'] },
  function: { keys: ['jobFunctions'], unknown: [] },
  level: { keys: ['levels'], unknown: ['level'] },
  type: { keys: ['employmentTypes'], unknown: ['employmentType'] },
  model: { keys: ['workModels'], unknown: ['workModel'] },
  posted: { keys: ['postedWithin'], unknown: ['postedAt'] },
  industry: { keys: ['industries'], unknown: [] },
  years: { keys: ['maxYearsRequired'], unknown: ['years'] },
  pay: { keys: ['minAnnualPayUsd'], unknown: ['pay'] },
};

/**
 * The filter after one popover's Apply (JL-feed-1): the popover's own fields come from its draft, every other field
 * from the filter in use at the moment of Apply. So an Apply never drops a filter set in another popover, even when
 * the draft was copied from an older filter.
 */
export function applySection(current: JobFilter, draft: JobFilter, section: FilterSection): JobFilter {
  const { keys, unknown } = SECTION_FIELDS[section];
  const out: Record<string, unknown> = { ...current };
  for (const k of keys) {
    if (draft[k] === undefined) delete out[k];
    else out[k] = draft[k];
  }
  const kept = (current.includeUnknown ?? []).filter((u) => !unknown.includes(u));
  const mine = (draft.includeUnknown ?? []).filter((u) => unknown.includes(u));
  out.includeUnknown = [...kept, ...mine];
  return cleanFilter(out as JobFilter);
}

/** The filter without one popover's fields (its Reset button). */
export function resetSection(f: JobFilter, section: FilterSection): JobFilter {
  return applySection(f, {}, section);
}

export function withUnknown(f: JobFilter, key: NonNullable<JobFilter['includeUnknown']>[number], on: boolean): JobFilter {
  const set = new Set(f.includeUnknown ?? []);
  if (on) set.add(key); else set.delete(key);
  return { ...f, includeUnknown: [...set] };
}

/**
 * Search results for a job picker, closest title first: the typed words as a phrase in the title, then every word in
 * the title, then in the title or company; ties keep the server's order (JL-resume-14: "Data Infrastructure" found the
 * job titled that way 17th of 30).
 */
export function byTitleMatch<T extends { title: string; company: string }>(items: T[], q: string): T[] {
  const k = q.trim().toLowerCase().replace(/\s+/g, ' ');
  const words = k.split(' ').filter(Boolean);
  const rank = (x: T) => {
    const t = x.title.toLowerCase();
    if (k && t.includes(k)) return 0;
    if (words.length && words.every((w) => t.includes(w))) return 1;
    if (words.length && words.every((w) => `${t} ${x.company.toLowerCase()}`.includes(w))) return 2;
    return 3;
  };
  return items.map((x, i) => ({ x, i, r: rank(x) })).sort((a, b) => a.r - b.r || a.i - b.i).map((e) => e.x);
}
