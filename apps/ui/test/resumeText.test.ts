import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byTitleMatch } from '../src/lib/filters.ts';
import { changeName } from '../src/lib/format.ts';

test('the job picker puts the job whose title has the typed words first (JL-resume-14)', () => {
  const jobs = [
    { title: 'Data Analyst, NYC', company: 'Stripe' }, { title: 'Senior Data Analyst, Strategic Finance', company: 'Vanta' },
    { title: 'Infrastructure Engineer', company: 'Data Corp' }, { title: 'Software Engineer - Data Infrastructure', company: 'Figma' },
  ];
  assert.deepEqual(byTitleMatch(jobs, 'Data Infrastructure').map((j) => j.company), ['Figma', 'Data Corp', 'Stripe', 'Vanta']);
  assert.deepEqual(byTitleMatch(jobs, '').map((j) => j.company), ['Stripe', 'Vanta', 'Data Corp', 'Figma'], 'no words: server order');
});

test('each tailoring change has its own name for a screen reader, never a program code (JL-resume-13)', () => {
  const changes = [
    { field: 'skills.order', before: 'SQL, Python', after: 'Python, SQL' },
    { field: 'bullets.order', before: 'Built a billing API.\nCut batch-job time by 40%.', after: '' },
    { field: 'bullets[1]', before: 'Led a migration of 12 services to PostgreSQL with zero downtime.', after: 'x' },
    { field: 'bullets[1]', before: 'Wrote Python scripts that saved 10 hours of manual work each week.', after: 'y' },
    { field: 'summary', before: 'a', after: 'b' },
  ];
  const names = changes.map(changeName);
  assert.equal(new Set(names).size, names.length, 'no two boxes share a name');
  for (const n of names) assert.doesNotMatch(n, /bullets\[|skills\.order|bullets\.order/);
  assert.match(names[2]!, /Keep the change to the bullet "Led a migration/);
});
