import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, PaySchema, PlaceSchema, JobEvidenceSchema, PostingStatementsSchema } from '@jobleft/contracts';
import { extractFacts, fromAshby, fromGreenhouse, fromJsonLd, fromLever, fromRecruitee, fromWorkable, postingsFromBoard } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');

test('facts: a posting that states nothing reads as unknown everywhere (O1)', () => {
  const f = extractFacts({ title: 'Team Member', description: 'Join our friendly team. Apply today!' });
  assert.equal(f.pay, null);
  assert.deepEqual(f.places, []);
  assert.equal(f.isUs, null);
  assert.equal(f.workModel, null);
  assert.equal(f.remoteScope, null);
  assert.equal(f.yearsRequired, null);
  assert.deepEqual(f.statements, { sponsorship: null, clearanceRequired: null, usCitizenOnly: null });
});

test('facts: every fact carries evidence that holds it, in contract shapes (O14)', () => {
  const f = extractFacts(fromGreenhouse({
    id: 1, title: 'Senior Data Analyst', absolute_url: 'https://example.com/1', location: { name: 'Denver, CO' },
    content: '&lt;p&gt;This is a hybrid role, 2 days a week in our Denver office.&lt;/p&gt;&lt;p&gt;5+ years of analytics experience.&lt;/p&gt;&lt;p&gt;The salary range is $110,000 - $130,000 per year.&lt;/p&gt;',
  }));
  assert.ok(validate(PaySchema, f.pay).ok);
  for (const p of f.places) assert.ok(validate(PlaceSchema, p).ok);
  assert.ok(validate(JobEvidenceSchema, f.evidence).ok);
  assert.ok(validate(PostingStatementsSchema, f.statements).ok);
  assert.match(f.evidence.pay!.text, /\$110,000 - \$130,000/);
  assert.match(f.evidence.workModel!.text, /hybrid/i);
  assert.match(f.evidence.years!.text, /5\+ years/);
  assert.match(f.evidence.places!.text, /Denver/);
  assert.deepEqual(f.levels, ['senior']);
  assert.equal(f.workModel, 'hybrid');
});

test('facts: board formats (Lever, Ashby, Workable, Recruitee, JSON-LD) read their own fields', () => {
  const lever = extractFacts(fromLever({
    id: 'a', text: 'Barista', hostedUrl: 'https://example.com/a', categories: { location: 'Austin, TX', allLocations: ['Austin, TX', 'Dallas, TX'], commitment: 'Part-time' },
    workplaceType: 'on-site', country: 'US', descriptionPlain: 'Make coffee.', salaryRange: { min: 17, max: 19, currency: 'USD', interval: 'per-hour-wage' },
  }));
  assert.deepEqual([lever.pay?.min, lever.pay?.max, lever.pay?.period, lever.pay?.source], [17, 19, 'hour', 'board_field']);
  assert.equal(lever.places.length, 2);
  assert.equal(lever.workModel, 'onsite');
  assert.equal(lever.employmentType, 'part_time');
  const ashby = extractFacts(fromAshby({
    id: 'b', title: 'Engineer', location: 'Remote - US', isRemote: true, workplaceType: 'Remote', descriptionPlain: 'Build things.',
    compensation: { compensationTiers: [{ title: 'Zone A', components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150000, maxValue: 180000 }] }, { title: 'Zone B', components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 130000, maxValue: 160000 }, { compensationType: 'Bonus', interval: '1 YEAR', minValue: 10000, maxValue: 20000 }] }] },
  }));
  assert.deepEqual([ashby.pay?.min, ashby.pay?.ranges, ashby.workModel, ashby.isUs], [150000, 2, 'remote', true]);
  const workable = extractFacts(fromWorkable({ title: 'Nurse', shortcode: 'X1', location: { city: 'Toronto', region: 'Ontario', country: 'Canada', countryCode: 'CA' }, workplace: 'on_site', description: '<p>Care for patients.</p>' }));
  assert.deepEqual([workable.places[0]?.country, workable.isUs, workable.workModel], ['CA', false, 'onsite']);
  const recruitee = extractFacts(fromRecruitee({ title: 'Cook', city: 'Berlin', country_code: 'DE', remote: false, on_site: true, description: '<p>Kochen.</p>', salary: { min: 2800, max: 3200, currency: 'EUR', period: 'month' } }));
  assert.deepEqual([recruitee.pay?.currency, recruitee.pay?.period, recruitee.isUs], ['EUR', 'month', false]);
  const ld = extractFacts(fromJsonLd({
    '@type': 'JobPosting', title: 'Welder', description: '<p>Weld.</p>', datePosted: '2026-09-01', hiringOrganization: { name: 'Example' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Paris', addressRegion: 'TX', addressCountry: 'US' } },
    baseSalary: { currency: 'USD', value: { minValue: 22, maxValue: 28, unitText: 'HOUR' } },
    estimatedSalary: { currency: 'USD', value: { minValue: 90, maxValue: 99, unitText: 'HOUR' } },
  }));
  assert.deepEqual([ld.pay?.min, ld.pay?.max, ld.pay?.period, ld.places[0]?.region, ld.isUs], [22, 28, 'hour', 'TX', true]);
});

