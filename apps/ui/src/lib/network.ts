// Words and numbers of the Network screen, kept free of React so they can be tested.

import type { NetworkCompanyGroup } from '@jobleft/contracts';
import { plural } from './format.ts';

/** Today's calendar date on this computer, YYYY-MM-DD (the date a follow-up is due, never the UTC date). */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function dayNumber(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Math.round(Date.UTC(y!, m! - 1, day!) / 86_400_000);
}

/** How a follow-up date stands today (JL-network-6): late by how many days, due today, or coming up. */
export function followUpStatus(followUpOn: string | null, today: string): { kind: 'late' | 'today' | 'soon' | 'none'; days: number; text: string } {
  if (!followUpOn || !/^\d{4}-\d{2}-\d{2}$/.test(followUpOn)) return { kind: 'none', days: 0, text: '' };
  const diff = dayNumber(followUpOn) - dayNumber(today);
  if (diff < 0) return { kind: 'late', days: -diff, text: `${plural(-diff, 'day')} late` };
  if (diff === 0) return { kind: 'today', days: 0, text: 'Due today' };
  return { kind: 'soon', days: diff, text: diff === 1 ? 'Tomorrow' : `In ${plural(diff, 'day')}` };
}

/** The button under "Who to contact first" (JL-network-1): it names what it does for the count at hand. */
export function addTopLabel(topNames: string[], inPlan: number): { label: string; done: boolean } {
  const n = Math.min(2, topNames.length);
  if (n > 0 && inPlan >= n) return { label: n === 1 ? `${topNames[0]} is in your coffee-chat list` : `Your top ${n} are in your coffee-chat list`, done: true };
  if (n === 1) return { label: `Add ${topNames[0]} to my coffee-chat list`, done: false };
  return { label: 'Add top 2 to my coffee-chat list', done: false };
}

/** The toast after adding people to the plan, grammatical for 1 and many. */
export function addedToast(n: number, company: string): string {
  if (n === 0) return `Nobody from ${company} was added.`;
  return `${plural(n, 'person', 'people')} from ${company} ${n === 1 ? 'is' : 'are'} in your coffee-chat list.`;
}

/**
 * The count line above the People list (JL-network-9). A filtered list shows the total when it is known (the whole
 * list is on screen, or the filter is a company or "no company", whose totals the company groups give), else it says
 * that more follow.
 */
export function peopleCountText(o: { rows: number; limit: number; filtered: boolean; total: number | null; companyKey: string | null; noCompany: boolean; q: string; stage: string; groups: NetworkCompanyGroup[] | undefined }): string {
  if (!o.filtered) return o.total !== null ? `${plural(o.total, 'person', 'people')} in your network` : '';
  let known: number | null = null;
  if (o.rows < o.limit) known = o.rows;
  else if (!o.q && o.stage === 'all' && o.groups) {
    if (o.noCompany && !o.companyKey) known = o.groups.filter((g) => g.kind !== 'company').reduce((n, g) => n + g.count, 0);
    else if (o.companyKey && !o.noCompany) known = o.groups.find((g) => g.companyKey === o.companyKey)?.count ?? null;
  }
  if (known !== null && known > o.rows) return `Showing ${o.rows.toLocaleString('en-US')} of ${plural(known, 'person', 'people')}`;
  if (known !== null) return `${plural(known, 'person matches', 'people match')}`;
  return `Showing the first ${o.rows.toLocaleString('en-US')} people. More people match: press “Show more” below.`;
}
