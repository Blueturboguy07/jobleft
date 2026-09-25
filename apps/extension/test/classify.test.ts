import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.ts';
import { field, opts } from './persona.ts';

const t = (label: string, over = {}) => classify(field(label, over)).topic;

test('standard fields by label, name and autocomplete', () => {
  assert.equal(t('First Name *'), 'first_name');
  assert.equal(t('Legal first name'), 'first_name');
  assert.equal(t('Given Name(s)'), 'first_name');
  assert.equal(t('Last name'), 'last_name');
  assert.equal(t('Full name'), 'full_name');
  assert.equal(t('Name'), 'full_name');
  assert.equal(t('Email address'), 'email');
  assert.equal(t('Phone'), 'phone');
  assert.equal(t('Mobile phone number'), 'phone');
  assert.equal(t('LinkedIn Profile'), 'linkedin');
  assert.equal(t('GitHub URL'), 'github');
  assert.equal(t('Portfolio URL'), 'portfolio');
  assert.equal(t('Website'), 'website');
  assert.equal(t('Country'), 'country');
  assert.equal(t('City'), 'city');
  assert.equal(t('State/Province'), 'region');
  assert.equal(t('Current location'), 'location');
  assert.equal(t('Current company'), 'current_company');
  assert.equal(t('School'), 'edu_school');
  assert.equal(t('Degree'), 'edu_degree');
  assert.equal(t('Discipline'), 'edu_major');
  assert.equal(t('', { autocomplete: 'given-name' }), 'first_name');
  assert.equal(t('', { name: 'job_application[last_name]' }), 'last_name');
  assert.equal(t('Contact', { inputType: 'email' }), 'email');
});

test('a label must OPEN with the words: a question that mentions a country is not a Country field', () => {
  assert.equal(t('First job you ever had?'), 'unknown');
  const c = classify(field('Are you authorized to lawfully work in the country to which you are applying?', { kind: 'radio', options: opts('Yes', 'No') }));
  assert.equal(c.topic, 'work_auth');
  assert.equal(c.country, null);
  assert.equal(t('Citywide preference'), 'unknown');
});

test('sensitive topics are found anywhere in the label', () => {
  assert.equal(t('Gender', { kind: 'select' }), 'eeo_gender');
  assert.equal(t('Are you Hispanic/Latino?', { kind: 'select' }), 'eeo_hispanic');
  assert.equal(t('Please identify your race', { kind: 'select' }), 'eeo_race');
  assert.equal(t('Veteran Status', { kind: 'select' }), 'eeo_veteran');
  assert.equal(t('Disability Status', { kind: 'select' }), 'eeo_disability');
  assert.equal(t('Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?'), 'sponsorship');
  assert.equal(classify(field('Are you legally authorized to work in the United States?')).country, 'US');
  assert.equal(t('Desired salary'), 'pay');
  assert.equal(t('What are your compensation expectations?', { kind: 'textarea' }), 'pay');
  assert.equal(t('Date of birth'), 'dob');
  assert.equal(t('Are you at least 18 years of age?'), 'age');
  assert.equal(t('Have you ever been convicted of a felony?'), 'criminal');
  assert.equal(t('SSN'), 'gov_id');
  assert.equal(t('Social Security Number'), 'gov_id');
  assert.equal(t('Pronouns'), 'eeo_pronouns');
});

test('fields about another person never get the person details', () => {
  assert.equal(t("Referrer's name"), 'other_person');
  assert.equal(t('Email', { context: 'Reference 1' }), 'other_person');
  assert.equal(t('Name', { section: 'Emergency contact' }), 'other_person');
});

test('consent and opt-in boxes are left to the person', () => {
  assert.equal(t('I agree to the privacy policy', { kind: 'checkbox' }), 'consent');
  assert.equal(t('Send me job alerts', { kind: 'checkbox' }), 'consent');
});

test('open questions, preferred names, years with a skill', () => {
  assert.equal(t('Why do you want to work here?', { kind: 'textarea' }), 'open_question');
  assert.equal(t('Cover letter', { kind: 'textarea' }), 'open_question');
  assert.equal(t('Comments', { kind: 'textarea' }), 'unknown');
  assert.equal(t('Preferred name'), 'preferred_name');
  assert.equal(t('Preferred first name'), 'preferred_name');
  const k = classify(field('How many years of experience do you have with Kubernetes?'));
  assert.equal(k.topic, 'skill_years');
  assert.equal(k.skill, 'kubernetes');
  assert.equal(t('Years of experience'), 'years_total');
  assert.equal(t('Resume/CV', { kind: 'file' }), 'resume_file');
  assert.equal(t('Cover Letter', { kind: 'file' }), 'cover_letter_file');
});

test('education and work dates from the section', () => {
  const s = classify(field('Start date month', { section: 'Education', kind: 'select', options: opts('January', 'February', 'March') }));
  assert.equal(s.topic, 'edu_start');
  assert.equal(s.datePart, 'month');
  const e = classify(field('End date year', { section: 'Employment' }));
  assert.equal(e.topic, 'work_end');
  assert.equal(e.datePart, 'year');
});
