// The language facts of a posting (Dutch required, a plus, not required; written in Dutch), on sentences taken from
// real postings on 2026-10-12.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dutchNeed, languageFacts, needsDutch, postingLanguage } from '../src/interim/language.ts';

const need = (s: string) => dutchNeed(s)?.need ?? null;

test('Dutch required: fluent, fluency, proficiency, B1+, vloeiend, beheersing, vereist', () => {
  for (const s of ['- Fluent in English and Dutch', '- Fluency in Dutch', '- C2 fluency in Dutch (required for client communication)', 'You are fluent in Dutch and English (spoken and written).',
    'Languages required: English & Dutch', 'Note: for this position it is needed to speak, write and read in Dutch!', '- Fluent Dutch (native not required) and professional English.',
    '- You speak conversational Dutch (B1+ or higher), so you can navigate contracts.', 'This role requires fluent Dutch and English languages knowledge, both spoken and written.',
    'Je beheerst daarnaast zowel de Nederlandse als de Engelse taal uitstekend.', '- Vloeiende beheersing van Nederlands en Engels (minimaal B2)', 'Voor deze functie is vloeiend Nederlands op moedertaalniveau vereist.',
    '• Je spreekt en schrijft vloeiend Nederlands en professioneel Engels', '- Goede beheersing van de Nederlandse taal.', '- Good command of Dutch and English, preferably French', 'Excellent knowledge of Dutch is essential.']) assert.equal(need(s), 'required', s);
});

test('Dutch a plus, one of several languages, or not required', () => {
  for (const s of ['- Dutch is a plus', 'Fluent in Dutch would be a preference but not essential.', '- Fluency in English is required, fluency in Dutch is preferred',
    '- Fluency/business-level proficiency in Dutch is preferable.', 'Dutch or German is a plus, not a requirement.', '- C2 fluency in German or Dutch (required for client communication)',
    '- You are fluent in English, and in French and/or Dutch.', '- English fluency is required; proficiency in a Nordic, Dutch, or French language is an advantage.',
    'Dutch is useful but not required.', 'Je spreekt Duits of Nederlands.']) assert.equal(need(s), 'preferred', s);
  assert.equal(need('Speaking Dutch is not required: our working language is English.'), 'not_required');
});

test('Dutch that is not about the language is not a requirement', () => {
  for (const s of ['- 25 vacation days plus all Dutch national holidays', '- Hands-on, working knowledge of Dutch labor law.', '- A professional qualification such as CPA, ACCA, Dutch RA or RC, CIA, CISA.',
    'Have you ever tried Dutch caramel waffles?', '- Stay registered as a student at a Dutch university for the entire internship period.', 'ON2IT is een internationale cybersecurity organisatie met Nederlandse roots.',
    '- At least 8 years of experience in the Dutch mortgage market (required).']) assert.equal(need(s), null, s);
});

test('a posting written in Dutch, and what "leave out jobs that need Dutch" leaves out', () => {
  const nl = 'Als SOC analist bij de KVK krijg je de kans om je expertise verder te verdiepen. Je werkt samen met ervaren collega\'s en je bent de eerste verdedigingslinie tegen digitale dreigingen. Wat wij vragen: een afgeronde opleiding en ervaring met SIEM.';
  const en = 'As a SOC analyst you will monitor alerts and investigate incidents with the team. You have experience with SIEM tools and you are curious. We offer a hybrid role in Utrecht with a good salary and training budget.';
  assert.equal(postingLanguage(nl), 'nl');
  assert.equal(postingLanguage(en), 'en');
  assert.equal(postingLanguage('SOC Analyst'), null);
  assert.ok(needsDutch(languageFacts('SOC analist', nl)), 'written in Dutch');
  assert.ok(!needsDutch(languageFacts('SOC Analyst', en)));
  assert.ok(needsDutch(languageFacts('SOC Analyst', `${en}\n- Fluency in Dutch.`)));
  assert.ok(!needsDutch(languageFacts('SOC Analyst', `${en}\nDutch is a plus.`)));
  assert.ok(!needsDutch(languageFacts('SOC analist', `${nl}\nNederlands spreken is niet vereist.`)));
  assert.equal(languageFacts('SOC Analyst', `${en}\n- Fluency in Dutch.`).evidence, 'Fluency in Dutch.');
});

test('jobs carry their language facts, and "leave out jobs that need Dutch" leaves those out', async () => {
  const { cleanup, startTest } = await import('./helpers.ts');
  const s = await startTest('language');
  try {
    const add = async (text: string) => { const r = await s.call('POST', '/api/v1/jobs/external', { text }); assert.equal(r.status, 200, r.text); return r.json.job; };
    const en = await add('SOC Analyst\nCompany: Example BV\nLocation: Utrecht, Netherlands\nAs a SOC analyst you will monitor alerts and investigate incidents with the team. You have experience with SIEM tools. Dutch is a plus.');
    const req = await add('Security Analyst\nCompany: Voorbeeld BV\nLocation: Utrecht, Netherlands\nYou monitor alerts and investigate incidents for our clients in the Benelux.\n- Fluency in Dutch and English.');
    const nl = await add('SOC analist\nCompany: Gemeente Voorbeeld\nLocation: Utrecht, Netherlands\nAls SOC analist bij de gemeente krijg je de kans om je expertise verder te verdiepen. Je werkt samen met ervaren collega\'s en je bent de eerste verdedigingslinie tegen digitale dreigingen. Wat wij vragen: een afgeronde opleiding en ervaring met SIEM.');
    const search = async (filter: object) => (await s.call('POST', '/api/v1/jobs/search', { sort: 'most_recent', filter: { sources: ['external:text'], ...filter }, limit: 10 })).json.items;
    const all = await search({});
    const of = (id: string) => all.find((x: any) => x.job.id === id).job.language;
    assert.deepEqual(of(en.id), { posting: 'en', dutch: 'preferred', evidence: 'Dutch is a plus.' });
    assert.equal(of(req.id).dutch, 'required');
    assert.equal(of(nl.id).posting, 'nl');
    assert.deepEqual((await search({ leaveOutDutch: true })).map((x: any) => x.job.id), [en.id]);
    // The job view has them too.
    assert.equal((await s.call('GET', `/api/v1/jobs/${encodeURIComponent(req.id)}`)).json.job.language.evidence, 'Fluency in Dutch and English.');
  } finally { await s.stop(); cleanup(s.home); }
});
