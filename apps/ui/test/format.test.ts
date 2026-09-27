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
