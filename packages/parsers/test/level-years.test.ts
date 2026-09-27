import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFromTitle, levelsOf, parseLevel, parsePayFromText, parseStatements, parseYearsRequired } from '../src/index.ts';
import { experienceLevelOf } from '@jobleft/contracts';

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
    ['Middle School Math Teacher', ['entry', 'mid']],
    ['Clinical Psychologist', ['mid', 'senior']],
    ['Licensed Clinical Social Worker (LCSW)', ['mid']],
    ['Provisionally Licensed Therapist', ['entry', 'mid']],
    ['Staff Accountant', ['entry']],
    ['Registered Nurse', ['entry', 'mid']],
    ['Software Engineer', []],
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
  assert.deepEqual(lv('Tech Lead Manager, Payments', 'You have 2+ years of experience.'), ['lead_staff'], 'a manager is a role, not a grade');
  assert.deepEqual(lv('Staff Software Engineer', 'You have 3+ years of experience with Go.'), ['lead_staff']);
  assert.deepEqual(lv('Product Manager', 'You have 3+ years of product experience.'), ['mid']);
  assert.deepEqual(lv('Leader in Training'), ['entry', 'mid']);
  assert.deepEqual(lv('Associate General Counsel, Privacy'), ['senior', 'lead_staff']);
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

// JL-feed-3: a posting that asks for "a minimum of 1 year" was read as 5+ years, Senior Level, from a block that lists
// the employer's other roles ("Not a match for this role? ... Experienced Painter (min 5 years ...)").
const CARVANA = [
  "We're looking for Airbrush Technicians with a minimum of 1 year of professional automotive painting experience to join us.",
  '',
  "If you're joining us in an entry-level position, we offer training programs.",
  '',
  'Pay Range: $22 - $26',
  '',
  'Not a match for this role?',
  'We have a variety of paint roles available, depending on your experience - look below to see other roles:',
  '- Paint Prepper (min 6 months professional experience): prepare vehicles for cosmetic paintwork',
  '- Entry-Level Painter (min 1 year professional experience): prime vehicles',
  '- Mid-Level Painter (min 3 years professional experience): match/mix paint color',
  '- Experienced Painter (min 5 years professional experience): painting base coats',
].join('\n');

test('JL-feed-3: years come from the posting\'s own sentence, never from a block about other roles', () => {
  const y = parseYearsRequired(CARVANA);
  assert.deepEqual([y?.min, y?.max], [1, null]);
  assert.match(y!.evidence.text, /minimum of 1 year of professional automotive painting experience/);
  const r = parseLevel({ title: 'Automotive Airbrush Technician - 2nd Shift', text: CARVANA, years: y });
  assert.equal(r.level, 'entry');
  assert.deepEqual(r.levels, ['entry']);
  // The block ends at this job's own next heading: its pay and statements after the block are still read.
  const tail = `${CARVANA.replace('Pay Range: $22 - $26', '')}\n\nGeneral qualifications and requirements\n\n- Must be at least 18 years of age\n\nPay Range: $23-$27 Hourly\n\nThis role is not eligible for visa sponsorship.`;
  assert.deepEqual([parseYearsRequired(tail)?.min], [1]);
  const pay = parsePayFromText(tail);
  assert.deepEqual([pay?.min, pay?.max, pay?.period], [23, 27, 'hour']);
  assert.equal(parseStatements(tail).sponsorship, 'no');
  // Other wordings of the same block.
  for (const head of ['Not the right fit for you?', 'Other roles available:', 'Not quite the right role?']) {
    assert.equal(parseYearsRequired(`You have 2+ years of experience in retail.\n\n${head}\n- Store Manager (min 6 years of retail experience)`)?.min, 2, head);
  }
});

test('JL-feed-9: the level is always one of the levels, and a "Senior"/"Sr." title is never Entry Level by one years figure', () => {
  const sap = parseLevel({ title: 'SAP Sr. Testing Analyst', text: 'What you need:\n• 1+ years of SAP S/4HANA and SAP CAR testing experience', years: { min: 1, max: null } });
  assert.deepEqual([sap.level, sap.levels], ['senior', ['senior']]);
  const cases: Array<[string, string]> = [
    ['Director of Data Science & Analytics', '5+ years of experience in data science'],
    ['Lead Security Analyst', '3+ years of security experience'],
    ['Investment Banking, Senior Analyst/Associate, DCM', '1+ years of investment banking experience'],
    ['Senior Leasing Consultant', 'At least 1 year of leasing experience'],
    ['Lead Teacher', 'Minimum 3 years of classroom teaching experience'],
    ['Engineer III', 'Requirements: 0-2 years of experience in civil design.'],
    ['Staff Engineer - Geotechnical', 'Requires 0-2 years of experience; EIT preferred.'],
    ['Cashier', ''],
  ];
  for (const [title, text] of cases) {
    const y = parseYearsRequired(text);
    const r = parseLevel({ title, text, years: y });
    if (r.level) assert.ok(r.levels.map(String).includes(experienceLevelOf(r.level)), `${title}: ${r.level} not in ${r.levels.join(',')}`);
  }
  assert.deepEqual(lv('Director of Data Science & Analytics', '5+ years of experience in data science'), ['director_exec']);
  assert.deepEqual(lv('Lead Security Analyst', '3+ years of security experience'), ['lead_staff']);
  assert.ok(!lv('Senior Leasing Consultant', 'At least 1 year of leasing experience').includes('entry'));
  // A grade still gives way to the years the posting states.
  assert.deepEqual(lv('Engineer III', 'Requirements: 0-2 years of experience in civil design.'), ['entry']);
});

test('years: words about another thing in the sentence do not make the years optional', () => {
  const y = (t: string) => { const r = parseYearsRequired(t); return r ? [r.min, r.max] : null; };
  assert.deepEqual(y("- 1+ years' experience in a customer service position, preferably in hospitality or coffee"), [1, null]);
  assert.deepEqual(y('- 3-4 years of sales experience (equipment sales experience is a plus)'), [3, 4]);
  assert.deepEqual(y('- 2+ year of sales experience, preferably selling a technical product'), [2, null]);
  assert.equal(y('- 3+ years of Kafka experience (nice to have)'), null);
  assert.equal(y('- 1 year of office experience preferred'), null);
});
