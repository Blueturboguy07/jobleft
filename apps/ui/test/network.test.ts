import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkCompanyGroup } from '@jobleft/contracts';
import { addTopLabel, addedToast, followUpStatus, localToday, peopleCountText } from '../src/lib/network.ts';

test('JL-network-6: a follow-up says how late it is, or that it is due today', () => {
  assert.deepEqual(followUpStatus('2026-09-01', '2026-09-27'), { kind: 'late', days: 26, text: '26 days late' });
  assert.equal(followUpStatus('2026-09-26', '2026-09-27').text, '1 day late');
  assert.equal(followUpStatus('2026-09-27', '2026-09-27').text, 'Due today');
  assert.equal(followUpStatus('2026-09-28', '2026-09-27').text, 'Tomorrow');
  assert.equal(followUpStatus(null, '2026-09-27').kind, 'none');
  assert.match(localToday(new Date(2026, 8, 27, 23, 30)), /^2026-09-27$/, 'the local date, never the UTC one');
});

test('JL-network-1: the add button fits a company with one person, and the toast is grammatical', () => {
  assert.deepEqual(addTopLabel(['Jen Cho'], 0), { label: 'Add Jen Cho to my coffee-chat list', done: false });
  assert.deepEqual(addTopLabel(['Jen Cho'], 1), { label: 'Jen Cho is in your coffee-chat list', done: true });
  assert.equal(addTopLabel(['A B', 'C D', 'E F'], 1).label, 'Add top 2 to my coffee-chat list');
  assert.equal(addTopLabel(['A B', 'C D'], 2).done, true);
  assert.equal(addedToast(1, 'Block'), '1 person from Block is in your coffee-chat list.');
  assert.equal(addedToast(2, 'Stripe'), '2 people from Stripe are in your coffee-chat list.');
});

test('JL-network-9: a filtered People list gives its total, with one number format', () => {
  const groups: NetworkCompanyGroup[] = [
    { companyKey: 'stripe', kind: 'company', names: [{ name: 'Stripe', count: 60 }], count: 60 },
    { companyKey: null, kind: 'unknown', names: [{ name: '', count: 150 }], count: 150 },
    { companyKey: null, kind: 'placeholder', names: [{ name: 'Self-employed', count: 40 }], count: 40 },
  ];
  const base = { limit: 50, filtered: true, total: 5073, companyKey: null, noCompany: false, q: '', stage: 'all', groups };
  assert.equal(peopleCountText({ ...base, rows: 50, noCompany: true }), 'Showing 50 of 190 people');
  assert.equal(peopleCountText({ ...base, rows: 50, companyKey: 'stripe' }), 'Showing 50 of 60 people');
  assert.equal(peopleCountText({ ...base, rows: 12, q: 'ana' }), '12 people match');
  assert.match(peopleCountText({ ...base, rows: 50, q: 'ana' }), /^Showing the first 50 people\. More people match/);
  assert.equal(peopleCountText({ ...base, filtered: false, rows: 50 }), '5,073 people in your network');
});
