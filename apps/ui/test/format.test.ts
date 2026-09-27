// Card and detail wording from the black-box feed findings: one pay format per card (JL-feed-20), no link for a job
// pasted without one (JL-feed-16), and unknown facts said as unknown (JL-feed-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pay } from '@jobleft/contracts';
import { NOT_STATED, jobLink, payExactText, payText } from '../src/lib/format.ts';

const year = (min: number | null, max: number | null): Pay => ({ min, max, currency: 'USD', period: 'year', source: 'description', ranges: 1, annualMin: min, annualMax: max });

test('JL-feed-20: both ends of a yearly range read alike, never with cents; the exact figures stay available', () => {
  assert.equal(payText(year(141773, 162000)), '$141.8K/yr - $162K/yr');
  assert.equal(payText(year(127697.25, 187289.3)), '$127.7K/yr - $187.3K/yr');
  assert.equal(payText(year(61500, 132630)), '$61.5K/yr - $132.6K/yr');
  assert.equal(payText(year(120000, 140000)), '$120K/yr - $140K/yr');
  assert.equal(payExactText(year(141773, 162000)), 'Exactly $141,773 - $162,000 a year');
  assert.equal(payExactText(year(120000, 140000)), null, 'nothing was rounded');
  assert.equal(payText({ ...year(19.5, 60), period: 'hour' }), '$19.50/hr - $60/hr');
});

test('JL-feed-16: a job pasted without a link has no link to open, copy or apply on', () => {
  assert.equal(jobLink('https://jobleft.invalid/job/8f434346648f6b96'), null);
  assert.equal(jobLink('http://jobs.example.com/careers/1'), 'http://jobs.example.com/careers/1');
  assert.equal(jobLink('javascript:alert(1)'), null);
  assert.equal(jobLink(null), null);
});

test('JL-feed-10: every card fact has an unknown wording', () => {
  for (const [k, v] of Object.entries(NOT_STATED)) assert.match(v, /not stated$/, k);
  assert.deepEqual(Object.keys(NOT_STATED).sort(), ['level', 'pay', 'place', 'type', 'workModel', 'years']);
});

test('JL-feed-17 and JL-feed-18: the results line quotes at most 80 characters, and says when words have nothing to search', async () => {
  const { clipWords, searchable } = await import('../src/lib/format.ts');
  assert.equal(clipWords('a'.repeat(5000)).length, 80);
  assert.ok(clipWords('a'.repeat(5000)).endsWith('…'));
  assert.equal(clipWords('data analyst'), 'data analyst');
  for (const q of ['!!!', '%', '*', "'", '🎯', '   ']) assert.equal(searchable(q), false, q);
  for (const q of ['C++', 'data analyst', 'Ünïcödé', '401(k)']) assert.equal(searchable(q), true, q);
});

test('JL-feed-22: one wording for "no sponsorship", and "US citizens only" when that is what the posting says', async () => {
  const { NO_SPONSORSHIP, sponsorChip } = await import('../src/lib/format.ts');
  assert.equal(sponsorChip('post_says_no', 'The post says it does not sponsor visas (from the posting\'s own words).')?.text, NO_SPONSORSHIP);
  assert.equal(sponsorChip('post_says_no', 'The post says US citizenship is required (from the posting\'s own words).')?.text, 'US citizens only');
  assert.equal(sponsorChip('post_says_no', 'The post says a security clearance is required (from the posting\'s own words).')?.text, 'Security clearance required');
  assert.equal(sponsorChip('post_says_no')?.text, NO_SPONSORSHIP);
  assert.equal(sponsorChip(null), null);
});
