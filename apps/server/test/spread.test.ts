import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadEmployers } from '../src/core/feed.ts';

test('spreadEmployers: at most 3 jobs of one employer in every 20 results, order otherwise kept, nothing lost', () => {
  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const others = ['Acme', 'Blue Bottle', 'Contoso', 'Fabrikam', 'Northwind', 'Woodgrove'];
  const company = new Map(ids.map((id) => [id, id <= 30 ? 'Palantir' : others[id % others.length]!]));
  const out = spreadEmployers(ids, company);
  assert.deepEqual([...out].sort((a, b) => a - b), ids);
  for (let w = 0; w + 20 <= out.length; w += 20) {
    const counts: Record<string, number> = {};
    for (const id of out.slice(w, w + 20)) counts[company.get(id)!] = (counts[company.get(id)!] ?? 0) + 1;
    for (const [c, n] of Object.entries(counts)) assert.ok(n <= 3 || c !== 'Palantir', `${c} has ${n} in window ${w}`);
  }
  assert.deepEqual(out.slice(0, 5), [1, 2, 3, 31, 32]);
  const palantirOrder = out.filter((id) => company.get(id) === 'Palantir');
  assert.deepEqual(palantirOrder, [...palantirOrder].sort((a, b) => a - b));
});

test('spreadEmployers: with too few employers to honour the cap, the window stays balanced', () => {
  const ids = Array.from({ length: 40 }, (_, i) => i + 1);
  const company = new Map(ids.map((id) => [id, id <= 20 ? 'Palantir' : id % 2 ? 'Acme' : 'Blue Bottle']));
  const first = spreadEmployers(ids, company).slice(0, 20);
  const n = first.filter((id) => company.get(id) === 'Palantir').length;
  assert.ok(n <= 8, `Palantir has ${n} of the first 20`);
});

test('spreadEmployers: a single employer keeps its order when nothing else exists', () => {
  const ids = [5, 4, 3, 2, 1];
  assert.deepEqual(spreadEmployers(ids, new Map(ids.map((i) => [i, 'Only Co']))), ids);
});
