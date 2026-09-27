// Fixture postings for the CLI and the preview: a contract Job from a small JSON object, a plain-text posting or an
// HTML page. It fills only what the text states; everything else stays null ("not stated"), as in the store.
// In the app, jobs come from the crawler and the store; this module never fetches anything.

import { createHash } from 'node:crypto';
import type { EmploymentType, ExperienceLevel, Job, Pay, Place, WorkModel } from '@jobleft/contracts';
import { experienceLevelOf, validate, JobSchema } from '@jobleft/contracts';
import { annualize, htmlToText, parsePayFromText, parseYearsRequired } from '@jobleft/parsers';
import { parsePlaceText } from './geo.ts';
import { levelOfTitle } from './job.ts';

export interface LooseJob {
  id?: string;
  title: string;
  company?: string;
  description?: string;
  /** "Austin, TX", "Remote - US", or several places. */
  location?: string | string[];
  url?: string;
  workModel?: WorkModel;
  employmentType?: EmploymentType;
  /** "$80,000 - $95,000 a year", or a contract Pay. */
  pay?: string | Pay;
  department?: string;
  status?: 'open' | 'closed';
  duplicateOf?: string;
  html?: string;
}

const FIXED_TIME = '2026-01-01T00:00:00.000Z';

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function companyKeyOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&|\+/g, 'and')
    .replace(/^the\s+/, '').replace(/[,.]?\s+(inc|llc|l\.l\.c|corp|corporation|co|ltd|llp|plc|pbc|gmbh)\.?$/i, '').replace(/[^a-z0-9]+/g, '');
}

function payOf(p: string | Pay | undefined, description: string): Pay | null {
  if (p && typeof p === 'object') return p;
  const text = typeof p === 'string' ? p : description;
  if (!text) return null;
  const parsed = parsePayFromText(text);
  if (!parsed) return null;
  return {
    min: parsed.min, max: parsed.max, currency: parsed.currency, period: parsed.period, source: 'description', ranges: 1,
    annualMin: annualize(parsed.min, parsed.period), annualMax: annualize(parsed.max, parsed.period),
  };
}

/** A contract Job from a loose fixture. A value that already is a contract Job is returned unchanged. */
const MODEL_WORDS: Record<string, WorkModel> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite', 'on site': 'onsite', 'in-office': 'onsite', 'in office': 'onsite', office: 'onsite' };
const TYPE_WORDS: Record<string, EmploymentType> = { 'full-time': 'full_time', 'full time': 'full_time', full_time: 'full_time', 'part-time': 'part_time', 'part time': 'part_time', part_time: 'part_time', contract: 'contract', internship: 'internship', intern: 'internship', temporary: 'temporary', temp: 'temporary', other: 'other' };

