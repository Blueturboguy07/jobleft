import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDegree, pickOption } from '../src/options.ts';
import { opts } from './persona.ts';

const pick = (kind: Parameters<typeof pickOption>[0], wanted: string, labels: string[]) => {
  const p = pickOption(kind, wanted, opts(...labels));
  return p === null ? null : labels[p.index];
};

test('country: the same country under another name, never a near one', () => {
  assert.equal(pick('country', 'US', ['Select...', 'United States Minor Outlying Islands', 'United States', 'Uruguay']), 'United States');
  assert.equal(pick('country', 'US', ['United States Minor Outlying Islands', 'Uruguay']), null);
  assert.equal(pick('country', 'US', ['U.S.A.', 'Canada']), 'U.S.A.');
  assert.equal(pick('country', 'US', ['United States of America (+1)', 'Canada (+1)']), 'United States of America (+1)');
  assert.equal(pick('country', 'GB', ['United States', 'United Kingdom']), 'United Kingdom');
});

test('region and location: TX is Texas; Austin, MN is not Austin, TX', () => {
  assert.equal(pick('region', 'TX|US', ['Tennessee', 'Texas', 'Utah']), 'Texas');
  assert.equal(pick('location', 'Austin|TX|US', ['Austin, MN, United States', 'Austin, Texas, United States']), 'Austin, Texas, United States');
  assert.equal(pick('location', 'Austin|TX|US', ['Austin, MN, United States', 'Austin, AR, United States']), null);
});

test('degree: a B.S. is a Bachelor of Science or a generic bachelor, never a Bachelor of Arts', () => {
  assert.equal(pick('degree', 'B.S.', ['Bachelor of Arts', 'Bachelor of Science', "Master's Degree"]), 'Bachelor of Science');
  assert.equal(pick('degree', 'B.S.', ['Bachelor of Arts', "Master's Degree"]), null);
  assert.equal(pick('degree', 'B.S.', ["Associate's Degree", "Bachelor's Degree", "Master's Degree"]), "Bachelor's Degree");
  assert.deepEqual(parseDegree('MBA'), { level: 'master', field: 'business administration' });
});

test('yes/no/decline: "No" is not "Norfolk Island"; one answer or none', () => {
  assert.equal(pick('no', '', ['Norfolk Island', 'Yes']), null);
  assert.equal(pick('no', '', ['Yes', 'No']), 'No');
  assert.equal(pick('yes', '', ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', "I don't wish to answer"]),
    'I identify as one or more of the classifications of protected veteran');
  assert.equal(pick('no', '', ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', "I don't wish to answer"]), 'I am not a protected veteran');
  assert.equal(pick('decline', '', ['Yes', 'No', 'Decline To Self Identify']), 'Decline To Self Identify');
});

test('race: one saved category never becomes "Two or More Races"', () => {
  const list = ['American Indian or Alaskan Native', 'Asian', 'Black or African American', 'Two or More Races', 'White', 'Decline To Self Identify'];
  assert.equal(pick('race', 'Asian', list), 'Asian');
  assert.equal(pick('race', 'Asian', ['Two or More Races', 'White']), null);
  assert.equal(pick('race', 'American Indian or Alaska Native', list), 'American Indian or Alaskan Native');
});

test('placeholders are never picked, and ranges must contain the number', () => {
  assert.equal(pick('exact', '', ['Select...', 'A']), null);
  assert.equal(pick('range', '3', ['0-1 years', '2-4 years', '5+ years']), '2-4 years');
  assert.equal(pick('range', '3', ['1-3', '3-5']), null);
  assert.equal(pick('month', '5', ['January', 'February', 'March', 'April', 'May', 'June']), 'May');
});
