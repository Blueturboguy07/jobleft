// "Who to message first" at one company. Pure and deterministic: the same rows, job and date give the same order.
// Every reason states a fact that the person can check in their own file (the title is quoted, the date is
// written as the export writes it). No reason claims a shared school, a shared team, a past talk, or that someone is
// "the hiring manager for this job": the file holds none of that.

import type { ContactRank, Job, NetworkContact } from '@jobleft/contracts';
import { FIELD_LABELS, readTitle, sharedFields, type Seniority } from './titles.ts';
import { daysBetween, displayDate, isEmailLike, localDate, wholeYearsBetween } from './text.ts';

/** Points per factor. Written down so the order can be explained and checked. */
export const RANK_POINTS = {
  recruiter: 30,
  sameField: 20,
  // Gate 4 (single builder): the same kind of work as the job ("Platform Engineer" for a Platform Engineer opening) is the
  // best coffee-chat informant, above a manager in the field and far above a recent intern.
  sameRole: 15,
  managerInField: 10,
  seniority: { intern: 1, junior: 3, senior: 7, lead: 8, manager: 8, director: 6, vp: 4, exec: 3, founder: 3 } as Record<Seniority, number>,
  recentYear: 10,
  withinThreeYears: 6,
  withinSevenYears: 3,
  email: 5,
  notInLatestFile: -5,
} as const;

const SENIORITY_TEXT: Record<Seniority, string> = {
  intern: 'Intern or student title', junior: 'Early-career title', senior: 'Senior title', lead: 'Lead, staff or principal title',
  manager: 'Manager title', director: 'Director-level title', vp: 'Vice-president title', exec: 'Executive title',
  founder: 'Founder or owner title',
};

export interface RankContext {
  companyKey: string;
  job: Job | null;
  /** ms since the epoch ("now"); the calendar date is taken in the person's time zone. */
  now: number;
  timeZone?: string;
}

/** Contacts that are not in the latest imported file carry this extra flag (see NetworkService). */
type RankInput = NetworkContact & { inLatestFile?: boolean };

const ROLE_STOP = new Set(['senior', 'sr', 'junior', 'jr', 'staff', 'lead', 'principal', 'intern', 'internship', 'student', 'manager', 'director', 'head', 'vp', 'vice', 'president', 'chief', 'associate', 'assistant', 'i', 'ii', 'iii', 'iv', 'of', 'the', 'and', 'a', 'an', 'in', 'for', 'at', 'to', 'us', 'remote', 'hybrid', 'contract', 'time', 'full', 'part']);
/** The words that name the kind of work in a title, without seniority or filler ("Senior Platform Engineer II" -> platform, engineer). */
function roleWords(title: string): string[] {
  return title.toLowerCase().split(/[^a-z0-9+#.]+/).map((w) => w.replace(/s$/, '')).filter((w) => w.length > 1 && !ROLE_STOP.has(w));
}

/** The reasons and points of one contact. Exported for the CLI and tests. */
export function scoreContact(c: RankInput, ctx: RankContext): ContactRank {
  const reasons: Array<{ code: string; text: string }> = [];
  let score = 0;
  const today = localDate(ctx.now, ctx.timeZone);
  const title = c.position ?? '';
  const t = readTitle(title);

  if (c.company) reasons.push({ code: 'company', text: `Company in your file: "${c.company}".` });

  if (t.recruiter) {
    score += RANK_POINTS.recruiter;
    reasons.push({ code: 'recruiter', text: `Works in recruiting: the title is "${title}".` });
  }

  if (ctx.job && !t.recruiter) {
    const jt = readTitle([ctx.job.title, ctx.job.department ?? ''].join(' '));
    const shared = sharedFields(t, jt);
    const jobWords = roleWords(ctx.job.title);
    if (jobWords.length && jobWords.every((w) => roleWords(title).includes(w))) {
      score += RANK_POINTS.sameRole;
      reasons.push({ code: 'same_role', text: `Does the same kind of work as the job: the title is "${title}", the job is "${ctx.job.title}".` });
    }
    if (shared.length) {
      const f = shared[0]!;
      score += RANK_POINTS.sameField;
      reasons.push({ code: 'same_field', text: `Same field as the job (${FIELD_LABELS[f]}): the title is "${title}", the job is "${ctx.job.title}".` });
      if (t.seniority === 'manager' || t.seniority === 'director' || t.seniority === 'vp') {
        score += RANK_POINTS.managerInField;
        reasons.push({ code: 'manager_in_field', text: `A ${t.seniority === 'manager' ? 'manager' : t.seniority === 'director' ? 'director-level' : 'vice-president'} title in the job's field (${FIELD_LABELS[f]}).` });
      }
    }
  }

  if (t.seniority) {
    score += RANK_POINTS.seniority[t.seniority];
    const label = t.seniorityWords === 'chief of staff' ? 'Chief-of-staff title (a senior role, not a C-level officer)' : SENIORITY_TEXT[t.seniority];
    reasons.push({ code: `seniority_${t.seniority}`, text: `${label}: "${title}".` });
  }

  if (!title) reasons.push({ code: 'no_title', text: 'No title in your file, so role fit is unknown.' });

  if (c.connectedOn) {
    const days = daysBetween(c.connectedOn, today);
    const years = wholeYearsBetween(c.connectedOn, today);
    const when = displayDate(c.connectedOn);
    if (days < 0) {
      reasons.push({ code: 'connected_date_future', text: `The file gives a connection date in the future (${when}).` });
    } else if (days < 365) {
      score += RANK_POINTS.recentYear;
      reasons.push({ code: 'connected_recently', text: `Connected within the last year (${when}).` });
    } else if (years < 3) {
      score += RANK_POINTS.withinThreeYears;
      reasons.push({ code: 'connected_years', text: `Connected ${years} year${years === 1 ? '' : 's'} ago (${when}).` });
    } else if (years < 7) {
      score += RANK_POINTS.withinSevenYears;
      reasons.push({ code: 'connected_years', text: `Connected ${years} years ago (${when}).` });
    } else {
      reasons.push({ code: 'connected_long_ago', text: `Connected ${years} years ago (${when}), a long time.` });
    }
  }

  if (isEmailLike(c.email)) {
    score += RANK_POINTS.email;
    reasons.push({ code: 'email_on_file', text: 'Has an email address in your file.' });
  }

  if (c.inLatestFile === false) {
    score += RANK_POINTS.notInLatestFile;
    reasons.push({ code: 'not_in_latest_file', text: 'Not in your latest connections file (kept from an earlier import).' });
  }

  return { contactId: c.id, score, reasons };
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Ranks contacts at one company; each reason is true for the contact's row; same data, same order. */
export function rankContacts(contacts: NetworkContact[], ctx: RankContext): ContactRank[] {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const ranks = contacts.filter((c) => c.companyKey === ctx.companyKey || (c as { matchKeys?: string[] }).matchKeys?.includes(ctx.companyKey))
    .map((c) => scoreContact(c, ctx));
  ranks.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const x = byId.get(a.contactId)!;
    const y = byId.get(b.contactId)!;
    return collator.compare(x.lastName, y.lastName) || collator.compare(x.firstName, y.firstName)
      || (x.lastName < y.lastName ? -1 : x.lastName > y.lastName ? 1 : 0)
      || (x.firstName < y.firstName ? -1 : x.firstName > y.firstName ? 1 : 0)
      || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  });
  return ranks;
}
