// Outcomes O1, O2, O4, O5, O6 (see docs/outcomes/match.md): each test follows an adversarial angle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandFor, MatchResultSchema, summarizeMatch, validate } from '@jobleft/contracts';
import { cardText, detailText } from '../src/index.ts';
import { NURSE, NOW, SWE, job, profileOf, quotesOf, score, view } from './helpers.ts';

const swe = profileOf(SWE);
const backend = job({ title: 'Backend Engineer', description: 'We build SaaS software.\n\nRequirements\n- 3+ years of experience\n- TypeScript and Node.js\n- PostgreSQL and AWS\n- Kubernetes is a plus' });
const nurseJob = job({ title: 'Registered Nurse - ICU', description: 'Mercy Valley is a 250-bed hospital.\n\nRequirements\n- Current RN license\n- BLS and ACLS required\n- 2+ years of ICU experience' });

test('O1: the result matches the contract, the band fits the cut-offs, and card, detail and endpoint agree', () => {
  for (const j of [backend, nurseJob]) {
    const r = score(swe, j);
    assert.ok(validate(MatchResultSchema, r).ok, JSON.stringify(validate(MatchResultSchema, r).issues));
    assert.equal(r.band, bandFor(r.percent));
    const card = summarizeMatch(r);
    assert.equal(card.percent, r.percent);
    assert.equal(card.band, r.band);
    assert.match(cardText(r, j), new RegExp(`${r.percent}%`));
    assert.match(detailText(r, j), new RegExp(`${r.percent}%`));
    for (const part of Object.values(r.subScores)) assert.ok(part.reasons.length >= 1);
  }
});

test('O1: two very different jobs never share reason text', () => {
  const a = score(swe, backend);
  const b = score(swe, nurseJob);
  const textsA = new Set([...a.subScores.experienceLevel.reasons, ...a.subScores.skills.reasons].map((x) => x.text));
  for (const x of [...b.subScores.experienceLevel.reasons, ...b.subScores.skills.reasons]) assert.ok(!textsA.has(x.text), x.text);
});

test('O1: every reason names a requirement from the job or a fact from the profile', () => {
  const r = score(swe, backend);
  const skills = r.subScores.skills.reasons.map((x) => x.text).join(' ');
  assert.match(skills, /TypeScript/);
  const exp = r.subScores.experienceLevel.reasons.map((x) => x.text).join(' ');
  assert.match(exp, /3\+ years/);
  assert.match(exp, /Software Engineer/);
});

test('O2: the same question always gets the same answer', () => {
  const a = score(swe, backend);
  const b = score(swe, JSON.parse(JSON.stringify(backend)));
  assert.deepEqual(a, b);
  // Later the same month: identical (years count by the month).
  const c = score(swe, backend, { now: NOW + 3 * 86_400_000 });
  assert.deepEqual(view(c), view(a));
});

test('O2: the same posting from another board, fetched at another time, gets the same score view', () => {
  const other = {
    ...backend, id: 'greenhouse:otherboard:9', url: 'https://boards.example.test/9', canonicalUrl: 'https://boards.example.test/9',
    firstSeenAt: '2026-09-20T00:00:00.000Z', lastSeenAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
    sources: [{ sourceId: 'ats:greenhouse', name: 'Other board', url: 'https://boards.example.test/9', credit: null, firstSeenAt: '2026-09-20T00:00:00.000Z', lastSeenAt: '2026-09-24T00:00:00.000Z' }],
  };
  assert.deepEqual(view(score(swe, other)), view(score(swe, backend)));
});

test('O2: a posting with its fields in another order scores the same', () => {
  const reordered = Object.fromEntries(Object.entries(backend).reverse()) as typeof backend;
  assert.deepEqual(score(swe, reordered), score(swe, backend));
});

