// Regression tests for the tracker tester's findings: skills a posting never names in the job sense (JL-tracker-5),
// and a required-skill count that did not match the list shown (JL-tracker-4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { job, profileOf, score } from './helpers.ts';

const ANALYST = profileOf({
  work: [{ company: 'Northwind Analytics', title: 'Data Analyst', startDate: '2021-01', endDate: 'present', bullets: ['Wrote SQL for weekly reports.'] }],
  skills: ['SQL'],
});
const data = (title: string, lines: string) => job({ title, company: 'Woodgrove', location: 'Austin, TX', description: `We build data products.\n\nRequirements\n${lines}` });

test('posting words that are not skills in this job are not read as skills (JL-tracker-5)', () => {
  const cases: Array<[string, string, string]> = [
    ['Manager, Data & Analytics', '- 6+ years in analytics engineering, with technical depth in SQL, DBT, and a modern cloud data warehouse (Snowflake or BigQuery).', 'Dialectical behavior therapy'],
    ['Data Science Intern', '- Own a project end-to-end: from framing the question and methodology to translating findings into insights.', 'Carpentry'],
    ['Staff Data Engineer', '- Comfortable translating ambiguous business questions into concrete metric definitions.', 'Concrete work'],
    ['Senior Data Analyst', '- Proven ability to drive alignment across diverse, senior stakeholders.', 'Automotive repair'],
    ['Data Analyst', '- Self-starter mindset: takes initiative and gathers requirements without being asked.', 'Motor controls'],
    ['Data Engineer', '- Python and SQL\n\nUS Applicants: View Employee Rights, Know Your Rights, and E-Verify Notice of Participation.', 'Employment law'],
    ['Data Engineer', '- Python and SQL\n- Write custom integration scripts', 'Customs and trade compliance'],
  ];
  for (const [title, lines, wrong] of cases) {
    const r = score(ANALYST, data(title, lines));
    const named = [...r.skills.required, ...r.skills.preferred];
    assert.ok(!named.includes(wrong), `${title}: "${wrong}" read from ${JSON.stringify(lines)}: ${JSON.stringify(named)}`);
    assert.ok(!r.skillDetail.some((c) => c.name === wrong));
  }
  // The data tool dbt is still read, in either case.
  assert.ok(score(ANALYST, data('Analytics Engineer', '- Technical depth in SQL, DBT, and a modern cloud data warehouse')).skills.required.includes('dbt'));
  // The same words where they are the skill still count.
  const trades = (title: string, lines: string) => job({ title, company: 'Contoso Builders', location: 'Austin, TX', description: `We build homes.\n\nRequirements\n${lines}` });
  assert.ok(score(ANALYST, trades('Carpenter', '- 3+ years of rough framing and finish carpentry on residential construction sites')).skills.required.includes('Carpentry'));
  assert.ok(score(ANALYST, trades('Concrete Finisher', '- Pour and finish concrete slabs and sidewalks')).skills.required.includes('Concrete work'));
  assert.ok(score(ANALYST, trades('Automotive Technician', '- Perform brake jobs, wheel alignments and tire rotations on customer vehicles')).skills.required.includes('Automotive repair'));
  const dbtTherapist = job({ title: 'Licensed Therapist', company: 'Contoso Health', location: 'Austin, TX', description: 'We treat anxiety and trauma.\n\nRequirements\n- Training in evidence-based modalities such as DBT and CBT for clinical treatment' });
  assert.ok(score(ANALYST, dbtTherapist).skills.required.includes('Dialectical behavior therapy'));
});

test('the required-skill sentence counts exactly the skills the list shows (JL-tracker-4)', () => {
  const j = data('Data Analyst', '- Statistics\n- Data analysis\n\nPreferred\n- Python\n- Tableau\n\nWhat you will do\nYou will build ETL pipelines in Apache Spark and share data visualization with SQL.');
  const r = score(ANALYST, j);
  const req = r.subScores.skills.reasons.find((x) => x.code === 'skills_required')!;
  const n = Number(/of the (\d+) skills/.exec(req.text)?.[1]);
  assert.equal(n, r.skills.required.length, req.text);
  assert.match(req.text, /2 in its requirement list, \d+ named elsewhere in it/);
  const met = r.skills.required.filter((x) => r.skills.matched.includes(x));
  assert.match(req.text, new RegExp(`^You have ${met.length} of`));
  // Only preferred skills are listed again as "You also have".
  const also = r.subScores.skills.reasons.find((x) => x.code === 'skills_matched');
  assert.ok(!also || !/mentioned/.test(also.text), also?.text);
  // A plain requirement list keeps the plain sentence.
  const plain = score(ANALYST, data('Data Analyst', '- SQL'));
  assert.equal(plain.subScores.skills.reasons.find((x) => x.code === 'skills_required')!.text, 'You have 1 of the 1 skill or credential the posting lists as required: SQL.');
});

test('Experience Level quotes the title, the department or the years line as they are, never a random line (JL-tracker-16)', () => {
  const posting = 'Benefits\n- 16 hours of paid volunteer time per year — give back to the community you call home\n\nRequirements\n- 4+ years of experience focused on data analysis\n- SQL and Tableau';
  // A level the crawler read from the years, with the evidence its old line finder picked.
  const j = { ...job({ title: 'Financial Data Analyst', description: posting, department: 'Financial Analytics' }), level: 'mid' as const, evidence: { level: { source: 'description' as const, text: '- 16 hours of paid volunteer time per year — give back to the community you call home' } } };
  const r = score(ANALYST, j);
  const texts = r.subScores.experienceLevel.reasons.map((x) => x.text);
  for (const t of texts) {
    const m = /\(title "([^"]*)"/.exec(t);
    if (m) assert.equal(m[1], 'Financial Data Analyst', t);
    assert.doesNotMatch(t, /volunteer/, t);
  }
  assert.equal(r.jobFacts.level.text, 'Mid Level (from the years it asks for)');
  assert.match(r.jobFacts.level.quote ?? '', /4\+ years of experience focused on data analysis/);

  // The kind of work: the title as written (not a re-worded phrase) ...
  const dd = score(ANALYST, job({ title: 'Manager, Data & Analytics, In-Store', description: 'Requirements\n- 6+ years of experience in data analytics\n- SQL' }));
  for (const t of dd.subScores.experienceLevel.reasons.map((x) => x.text)) assert.doesNotMatch(t, /manager data and analytic in store/, t);
  // ... and an unrelated department label never outweighs data duties.
  const duties = 'What you will do\n- Build SQL and Python pipelines, dashboards in Tableau and Looker, and data models in Snowflake\n- Run statistical analysis and A/B testing\n\nRequirements\n- 5+ years of data analytics experience with SQL, Python and dbt';
  const rh = score(ANALYST, job({ title: 'Data Solutions & Analytics Senior Analyst', department: '[INACTIVE] Talent Acquisition', description: duties }));
  const kind = rh.subScores.experienceLevel.reasons.map((x) => x.text).join(' ');
  assert.doesNotMatch(kind, /human resources|talent acquisition/i, kind);
  assert.match(kind, /data and analytics work/, kind);
  // A department that fits the duties still names the kind of work, quoted as written.
  const hr = score(ANALYST, job({ title: 'Coordinator', department: 'Talent Acquisition', description: 'What you will do\n- Schedule interviews with candidates and hiring managers in Greenhouse\n- Source candidates' }));
  assert.match(hr.subScores.experienceLevel.reasons.map((x) => x.text).join(' '), /department "Talent Acquisition"/);
});
