import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPay, parseNumber, parsePay, payFromBoard, payMeetsMinimum, paySortKey } from '../src/index.ts';

type Want = [number | null, number | null, string, string] | null;
function check(text: string, want: Want, opts: Parameters<typeof parsePay>[1] = {}) {
  const r = parsePay(text, opts);
  const got = r ? [r.pay.min, r.pay.max, r.pay.currency, r.pay.period] : null;
  assert.deepEqual(got, want, text);
}

test('pay: numbers in every common spelling', () => {
  assert.equal(parseNumber('60,000'), 60000);
  assert.equal(parseNumber('60.000'), 60000);
  assert.equal(parseNumber('60 000'), 60000);
  assert.equal(parseNumber("60'000"), 60000);
  assert.equal(parseNumber('1,20,000'), 120000);
  assert.equal(parseNumber('18.50'), 18.5);
  assert.equal(parseNumber('18,50'), 18.5);
  assert.equal(parseNumber('60.000,00'), 60000);
  assert.equal(parseNumber('1,234.56'), 1234.56);
});

test('pay: ranges and single figures, yearly and hourly (O2)', () => {
  check('The base salary range is $120,000 - $150,000 per year.', [120000, 150000, 'USD', 'year']);
  check('Compensation: $150K-$200K', [150000, 200000, 'USD', 'year']);
  check('Salary: $120-150k', [120000, 150000, 'USD', 'year']);
  check('Pay: $25 - $32 per hour', [25, 32, 'USD', 'hour']);
  check('$25 - $32 per hour', [25, 32, 'USD', 'hour']);
  check('Pay rate: $18.00/hr', [18, 18, 'USD', 'hour']);
  check('Salary: $85,000', [85000, 85000, 'USD', 'year']);
  check('Pay: $18.00 Hourly', [18, 18, 'USD', 'hour']);
  check('Travel RN: $2,450/week', [2450, 2450, 'USD', 'week']);
  check('Base salary of $3,800 monthly', [3800, 3800, 'USD', 'month']);
  check('Hourly: $20-$35 | Start: ASAP', [20, 35, 'USD', 'hour']);
  check('The base salary offered will begin at $130,000 and go up to $250,000.', [130000, 250000, 'USD', 'year']);
  check('- Comp range of $(76,000-$107,000)', [76000, 107000, 'USD', 'year']);
});

test('pay: "up to" keeps no minimum, "from" keeps no maximum, one figure is never a range (O2 angle 3)', () => {
  check('Salary: Up to $150,000 per year', [null, 150000, 'USD', 'year']);
  check('Pay rate: Up to $16.00/hr', [null, 16, 'USD', 'hour']);
  check('Starting pay $16.04/hr.', [16.04, null, 'USD', 'hour']);
  check('Competitive compensation $130,000+, based on productivity', [130000, null, 'USD', 'year']);
  check('Compensation range up to $95,000-$130,000', [95000, 130000, 'USD', 'year']);
});

test('pay: other currencies and number styles (O2 angle 2)', () => {
  check('Salary: €60.000 per year', [60000, 60000, 'EUR', 'year']);
  check('Gehalt: 60.000 € brutto jährlich', [60000, 60000, 'EUR', 'year']);
  check('Rémunération : 66 000€ à 75 000€ brut annuel (fixe) + 10 000€ de variable', [66000, 75000, 'EUR', 'year']);
  check('Salary range: € 5600 - 8400 gross / month', [5600, 8400, 'EUR', 'month']);
  check('Salary: £40,000 – £50,000', [40000, 50000, 'GBP', 'year']);
  check('Pay: £14.30per hour', [14.3, 14.3, 'GBP', 'hour']);
  check('Compensation is CAD $70,000 to $85,000 annually', [70000, 85000, 'CAD', 'year']);
  check('Salary: $80,000 - $95,000', [80000, 95000, 'CAD', 'year'], { country: 'CA' });
  check('Gross annual salary range: 48k - 60k', [48000, 60000, 'EUR', 'year'], { country: 'FR' });
  check('Salario: $15 - $18 por hora', [15, 18, 'USD', 'hour']);
  check('* Sueldo base $16,000 mensuales brutos', [16000, 16000, 'MXN', 'month'], { country: 'MX' });
  check('- 時給: 1,110円', [1110, 1110, 'JPY', 'hour']);
});

test('pay: never reads bonuses, benefits, company money or codes (O4)', () => {
  check('$5,000 sign-on bonus', null);
  check('Competitive salary and a $2,000 learning stipend', null);
  check('We raised $150M from top investors. $10B in yearly revenue.', null);
  check('401(k) match up to 6%. Req 120000. Suite 200, 94105', null);
  check('- Full benefits package: health, dental, vision, life, 401k (with match)', null, { country: 'US' });
  check('Fertility HRA (up to $10,000 per year)', null);
  check('Up to $5,250/year in tuition reimbursement', null);
  check('Annual learning & development stipend (€1,400 per year)', null);
  check('Sign up and get $5 to $50 in credit', null);
  check('Requires $3 - 5 years of experience', null);
  check('The national average salary for nurses is $80,000 per year.', null);
  check('Call us at 555-123-4567. Job ID 48213.', null);
  check('$150 per diem for travel', null);
  check('Full-Time or Part Time · Hourly (W-2) · On-Site', null, { country: 'US' });
  check('COVID-19 vaccination required. I-9 on day one.', null, { country: 'US' });
});