const O4_PROFILE = { ...SWE, workAuthorization: { usAuthorized: 'no', needsSponsorship: 'yes', usCitizen: 'no', hasSecurityClearance: 'no' }, preferences: { ...(SWE.preferences as object), workModels: ['remote'] } };
const long = 'We are a growing software company. '.repeat(40);
const o4Jobs = {
  sponsorship: job({ title: 'Software Engineer', description: `${long}\n\nRequirements\n- TypeScript\n\nMust be authorized to work in the US without sponsorship.` }),
  secret: job({ title: 'Software Engineer', description: 'Requirements\n- TypeScript\n- Active Secret clearance required' }),
  rn: job({ title: 'Software Engineer', description: 'Requirements\n- TypeScript\n- RN licence required' }),
  citizens: job({ title: 'Software Engineer', description: 'Requirements\n- TypeScript\n- US citizens only' }),
  chicago: job({ title: 'Software Engineer', location: 'Chicago, IL', description: 'This role is onsite in Chicago.\n\nRequirements\n- TypeScript and React' }),
};

test('O4: each missing must-have or broken deal-breaker is named, quotes the posting, shows on the card, and is never Strong', () => {
  const p = profileOf(O4_PROFILE);
  const expect: Record<string, RegExp> = { sponsorship: /sponsor/i, secret: /Secret clearance/, rn: /RN licence/, citizens: /US citizenship/, chicago: /onsite/ };
  for (const [name, j] of Object.entries(o4Jobs)) {
    const r = score(p, j);
    const b = r.blockers.find((x) => expect[name].test(x.message));
    assert.ok(b, `${name}: no warning naming the requirement: ${r.blockers.map((x) => x.message).join(' | ')}`);
    assert.ok(b.evidence && (j.description.includes(b.evidence.text) || j.places.some((pl) => pl.text === b.evidence!.text)), `${name}: quote not in the posting`);
    assert.notEqual(r.band, 'strong', name);
    assert.ok(cardText(r, j).includes('!'), `${name}: the card shows no warning`);
    assert.ok(summarizeMatch(r).warning, `${name}: the card summary has no warning`);
  }
});

test('O4: the requirement in the last paragraph of a long posting is found', () => {
  const r = score(profileOf(O4_PROFILE), o4Jobs.sponsorship);
  assert.ok(r.mustHaves.some((m) => m.kind === 'sponsorship' && m.state === 'unmet'));
});

test('O4: "authorized, no sponsorship needed" removes the sponsorship warning; a blank answer says "not in your profile"', () => {
  const ok = profileOf({ ...O4_PROFILE, workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: 'no', hasSecurityClearance: 'no' } });
  const r1 = score(ok, o4Jobs.sponsorship);
  assert.ok(!r1.blockers.some((b) => b.kind === 'sponsorship' || b.kind === 'work_authorization'), r1.blockers.map((b) => b.message).join('|'));
  const blank = profileOf({ ...O4_PROFILE, workAuthorization: {} });
  const r2 = score(blank, o4Jobs.sponsorship);
  const b = r2.blockers.find((x) => x.kind === 'sponsorship');
  assert.ok(b && /not in your profile/.test(b.message), 'a blank answer is not read as authorized');
  assert.notEqual(r2.band, 'strong');
});

test('O4: "clearance preferred" is not a must-have; "clearance required" is', () => {
  const p = profileOf(SWE);
  const pref = score(p, job({ title: 'Software Engineer', description: 'Requirements\n- TypeScript, React, PostgreSQL\n- Secret clearance preferred' }));
  assert.ok(!pref.blockers.some((b) => b.kind === 'clearance'));
  assert.ok(pref.mustHaves.some((m) => m.kind === 'clearance' && m.importance === 'preferred'));
  const req = score(p, job({ title: 'Software Engineer', description: 'Requirements\n- TypeScript, React, PostgreSQL\n- Secret clearance required' }));
  assert.ok(req.blockers.some((b) => b.kind === 'clearance'));
});

test('O5: a posting that states no years, pay or sponsorship shows "not stated" for each', () => {
  const r = score(swe, job({ title: 'Software Engineer', description: 'Requirements\n- TypeScript\n- React\n- PostgreSQL' }));
  for (const k of ['years', 'pay', 'sponsorship'] as const) {
    assert.equal(r.jobFacts[k].value, null, k);
    assert.equal(r.jobFacts[k].text, 'not stated', k);
  }
});