test('facts: the pay tier that names the job\'s state is shown (O2 angle 4)', () => {
  const f = extractFacts({ title: 'Analyst', location: 'Denver, CO', description: 'Hiring Compensation Range: $129,000 - $173,500\nColorado Hiring Compensation Range: $139,000 - $173,500' });
  assert.deepEqual([f.pay?.min, f.pay?.max, f.pay?.ranges], [139000, 173500, 2]);
});

test('facts: text pay wins over a board field that says something else, and the hint stays', () => {
  const f = extractFacts({ title: 'Therapist', description: 'Compensation range $146k - $193k, based on productivity.', pay: [{ min: 90000, max: 140000, currency: 'USD', period: 'year' }] });
  assert.deepEqual([f.pay?.min, f.pay?.max, f.pay?.ranges], [146000, 193000, 2]);
  assert.match(f.evidence.pay!.text, /board/);
});

test('facts: 100 postings with 20 hard ones: every one returns, none throws, order does not matter (O11)', () => {
  const hard: unknown[] = [
    { id: 1, title: '' }, { id: 2, title: 'x'.repeat(5000) }, { id: 3, title: 'Enfermera', content: '<p>Salario: $20 - $25 por hora. Ubicación: Houston, TX.</p>' },
    { id: 4, title: 'Cook', location: { name: '???' }, content: '$$$ 1,2,3,,, 99999999999 %%% ¥¥ €€ ££' },
    { id: 5, title: 'Driver', location: null, content: null }, { id: 6, title: 'Clerk', content: '<p>' + 'Pay $'.repeat(20000) + '</p>' },
    { id: 7, title: 'Teacher', location: { name: 'Springfield' }, content: '\u0000\u0001￿\uD800 odd bytes' },
    { id: 8, title: 'Nurse', content: 'A'.repeat(300000) + ' Pay: $40/hr' }, { id: 9, title: '🙂🙂🙂', content: '🚀 Pay: 🚀 $' },
    { id: 10, title: 'Analyst', location: { name: 'Remote - 🌍' }, content: '<script>alert(1)</script>' },
    { id: 11, title: 'Técnico', content: 'Sueldo: 15.000 MXN mensuales' }, { id: 12, title: '<b>Bold</b>', content: '&lt;&lt;&lt;' },
    { id: 13, title: 'Agent', content: '1'.repeat(10000) }, { id: 14, title: 'Aide', location: { name: ',,,;;;///' } },
    { id: 15, title: 'Porter', content: '<div>'.repeat(5000) }, { id: 16, title: 'Guard', pay_input_ranges: [{ min_cents: 'abc', max_cents: null }] },
    { id: 17, title: 'Chef', pay_input_ranges: [{ min_cents: -5, max_cents: 1e15, currency_type: 'ZZZ' }] },
    { id: 18, title: 'Maid', metadata: [{ name: 'Workplace Type', value: ['Remote', 'Hybrid'] }] },
    { id: 19, title: 'Tech', location: { name: 'a'.repeat(10000) } }, { id: 20, title: 'Sales', content: '$1 - $999999999 per year' },
  ];
  const easy = Array.from({ length: 80 }, (_, i) => ({ id: 100 + i, title: `Cashier ${i}`, absolute_url: `https://example.com/${i}`, location: { name: 'Austin, TX' }, content: '<p>Pay: $15/hr</p>' }));
  for (const order of [[...hard, ...easy], [...easy, ...hard]]) {
    const posts = postingsFromBoard({ jobs: order }, 'greenhouse');
    assert.equal(posts.length, 100);
    const facts = posts.map((p) => extractFacts(p.input));
    assert.equal(facts.length, 100);
    assert.equal(facts.filter((f) => f.pay?.min === 15).length, 80);
  }
  const spanish = extractFacts(postingsFromBoard({ jobs: [hard[2]] }, 'greenhouse')[0].input);
  assert.deepEqual([spanish.pay?.min, spanish.pay?.max, spanish.pay?.period, spanish.places[0]?.city], [20, 25, 'hour', 'Houston']);
});

