import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realLink } from '../src/lib/external.ts';

test('the reserved no-link address of a pasted job is not a link (JL-tracker-12)', () => {
  assert.equal(realLink('https://jobleft.invalid/job/b9b22cd31c20f331'), null);
  assert.equal(realLink('https://example.com/careers/data-analyst'), 'https://example.com/careers/data-analyst');
  assert.equal(realLink(null), null);
  assert.equal(realLink('javascript:alert(1)'), null);
});
