import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postingSponsorship } from '../src/lib/sponsorship.ts';

const st = (s: Partial<{ sponsorship: 'yes' | 'no' | null; usCitizenOnly: boolean | null; clearanceRequired: boolean | null }>) => ({ sponsorship: null, usCitizenOnly: null, clearanceRequired: null, ...s });
const QUOTE = 'Applicants for employment in the US must have work authorization that does not now or in the future require sponsorship of a visa for employment authorization in the United States.';

test('the visa section says "no" whenever the chip does, with the posting\'s own words (JL-tracker-3)', () => {
  // The Accenture Federal Services case: citizenship required; the match read the "no sponsorship" sentence.
  const acc = postingSponsorship({ statements: st({ usCitizenOnly: true }), evidence: { usCitizenOnly: { source: 'description', text: '- U.S. citizenship required' } } }, { jobFacts: { sponsorship: { value: 'does not sponsor', quote: QUOTE } } });
  assert.equal(acc.says, 'no');
  assert.equal(acc.quote, QUOTE);
  assert.doesNotMatch(acc.text, /nothing/);
  // No profile (no match): the citizenship statement still says no, with its quote.
  const noMatch = postingSponsorship({ statements: st({ usCitizenOnly: true }), evidence: { usCitizenOnly: { source: 'description', text: '- U.S. citizenship required' } } }, null);
  assert.equal(noMatch.says, 'no');
  assert.equal(noMatch.because, 'citizenship');
  assert.equal(noMatch.quote, '- U.S. citizenship required');
  assert.equal(postingSponsorship({ statements: st({ clearanceRequired: true }), evidence: {} }, null).says, 'no');
  assert.equal(postingSponsorship({ statements: st({ sponsorship: 'yes' }), evidence: { sponsorship: { source: 'description', text: 'We sponsor H-1B visas.' } } }, null).says, 'yes');
  const none = postingSponsorship({ statements: st({}), evidence: {} }, null);
  assert.equal(none.says, null);
  assert.equal(none.text, 'nothing about visa sponsorship.');
});