test('facts: very long postings stay fast and are never cut short (O11, O14)', () => {
  const body = ('We are a growing company with 5,000 employees and $2B in revenue. ' + 'Req 12345. Call 555-0100. ').repeat(20000) + '\nPay range: $30 - $35 per hour';
  const t0 = performance.now();
  const f = extractFacts({ title: 'Warehouse Lead', description: body });
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.equal(f.description.length, body.length);
  assert.deepEqual([f.pay?.min, f.pay?.max], [30, 35]);
});

test('facts: same posting, same facts, and no network is ever used (O13, O15)', () => {
  const input = fromGreenhouse({ id: 9, title: 'Registered Nurse', location: { name: 'Remote - US' }, content: '<p>Fully remote. $45 - $55 per hour. 2+ years of experience.</p>' });
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = () => { throw new Error('network used'); };
  try {
    const a = extractFacts(input), b = extractFacts(input);
    assert.deepEqual(a, b);
    assert.equal(a.workModel, 'remote');
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});

test('cli: reads a board file and a local mock board, and refuses other hosts', async () => {
  const board = join(here, '..', 'examples', 'greenhouse-board.json');
  const file = spawnSync(process.execPath, [cli, 'board', board, '--ndjson'], { encoding: 'utf8' });
  assert.equal(file.status, 0, file.stderr);
  const rows = file.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 8);
  assert.equal(rows.find((r) => r.id === '103').isUs, false);
  const server = createServer((req, res) => {
    if (req.url === '/v1/boards/example/jobs') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jobs: [{ id: 1, title: 'Cashier', absolute_url: 'https://example.com/1', location: { name: 'Paris, TX' }, content: 'Pay: $15/hr' }] })); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const p = spawn(process.execPath, [cli, 'board', `http://127.0.0.1:${port}/v1/boards/example/jobs`, '--ndjson']);
      let so = '';
      p.stdout.on('data', (d: Buffer) => { so += d; });
      p.on('close', (code: number | null) => resolve({ code, stdout: so }));
    });
    assert.equal(out.code, 0);
    const row = JSON.parse(out.stdout.trim());
    assert.deepEqual([row.payText, row.places[0].region, row.isUs], ['$15/hr', 'TX', true]);
  } finally {
    server.close();
  }
  const refused = spawnSync(process.execPath, [cli, 'board', 'https://example.com/jobs.json'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not a loopback host/);
});

test('facts: the crawler RawJob maps in one call', async () => {
  const { fromRawJob } = await import('../src/index.ts');
  const f = extractFacts(fromRawJob({
    title: 'Senior Loan Officer', location: 'Remote - US; Austin, TX', descriptionHtml: '<p>Close loans.</p>', remote: true, workMode: 'remote',
    countries: ['US'], employmentType: 'full_time', pay: { min: 90000, max: 120000, currency: 'USD', period: 'year' },
  }));
  assert.deepEqual([f.pay?.min, f.pay?.source, f.workModel, f.isUs, f.levels[0], f.places.length], [90000, 'board_field', 'remote', true, 'senior', 1]);
});