export function looseJob(input: LooseJob | Job): Job {
  if (validate(JobSchema, input).ok) return input as Job;
  const r = input as LooseJob & Record<string, unknown>;
  // Other names people use for the same fields.
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const x: LooseJob = {
    ...r,
    description: r.description ?? text(r.text) ?? text(r.body) ?? text(r.content),
    location: r.location ?? (r.locations as string[] | undefined) ?? text(r.city),
    pay: r.pay ?? (text(r.salary) as string | undefined) ?? text(r.compensation),
    workModel: (MODEL_WORDS[String(r.workModel ?? r.workplaceType ?? '').toLowerCase()] ?? (r.remote === true ? 'remote' : undefined)),
    employmentType: TYPE_WORDS[String(r.employmentType ?? r.jobType ?? r.type ?? '').toLowerCase()],
  };
  if (!x || typeof x.title !== 'string' || !x.title.trim()) throw new Error('a job needs at least a "title"');
  const description = x.description ?? (x.html ? htmlToText(x.html) : '');
  const company = (x.company ?? '').trim() || 'Company not stated';
  // "Austin, TX or Remote (US)", "Austin, TX / Dallas, TX", "Austin, TX; Remote".
  const locs = (Array.isArray(x.location) ? x.location : x.location ? [x.location] : [])
    .flatMap((l) => l.split(/\s*;\s*|\s+\|\s+|\s+or\s+|\s+\/\s+|\s+&\s+(?=remote)/i));
  const places: Place[] = [];
  let remoteText: string | null = null;
  let modelInLocation: WorkModel | null = null;
  for (const l of locs) {
    const t = l.trim();
    if (!t) continue;
    // "Hybrid - Austin, TX", "Austin, TX (On-site)", "Remote (US)".
    const m = /\b(remote|hybrid|on-?site|in[- ]office)\b/i.exec(t);
    const rest = t.replace(/\(?\b(remote|hybrid|on-?site|in[- ]office)\b\)?/gi, ' ').replace(/^[\s\-–—:,|/]+|[\s\-–—:,|/]+$/g, '').replace(/\s{2,}/g, ' ').replace(/^(in|at|near|from)\s+/i, '').trim();
    if (m) {
      const word = m[1].toLowerCase();
      if (word === 'remote' && !/[A-Za-z]{3,}/.test(rest.replace(/\b(us|usa|u\.s\.?|united states|anywhere|worldwide|only)\b/gi, ''))) { remoteText = t; continue; }
      modelInLocation = word === 'remote' ? null : word === 'hybrid' ? 'hybrid' : 'onsite';
      if (word === 'remote') remoteText = t;
    }
    if (/^(anywhere|work from home)\b/i.test(t)) { remoteText = t; continue; }
    const p = parsePlaceText(rest || t);
    places.push({ text: t, city: p.city, region: p.region, country: p.country, placeId: null });
  }
  let workModel: WorkModel | null = x.workModel ?? modelInLocation ?? null;
  if (!workModel && remoteText && !places.length) workModel = 'remote';
  // A place or remote: the person may choose, so the work model is left unstated and the remote option is kept.
  if (!workModel && remoteText && places.length && /\bhybrid\b/i.test(remoteText)) workModel = 'hybrid';

  const remoteScope = remoteText ? { regions: /\b(us|usa|united states|u\.s\.)\b/i.test(remoteText) ? ['US'] : /\b(anywhere|worldwide|global)\b/i.test(remoteText) ? ['WORLDWIDE'] : [], text: remoteText } : null;
  const level = levelOfTitle(x.title);
  const levels: ExperienceLevel[] = level ? [experienceLevelOf(level)] : [];
  const body = `${x.title}\n${company}\n${locs.join('; ')}\n${description}`;
  const id = x.id ?? `ext:${sha(body).slice(0, 16)}`;
  // Required years as the store holds them: the parsers' reading of the posting, with its sentence.
  const years = parseYearsRequired(description);
  const url = x.url && /^https?:\/\//.test(x.url) ? x.url : `https://fixture.invalid/jobs/${encodeURIComponent(id)}`;
  const job: Job = {
    id, status: x.status ?? 'open', closedAt: null, closedReason: null, title: x.title.trim(), company, companyKey: companyKeyOf(company),
    ats: null, board: null, externalId: null, url, applyUrl: null, canonicalUrl: url, places,
    isUs: places.length ? (places.every((p) => p.country === 'US') ? true : places.some((p) => p.country && p.country !== 'US') ? false : null) : remoteScope?.regions.includes('US') ? true : null,
    workModel, remoteScope, employmentType: x.employmentType ?? null, level: level ?? null, levels,
    yearsRequired: years ? { min: years.min, max: years.max } : null, pay: payOf(x.pay, description), postedAt: null, firstSeenAt: FIXED_TIME, lastSeenAt: FIXED_TIME, updatedAt: FIXED_TIME,
    department: x.department ?? null, statements: { sponsorship: null, clearanceRequired: null, usCitizenOnly: null }, skills: [], evidence: years ? { years: years.evidence } : {},
    sources: [{ sourceId: 'external:text', name: 'Fixture file', url, credit: null, firstSeenAt: FIXED_TIME, lastSeenAt: FIXED_TIME }],
    duplicateOf: x.duplicateOf ?? null, contentHash: sha(body + JSON.stringify([x.pay ?? null, x.workModel ?? null, x.employmentType ?? null, x.department ?? null])),
    description,
  };
  return job;
}

/**
 * A posting written as plain text: optional "Field: value" lines at the top (Title, Company, Location, Work model,
 * Type, Pay, URL, Department, Id), a blank line, then the description. Without a Title line the first line is the title.
 */
export function jobFromText(text: string, fallbackId?: string): Job {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length && /^\s*(title|company|location|locations|work model|workmodel|type|job type|employment type|pay|salary|url|link|department|id|status)\s*:/i.test(lines[i])) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(lines[i])!;
    fields[m[1].trim().toLowerCase()] = m[2].trim();
    i++;
  }
  let title = fields.title;
  if (!title) {
    while (i < lines.length && !lines[i].trim()) i++;
    title = (lines[i] ?? '').trim();
    i++;
  }
  while (i < lines.length && !lines[i].trim()) i++;
  const description = lines.slice(i).join('\n').trim();
  const wm = (fields['work model'] ?? fields.workmodel ?? '').toLowerCase();
  const tp = (fields.type ?? fields['job type'] ?? fields['employment type'] ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  return looseJob({
    id: fields.id ?? fallbackId, title, company: fields.company, description, location: fields.location ?? fields.locations,
    url: fields.url ?? fields.link, pay: fields.pay ?? fields.salary, department: fields.department,
    workModel: (['onsite', 'hybrid', 'remote'].includes(wm) ? wm : wm === 'on-site' ? 'onsite' : undefined) as WorkModel | undefined,
    employmentType: (['full_time', 'part_time', 'contract', 'internship', 'temporary', 'other'].includes(tp) ? tp : undefined) as EmploymentType | undefined,
    status: fields.status === 'closed' ? 'closed' : undefined,
  });
}

/** A posting from an HTML page: hidden text is read like any other text (and screener-aimed text is ignored). */
export function jobFromHtml(html: string, fallbackId?: string, company?: string): Job {
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? 'Untitled posting';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const withoutH1 = body.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '');
  return looseJob({ id: fallbackId, title: htmlToText(title).trim(), company, description: htmlToText(withoutH1) });
}