test('pay: base pay, not the add-on, the differential or the OTE (O10 angles 1 and 2)', () => {
  check('$48/hr plus a $4/hr night differential', [48, 48, 'USD', 'hour']);
  check('$60K base, $120K OTE', [60000, 60000, 'USD', 'year']);
  check('Uncapped Compensation range $80,640 -$116,520+ Annual Bonus up to $8K', [80640, 116520, 'USD', 'year']);
  check('Salary £60,000-£75,000 + Bonus 10% + Corporate bonus', [60000, 75000, 'GBP', 'year']);
  check('For this position, we offer a total compensation package of $66,123 per year, including a base pay of $28.90 per hour.', [28.9, 28.9, 'USD', 'hour']);
  check('$85K–$115K base salary plus $30/hr for every billable hour over 100/month.', [85000, 115000, 'USD', 'year']);
  check('Per Diem RN - $55/hr', [55, 55, 'USD', 'hour']);
  check('Server - $2.13/hr plus tips', [2.13, 2.13, 'USD', 'hour']);
});

test('pay: an estimate by the employer is stated pay; nothing is invented from words (O3)', () => {
  check('The salary range for this position is estimated to be $28/hour to $47/hour.', [28, 47, 'USD', 'hour']);
  check('Competitive salary', null);
  check('Top-of-market pay and great benefits.', null);
  check('Salary: DOE', null);
  check('Salary: $ - $', null);
  check('Pay: $0', null);
});

test('pay: tiers by city keep one stated tier and say how many there are (O2 angle 4)', () => {
  const r = parsePay('US Zone 1: $188,400 - $235,500\nUS Zone 2: $169,560 - $211,950\nUS Zone 3: $150,720 - $188,400', {})
    ?? parsePay('Pay range\nUS Zone 1: $188,400 - $235,500\nUS Zone 2: $169,560 - $211,950');
  assert.ok(r);
  assert.equal(r.pay.min, 188400);
  assert.ok(r.pay.ranges >= 2);
  const t = 'Our cash compensation is $69,000/yearly - $85,000/yearly in Phoenix and $74,245/yearly - $91,000/yearly in Denver, Chicago and Las Vegas.';
  const denver = parsePay(t, { placeWords: ['Denver'] });
  assert.deepEqual([denver?.pay.min, denver?.pay.max, denver?.pay.ranges], [74245, 91000, 2]);
  const first = parsePay(t);
  assert.deepEqual([first?.pay.min, first?.pay.max], [69000, 85000]);
});

test('pay: a "similar jobs" block on a pasted page is never read (O4 angle 4)', () => {
  const text = 'Barista\nWe are hiring a barista for our cafe. Great team, flexible hours and free coffee every day. Apply today and join us.\n\nSimilar jobs\nShift Supervisor - $22/hr\nStore Manager - $65,000 per year';
  assert.equal(parsePay(text), null);
});

test('pay: board fields, periods from the text, zero means not set', () => {
  assert.equal(payFromBoard([{ min: 1800, max: 2200, currency: 'USD', period: null }]), null, 'no period and a size that fits neither hour nor year');
  const monthly = payFromBoard([{ min: 1800, max: 2200, currency: 'USD', period: null }], { text: 'Pay: $1,800 - $2,200 per month' });
  assert.equal(monthly?.pay.period, 'month', 'the period the text states for the same numbers');
  assert.equal(payFromBoard([{ min: 0, max: 0, currency: 'USD', period: 'year' }]), null);
  const h = payFromBoard([{ min: 18, max: 22, currency: 'USD', period: null }]);
  assert.deepEqual([h?.pay.min, h?.pay.max, h?.pay.period, h?.pay.source], [18, 22, 'hour', 'board_field']);
  const tiers = payFromBoard([{ min: 100000, max: 120000, currency: 'USD', period: 'year', label: 'Zone A' }, { min: 90000, max: 110000, currency: 'USD', period: 'year', label: 'Zone B' }]);
  assert.equal(tiers?.pay.ranges, 2);
});

test('pay: filter and sort rule uses yearly figures, the top of the range, and one currency (O12)', () => {
  const hourly = parsePay('Pay: $50/hr')!.pay;
  assert.equal(payMeetsMinimum(hourly, 90000), true, '$50/hr is about $104K a year');
  const range = parsePay('Salary: $88,000 - $122,000 per year')!.pay;
  assert.equal(payMeetsMinimum(range, 100000), true, 'the top of the range is checked');
  assert.equal(payMeetsMinimum(null, 100000), null, 'unknown pay is unknown, not a fail');
  assert.equal(payMeetsMinimum(parsePay('Salary: €60.000 per year')!.pay, 50000), null, 'another currency is unknown');
  assert.equal(paySortKey(hourly), 104000);
  assert.equal(formatPay(parsePay('$25 - $32 per hour')!.pay), '$25/hr - $32/hr');
  assert.equal(formatPay(parsePay('Salary: Up to $150,000 per year')!.pay), 'Up to $150K/yr');
  assert.equal(formatPay(null), null);
});

// Gate 1 (single builder): the evaluator's repro. Public wage records, prevailing wages and third-party averages
// are never this job's pay.
test('pay (O3): wage records, prevailing wages and third-party averages are not the job\'s pay', () => {
  const texts = [
    'Public H-1B wage records for this employer show base salaries of $120,000 - $150,000 for this title.',
    'Department of Labor prevailing wage for this occupation: $98,500 per year.',
    'Employees in this role earn an average of $77,000 per year according to PayScale.',
    'Similar positions at other companies pay $62,700 - $79,400 per year.',
    'Comparable roles in the market typically pay between $95,000 and $120,000.',
    'LCA disclosure data lists $60,000 - $80,000 for this job title.',
    'People in this job usually make $95K-$120K according to Comparably.',
  ];
  for (const t of texts) assert.equal(parsePay(t)?.pay ?? null, null, t);
  assert.equal(parsePay('The base salary range for this role is $120,000 - $150,000 per year.')?.pay?.min, 120000, 'the job\'s own stated range still reads');
});
