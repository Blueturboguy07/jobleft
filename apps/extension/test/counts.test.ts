import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportItem } from '../src/messages.ts';
import { reportGroups } from '../src/content/counts.ts';

const item = (fieldId: string, status: ReportItem['status']): ReportItem => ({ fieldId, label: fieldId, required: false, section: null, status, value: null, item: null, reason: null });

test('each chip is the size of the list with the same words; the lists split the fields (JL-extension-8)', () => {
  // The finding: chips "12 filled | 31 need you | 1 not filled | 0 kept | 2 drafts" over a list "Needs you (34)".
  const items: ReportItem[] = [
    ...Array.from({ length: 12 }, (_, i) => item(`f${i}`, 'filled')),
    ...Array.from({ length: 31 }, (_, i) => item(`n${i}`, i % 10 === 0 ? 'cleared' : 'needs_you')),
    item('resume', 'failed'), item('why', 'draft_ready'), item('project', 'draft_ready'), item('typed', 'edited'),
  ];
  const groups = reportGroups({ items });
  assert.deepEqual(groups.map((g) => [g.title, g.items.length, g.chip]), [
    ['Needs you', 31, '31 need you'],
    ['Not filled', 1, '1 not filled'],
    ['Drafts ready', 2, '2 drafts ready'],
    ['Filled by jobleft', 12, '12 filled'],
    ['Kept as they were', 1, '1 kept'],
  ]);
  for (const g of groups) assert.ok(g.chip.startsWith(`${g.items.length} `), `${g.chip} vs ${g.title} (${g.items.length})`);
  const all = groups.flatMap((g) => g.items.map((i) => i.fieldId));
  assert.equal(all.length, items.length, 'no field is in two lists, none is missing');
  assert.equal(new Set(all).size, items.length);
});
