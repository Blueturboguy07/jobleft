import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, unescapeEncodedHtml } from '../src/html.ts';
import { levelFromDescription, levelFromTitle } from '../src/level.ts';
import { isUsLocation } from '../src/location.ts';
import { annualize, parsePayFromText } from '../src/pay.ts';

test('pay: annual ranges in the common spellings', () => {
  assert.deepEqual(parsePayFromText('The base salary range is $120,000 - $150,000 per year.'), { min: 120000, max: 150000, currency: 'USD', period: 'year' });
  assert.deepEqual(parsePayFromText('Compensation: $150K-$200K'), { min: 150000, max: 200000, currency: 'USD', period: 'year' });
  assert.deepEqual(parsePayFromText('Pay range: USD 95,000 to 115,000 annually'), { min: 95000, max: 115000, currency: 'USD', period: 'year' });
  assert.deepEqual(parsePayFromText('Salary: £40,000 – £50,000'), { min: 40000, max: 50000, currency: 'GBP', period: 'year' });
});

test('pay: hourly ranges, with the period stated or with a pay cue', () => {
  assert.deepEqual(parsePayFromText('The hourly rate is $18.50 - $22.00 per hour'), { min: 18.5, max: 22, currency: 'USD', period: 'hour' });
  assert.deepEqual(parsePayFromText('Pay: $45-$55/hr plus shift differential'), { min: 45, max: 55, currency: 'USD', period: 'hour' });
  assert.deepEqual(parsePayFromText('Hourly pay range $20 to $28'), { min: 20, max: 28, currency: 'USD', period: 'hour' });
});

test('pay: refuses things that are not pay (funding, years, percentages, wide ranges, no cue)', () => {
  assert.equal(parsePayFromText('We raised $10 to 15 million in funding'), null);
  assert.equal(parsePayFromText('Requires $3 - 5 years of experience'), null);
  assert.equal(parsePayFromText('Sign up and get $5 to $50 in credit'), null);
  assert.equal(parsePayFromText('Bonus of $20 to $30 for referrals'), null, 'no pay cue and no period: too risky');
  assert.equal(parsePayFromText('Salary $10 to $900 per year'), null, 'range wider than 5x');
  assert.equal(parsePayFromText(''), null);
});

test('pay: with several ranges (tiers) the one after a pay cue wins over an earlier bare one', () => {
  const p = parsePayFromText('Our office snack budget is $100,000 - $120,000 per year for the whole team. Base pay range: $70,000 - $90,000 per year.');
  assert.deepEqual(p, { min: 70000, max: 90000, currency: 'USD', period: 'year' });
});

test('pay: annualize converts hourly, monthly, weekly and daily', () => {
  assert.equal(annualize(20, 'hour'), 41600);
  assert.equal(annualize(5000, 'month'), 60000);
  assert.equal(annualize(1000, 'week'), 52000);
  assert.equal(annualize(200, 'day'), 52000);
  assert.equal(annualize(null, 'year'), null);
});

test('level: generic titles, senior-most marker wins', () => {
  const cases: Array<[string, string | null]> = [
    ['Software Engineering Intern', 'intern'], ['Associate Director of Finance', 'director'], ['Assistant Store Manager', 'manager'],
    ['Sales Associate', 'entry'], ['Senior Accountant', 'senior'], ['Staff Software Engineer', 'staff'], ['Principal Consultant', 'principal'],
    ['Vice President, Lending', 'vp'], ['Chief Nursing Officer', 'exec'], ['Head of Marketing', 'director'], ['Shift Supervisor', 'lead'],
    ['Registered Nurse II', 'mid'], ['Registered Nurse III', 'senior'], ['Registered Nurse I', 'entry'], ['Staff Nurse', null], ['Cashier', null],
    ['Junior Designer', 'entry'], ['Team Lead, Support', 'lead'],
  ];
  for (const [t, want] of cases) assert.equal(levelFromTitle(t), want, t);
});

test('level: description fallback reads years of experience, and is weak on purpose', () => {
  assert.equal(levelFromDescription('You bring 7+ years of relevant experience'), 'senior');
  assert.equal(levelFromDescription('at least 2 years experience in retail'), 'mid');
  assert.equal(levelFromDescription('1 year of experience'), 'entry');
  assert.equal(levelFromDescription('no experience needed'), null);
});

test('location: US detection by state code, state name, country words, and a standalone US token', () => {
  const yes = ['Austin, TX', 'New York, NY 10001', 'San Francisco, California', 'Remote - US', 'United States', 'Remote, USA', 'Chicago, IL; Denver, CO', 'Boston, MA (Hybrid)'];
  for (const l of yes) assert.equal(isUsLocation(l), true, l);
  const no = ['London, UK', 'Toronto, ON, Canada', 'Berlin, Germany', 'Sydney, Australia'];
  for (const l of no) assert.equal(isUsLocation(l), false, l);
  assert.equal(isUsLocation('Remote'), null);
  assert.equal(isUsLocation(''), null);
});

test('location: an API country code beats the text, and Canadian "CA" is not California', () => {
  assert.equal(isUsLocation('Remote', ['US']), true);
  assert.equal(isUsLocation('Austin, TX', ['GB']), false);
  assert.equal(isUsLocation('Vancouver, BC, CA'), false);
});

test('html: block tags become lines, list items bullets, entities decode, scripts vanish', () => {
  const t = htmlToText('<h2>About</h2><p>We&rsquo;re hiring&nbsp;now &amp; growing.</p><ul><li>One</li><li>Two</li></ul><script>alert(1)</script><br>End');
  assert.equal(t, "About\n\nWe're hiring now & growing.\n\n- One\n- Two\n\nEnd");
});

test('html: entity-encoded markup is decoded only when encoded tags outnumber live ones', () => {
  assert.equal(unescapeEncodedHtml('&lt;p&gt;Role&lt;/p&gt;'), '<p>Role</p>');
  const keep = '<p>Use the &lt;div&gt; tag</p>';
  assert.equal(unescapeEncodedHtml(keep), keep);
  assert.equal(htmlToText(''), '');
});

test('pay: a period may sit between the two numbers, and "USD $" is a currency marker', () => {
  assert.deepEqual(parsePayFromText('The salary range for this position is estimated to be $28/hour to $47/hour.'), { min: 28, max: 47, currency: 'USD', period: 'hour' });
  assert.deepEqual(parsePayFromText('Base pay: USD $120,000 - $150,000 per year'), { min: 120000, max: 150000, currency: 'USD', period: 'year' });
  assert.deepEqual(parsePayFromText('Compensation is CAD $70,000 to $85,000 annually'), { min: 70000, max: 85000, currency: 'CAD', period: 'year' });
});
