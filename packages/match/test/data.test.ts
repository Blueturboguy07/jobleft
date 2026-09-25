// The dictionaries: no word maps to two different skills, every name they use exists, and non-tech work is covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize } from '../src/text.ts';
import { CONTEXT_RULES, DATA_DIR, FAMILIES, SKILLS, familyOfTitle, industryOfName, matchSkillDictionary, taxonomyStats } from '../src/taxonomy.ts';

function rows(file: string): string[][] {
  return readFileSync(join(DATA_DIR, file), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split('|').map((c) => c.trim()));
}

test('every data file names its source and licence', () => {
  for (const f of ['skills.tsv', 'credentials.tsv', 'occupations.tsv', 'industries.tsv']) {
    const head = readFileSync(join(DATA_DIR, f), 'utf8').split('\n').slice(0, 6).join('\n');
    assert.match(head, /Source:/, f);
    assert.match(head, /Licence:/, f);
  }
});

test('no alias maps to two different skills or credentials; every family and context exists', () => {
  const seen = new Map<string, string>();
  for (const file of ['skills.tsv', 'credentials.tsv']) {
    for (const [id, , , fams, aliases] of rows(file)) {
      for (const f of fams.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!f.startsWith('@') && f !== '*') assert.ok(FAMILIES.has(f), `${id}: unknown family ${f}`);
      }
      for (const a0 of aliases.split(',').map((x) => x.trim()).filter(Boolean)) {
        let a = a0;
        const cs = a.startsWith('=');
        if (cs) a = a.slice(1);
        const at = a.lastIndexOf('@');
        const ctx = at > 0 ? a.slice(at + 1) : '';
        if (at > 0) a = a.slice(0, at);
        if (ctx) assert.ok(CONTEXT_RULES[ctx], `${id}: unknown context @${ctx}`);
        const key = tokenize(a).map((t) => (cs ? t.raw : t.norm)).join(' ') + (cs ? '#cs' : '') + ctx;
        const prev = seen.get(key);
        assert.ok(!prev || prev === id, `alias "${a0}" is both ${prev} and ${id}`);
        seen.set(key, id);
      }
    }
  }
});

test('no title phrase names two kinds of work', () => {
  const seen = new Map<string, string>();
  for (const f of FAMILIES.values()) {
    for (const p of f.phrases) {
      const k = p.words.join(' ') + (p.head ? '$' : '');
      const prev = seen.get(k);
      assert.ok(!prev || prev === f.id, `title phrase "${p.text}" is both ${prev} and ${f.id}`);
      seen.set(k, f.id);
    }
  }
});

test('the dictionaries cover non-tech work as well as tech', () => {
  const stats = taxonomyStats();
  assert.ok(stats.skills >= 450, `skills: ${stats.skills}`);
  assert.ok(stats.credentials >= 80, `credentials: ${stats.credentials}`);
  assert.ok(stats.nonTechSkills >= 300, `non-tech skills: ${stats.nonTechSkills}`);
  const perFamily = (fam: string) => [...SKILLS.values()].filter((s) => s.families?.has(fam)).length;
  for (const [fam, min] of [['nursing', 40], ['teaching', 25], ['accounting', 30], ['trades_electrical', 15], ['logistics', 25], ['retail', 15], ['food', 12], ['sales', 12], ['construction', 15]] as const) {
    assert.ok(perFamily(fam) >= min, `${fam}: ${perFamily(fam)} skills`);
  }
});

test('titles are read for their kind of work, head noun first', () => {
  const cases: Array<[string, string | null]> = [
    ['Senior Software Engineer', 'software'], ['Sales Engineer', 'sales_eng'], ['Registered Nurse - ICU', 'nursing'],
    ['Nurse Recruiter', 'hr'], ['Server', 'food'], ['Server Engineer', null], ['Cook II', 'food'], ['Staff Accountant', 'accounting'],
    ['Store Manager', 'retail'], ['Journeyman Electrician', 'trades_electrical'], ['Principal Consultant', null],
    ['Assistant Principal', 'teaching'], ['Line Cook, Full-Time', 'food'], ['UI/UX Designer', 'design'], ['FP&A Analyst', 'finance'],
    ['Class A CDL Driver - Regional', 'driving'], ['Shipping & Receiving Lead', 'logistics'], ['Therapist', 'counseling'],
  ];
  for (const [title, fam] of cases) assert.equal(familyOfTitle(title)?.family ?? null, fam, title);
});

test('employer names name their industry from the word nearest the end', () => {
  assert.equal(industryOfName("St. Mary's Medical Center")?.industry, 'healthcare');
  assert.equal(industryOfName('Austin ISD')?.industry, 'education');
  assert.equal(industryOfName('Texas Tech University')?.industry, 'education');
  assert.equal(industryOfName('Capital Area Food Bank')?.industry, 'nonprofit');
  assert.equal(industryOfName('Northwind Sample Labs')?.industry, 'software');
  assert.equal(industryOfName('Jordan Testwell'), null);
});

test('the SkillDictionary shape: short forms resolve, look-alike names never do', () => {
  const d = matchSkillDictionary;
  assert.equal(d.canonical('k8s'), 'Kubernetes');
  assert.equal(d.canonical('JS'), 'JavaScript');
  assert.equal(d.canonical('golang'), 'Go');
  assert.deepEqual(d.extract('We use JavaScript and TypeScript.'), ['JavaScript', 'TypeScript']);
  assert.ok(!d.extract('We use JavaScript.').includes('Java'));
  assert.ok(!d.extract('C++ and C# developers wanted.').includes('C'));
  assert.deepEqual(d.extract('Plan C. Vitamin C. C-suite.'), []);
  assert.ok(!d.extract('Must be able to react quickly and excel at customer service.').includes('React'));
  assert.ok(!d.extract('Must be able to react quickly and excel at customer service.').includes('Excel'));
  assert.ok(!d.extract('AWS D1.1 certified welder').includes('AWS'));
  assert.ok(d.extract('Strong Go, Rust and Python skills').includes('Go'));
});