test('facts: common US-posting languages (Spanish, Portuguese, French, German) keep their facts (O11 angle 4)', () => {
  const row = (title: string, location: string, description: string) => {
    const f = extractFacts({ title, location, description });
    return [f.pay?.min, f.pay?.max, f.pay?.currency, f.pay?.period, f.places[0]?.country, f.workModel];
  };
  assert.deepEqual(row('Enfermera Registrada', 'Miami, FL', 'Salario: $30 a $38 por hora. Modelo híbrido, 2 días a la semana en la oficina.'), [30, 38, 'USD', 'hour', 'US', 'hybrid']);
  assert.deepEqual(row('Développeur Senior (H/F)', 'Paris, France', 'Salaire : 45 - 55 K€ brut annuel. Télétravail partiel possible, 2 jours par semaine au bureau.'), [45000, 55000, 'EUR', 'year', 'FR', 'hybrid']);
  assert.deepEqual(row('Analista de Dados Pleno', 'São Paulo, SP', 'Salário: R$ 8.000 a R$ 10.000 por mês. Trabalho 100% remoto.'), [8000, 10000, 'BRL', 'month', 'BR', 'remote']);
  assert.deepEqual(row('Kundenservice (m/w/d)', 'Berlin', 'Bruttojahresgehalt: 38.000 € - 42.000 €. Hybrides Arbeiten.'), [38000, 42000, 'EUR', 'year', 'DE', 'hybrid']);
  assert.deepEqual(row('Cajero', 'Monterrey, NL, México', 'Sueldo: $9,000 mensuales.'), [9000, 9000, 'MXN', 'month', 'MX', null]);
});

test('facts: pathological inputs stay fast (O11 angle 1)', () => {
  const t0 = performance.now();
  for (const d of ['1 000 '.repeat(30000), '5 years of experience or 3 years '.repeat(3000), '('.repeat(50000) + '$20/hr', '$'.repeat(100000)]) {
    extractFacts({ title: 'x', description: d });
  }
  assert.ok(performance.now() - t0 < 8000);
});

test('facts: malformed input never throws and reads as unknown (O11)', () => {
  const inputs: unknown[] = [undefined, null, 42, 'text', { title: 5, countries: 'US', pay: { min: 1 }, location: ['x'] },
    { title: 'Nurse', pay: [null, 5, { min: 'a', max: {}, currency: 7, period: 'x' }] }, { title: 'x', description: { html: '<p>' } }];
  for (const x of inputs) {
    const f = extractFacts(x as never);
    assert.equal(f.pay, null);
    assert.deepEqual(f.places, []);
  }
});

// Gate 1 (single builder): the evaluator's repro. A location that names only a foreign remote area is not a US job,
// and a board address (the company office) is not a place the job is in.
test('places (O8): a foreign remote area with a US office address is not a US job and gets no office place', () => {
  const ashby = extractFacts(fromAshby({
    id: 'c', title: 'Support Engineer', location: 'Remote - Canada', isRemote: true, workplaceType: 'Remote', descriptionPlain: 'Help customers.',
    address: { postalAddress: { addressLocality: 'New York', addressRegion: 'NY', addressCountry: 'US' } },
  }));
  assert.notEqual(ashby.isUs, true, 'Remote - Canada is not a US job');
  assert.ok(!ashby.places.some((p) => p.city === 'New York'), 'the New York office is not a place of this job');
  const gh = extractFacts(fromGreenhouse({
    id: 9, title: 'Support Engineer', location: { name: 'Remote - Canada' }, offices: [{ name: 'New York' }], content: '<p>Help customers.</p>',
  }));
  assert.notEqual(gh.isUs, true);
  assert.ok(!gh.places.some((p) => p.city === 'New York'));
  const global = extractFacts(fromGreenhouse({
    id: 10, title: 'Support Engineer', location: { name: 'Remote (Global)' }, offices: [{ name: 'San Francisco' }], content: '<p>Help customers.</p>',
  }));
  assert.ok(!global.places.some((p) => p.city === 'San Francisco'), 'a global remote job is not in the San Francisco office');
});
