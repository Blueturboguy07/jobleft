import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFromTitle, levelsOf, parseLevel, parseYearsRequired } from '../src/index.ts';

const lv = (title: string, text = '') => {
  const y = parseYearsRequired(text);
  return parseLevel({ title, text, years: y ? { min: y.min, max: y.max } : null }).levels;
};

test('level: tech and non-tech titles', () => {
  const cases: Array<[string, string[]]> = [
    ['Software Engineering Intern', ['intern_new_grad']],
    ['Registered Nurse - New Grad Residency', ['intern_new_grad', 'entry']],
    ['Junior Designer', ['entry']],
    ['Senior Accountant', ['senior']],
    ['Staff Software Engineer', ['lead_staff']],
    ['Principal Engineer', ['lead_staff']],
    ['Engineering Manager', ['lead_staff']],
    ['Store Manager', ['lead_staff']],
    ['Charge Nurse', ['lead_staff']],
    ['Director of Nursing', ['director_exec']],
    ['Vice President, Lending', ['director_exec']],
    ['Chief Nursing Officer', ['director_exec']],
    ['Head of Marketing', ['director_exec']],
    ['Elementary School Principal', ['director_exec']],
    ['Registered Nurse II', ['mid']],
    ['Cashier', ['entry']],
    ['Warehouse Associate', ['entry']],
    ['Line Cook', ['entry']],
    ['Middle School Math Teacher', []],
  ];
  for (const [t, want] of cases) assert.deepEqual(lv(t), want, t);
});

test('level: one word in the title does not decide (O5 angles 1 to 3)', () => {
  assert.deepEqual(lv('Senior Care Aide'), ['entry'], '"senior" here means older people');
  assert.deepEqual(lv('Senior Living Cook'), ['entry']);
  assert.equal(levelFromTitle('Staff Nurse'), null, 'a staff nurse is not Lead/Staff');
  assert.equal(levelFromTitle('Internal Audit Analyst'), null);
  assert.equal(levelFromTitle('International Sales Rep'), null);
  for (const t of ['Shift Manager', 'Shift Supervisor', 'Shift Lead']) {
    const got = lv(t);
    assert.ok(!got.includes('director_exec') && !got.includes('lead_staff'), t);
  }
  assert.deepEqual(lv('Internship Program Coordinator'), ['entry'], 'coordinates interns; is not one');
});

test('level: grades give way to the stated years (O5 angle 4)', () => {
  assert.deepEqual(lv('Engineer III', 'Requirements: 0-2 years of experience in civil design.'), ['entry']);
  assert.deepEqual(lv('Engineer III', 'Requirements: 6+ years of experience.'), ['senior']);
  assert.deepEqual(lv('Associate', 'We need 3-5 years of experience in credit analysis.'), ['mid']);
  assert.deepEqual(lv('Staff Engineer - Geotechnical', 'Requires 0-2 years of experience; EIT preferred.'), ['entry']);
  assert.deepEqual(lv('Senior Accountant', 'You have 3+ years of accounting experience.'), ['mid', 'senior']);
  assert.deepEqual(levelsOf('senior', { min: 5, max: null }), ['senior']);
  assert.deepEqual(levelsOf(null, { min: 2, max: null }), ['entry', 'mid']);
  assert.deepEqual(levelsOf(null, null), []);
});

test('level: posting words give non-tech jobs a level (O10 angle 4)', () => {
  assert.deepEqual(lv('Front Desk Agent', 'No experience required - we will train you.'), ['entry']);
  assert.deepEqual(lv('Registered Nurse', 'New grads welcome! Join our med-surg team.'), ['intern_new_grad', 'entry']);
  assert.deepEqual(lv('Registered Nurse', 'Minimum 3 years of acute care experience.'), ['mid']);
  assert.deepEqual(lv('Delivery Driver'), ['entry']);
});

test('years: only experience requirements, the lowest that meets them (O6)', () => {
  const y = (t: string) => { const r = parseYearsRequired(t); return r ? [r.min, r.max] : null; };
  assert.equal(y('Must be 18 years or older.'), null);
  assert.equal(y('We have been serving customers for over 50 years.'), null);
  assert.equal(y('Stock vests over 4 years.'), null);
  assert.equal(y('A four-year degree is required.'), null);
  assert.equal(y('No accidents within the last 3 years.'), null);
  assert.deepEqual(y('5 years of experience, or 3 years with a master\'s degree.'), [3, null]);
  assert.deepEqual(y('5+ years of SaaS sales experience, or 3 years with an MBA.'), [3, null]);
  assert.deepEqual(y('Required: 2 years of retail experience.\nPreferred: 7 years of management experience.'), [2, null]);
  assert.deepEqual(y('- Bachelor\'s degree and 4 years of experience\n- OR Master\'s degree and 2 years of experience'), [2, null]);
  assert.deepEqual(y('3-5 years of experience in nursing'), [3, 5]);
  assert.deepEqual(y('At least one (1) year of customer service experience'), [1, null]);
  assert.deepEqual(y('10+ years of experience working with data; 2+ years with Kafka (nice to have)'), [10, null]);
  assert.deepEqual(y('Our team has 20+ years of experience. You have 3+ years of experience.'), [3, null]);
  assert.deepEqual(y('Al menos 5 años de experiencia desarrollando soluciones backend'), [5, null]);
  assert.equal(y('Minimum 6 months of experience'), null);
});
