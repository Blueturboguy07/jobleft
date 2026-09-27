// The panel's numbers (JL-extension-8). Each chip at the top is the size of one list below it, with the same
// words, and the lists split the fields with no overlap: every count equals what the person can see. Pure.

import type { Report, ReportItem } from '../messages.ts';

export interface ReportGroup { key: 'needs' | 'failed' | 'drafts' | 'filled' | 'kept'; title: string; chip: string; items: ReportItem[] }

const GROUPS: Array<{ key: ReportGroup['key']; title: string; statuses: ReportItem['status'][]; chip: (n: number) => string }> = [
  { key: 'needs', title: 'Needs you', statuses: ['needs_you', 'cleared'], chip: (n) => `${n} need you` },
  { key: 'failed', title: 'Not filled', statuses: ['failed'], chip: (n) => `${n} not filled` },
  { key: 'drafts', title: 'Drafts ready', statuses: ['draft_ready'], chip: (n) => `${n} ${n === 1 ? 'draft' : 'drafts'} ready` },
  { key: 'filled', title: 'Filled by jobleft', statuses: ['filled', 'inserted'], chip: (n) => `${n} filled` },
  { key: 'kept', title: 'Kept as they were', statuses: ['kept', 'edited', 'ok'], chip: (n) => `${n} kept` },
];

export function reportGroups(r: Pick<Report, 'items'>): ReportGroup[] {
  return GROUPS.map((g) => {
    const items = r.items.filter((i) => g.statuses.includes(i.status));
    return { key: g.key, title: g.title, chip: g.chip(items.length), items };
  });
}