test('O5: every quote is the posting word for word', () => {
  const p = profileOf(O4_PROFILE);
  for (const j of [...Object.values(o4Jobs), backend, nurseJob]) {
    const r = score(p, j);
    const sources = [j.description, j.title, ...j.places.map((x) => x.text)];
    for (const qt of quotesOf(r)) assert.ok(sources.some((s) => s.includes(qt)), `not in the posting: "${qt}"`);
  }
});

test('O5: "3 to 5 years preferred" is shown as a preferred range, never "requires 5+ years"', () => {
  const r = score(swe, job({ title: 'Software Engineer', description: 'Requirements\n- TypeScript\n- React\n- 3 to 5 years preferred' }));
  assert.equal(r.jobFacts.years.text, '3 to 5 years (preferred)');
  assert.equal(r.jobFacts.years.quote, '3 to 5 years preferred');
  assert.ok(!r.blockers.some((b) => b.kind === 'years'));
  assert.ok(!JSON.stringify(r).includes('5+ years'));
});

test('O5: a company with no sponsor data never gets a "no H-1B" label', () => {
  const r = score(profileOf(O4_PROFILE), job({ title: 'Software Engineer', company: 'Imaginary Widgets LLC', description: 'Requirements\n- TypeScript\n- React' }));
  const text = JSON.stringify(r);
  assert.ok(!/no h-?1b/i.test(text));
  assert.ok(!r.whyFit.some((c) => c.kind === 'h1b_sponsor_likely' || (c.kind as string) === 'post_says_no_sponsorship'));
});

test('O5: the industry reason names only an employer in that industry', () => {
  const r = score(swe, job({ title: 'Software Engineer', description: 'Tailspin is a fintech payments company.\n\nRequirements\n- TypeScript\n- React' }));
  const text = r.subScores.industryExperience.reasons.map((x) => x.text).join(' ');
  assert.ok(!/you have .* in Fintech/i.test(text), text);
  assert.match(text, /Fabrikam Bank|Northwind Cloud Software/);
});

test('O6: Java, C and Rust are missing for a JavaScript profile; k8s is met through Kubernetes', () => {
  const r1 = score(swe, job({ title: 'Software Engineer', description: 'We build software.\n\nRequirements\n- Strong Java skills\n- Experience with k8s\n- Proficiency in C.\n- Rust programming' }));
  assert.deepEqual(r1.skills.matched, ['Kubernetes']);
  for (const s of ['Java', 'C', 'Rust']) assert.ok(r1.skills.missing.includes(s), `${s} should be missing: ${r1.skills.missing}`);
});

test('O6: C is never met by C++ or C#', () => {
  const p = profileOf({ ...SWE, skills: ['C++', 'C#'] });
  const r = score(p, job({ title: 'Firmware Engineer', description: 'Embedded firmware team.\n\nRequirements\n- C programming\n- 2+ years of experience' }));
  assert.ok(r.skills.missing.includes('C'));
  assert.ok(!r.skills.matched.includes('C'));
  const check = r.skillDetail.find((c) => c.name === 'C');
  assert.equal(check?.state, 'missing');
});

test('O6: a declined skill never counts, even when a work bullet names it', () => {
  const withBullet = { ...SWE, work: [{ company: 'X Labs', title: 'Software Engineer', startDate: '2022-01', endDate: 'present', bullets: ['Wrote Python services.'] }] };
  const j = job({ title: 'Software Engineer', description: 'Requirements\n- Python\n- TypeScript' });
  assert.ok(score(profileOf(withBullet), j).skills.matched.includes('Python'));
  const declined = score(profileOf({ ...withBullet, declinedSkills: ['Python'] }), j);
  assert.ok(declined.skills.missing.includes('Python'));
});

test('O6: a nurse profile does not score skills on a software job because both say "patient"', () => {
  const r = score(profileOf(NURSE), job({ title: 'Software Engineer', description: 'We build software that improves patient care for patients.\n\nRequirements\n- Python\n- React\n- AWS' }));
  assert.ok((r.subScores.skills.percent ?? 0) <= 10, String(r.subScores.skills.percent));
  assert.equal(r.band, 'fair');
});
