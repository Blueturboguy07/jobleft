// The first-run setup state (JL-onboarding-2, -11, -14): kept by the local service, so a quit or a reload keeps the
// step and what was typed, and a saved preference alone never counts as a finished setup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, PERSONA, scratchHome, startTest } from './helpers.ts';

test('the setup state starts new, keeps the step and the draft across a restart, and ends done or skipped', async () => {
  const home = scratchHome('onb');
  let s = await startTest('onb', { home });
  try {
    const first = await s.call('GET', '/api/v1/onboarding');
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { status: 'new', step: 0, draft: null, pendingImport: null });
    // step 1 saved with Next, then choices on step 2 typed but not saved: the draft holds them
    const saved = await s.call('PUT', '/api/v1/profile', { ...PERSONA, preferences: { ...PERSONA.preferences, jobFunctions: ['Nursing'] } });
    assert.equal(saved.status, 200, saved.text);
    const { id: _i, version: _v, updatedAt: _u, ...input } = saved.json;
    const draft = { ...input, preferences: { ...input.preferences, employmentTypes: ['full_time'], workModels: ['remote'], levels: ['senior'], minAnnualPayUsd: 150000 } };
    const put = await s.call('PUT', '/api/v1/onboarding', { status: 'active', step: 1, draft, pendingImport: null });
    assert.equal(put.status, 200, put.text);
    await s.stop();
    s = await startTest('onb', { home });
    const back = await s.call('GET', '/api/v1/onboarding');
    assert.equal(back.json.status, 'active', 'a profile with a job function is not a finished setup');
    assert.equal(back.json.step, 1);
    assert.deepEqual(back.json.draft.preferences.employmentTypes, ['full_time']);
    assert.equal(back.json.draft.preferences.minAnnualPayUsd, 150000);
    // a body that does not fit is refused, and the kept state stays
    assert.equal((await s.call('PUT', '/api/v1/onboarding', { status: 'active', step: 9, draft: null })).status, 400);
    assert.equal((await s.call('GET', '/api/v1/onboarding')).json.step, 1);
    const done = await s.call('PUT', '/api/v1/onboarding', { status: 'skipped', step: 0, draft: null, pendingImport: null });
    assert.deepEqual(done.json, { status: 'skipped', step: 0, draft: null, pendingImport: null });
  } finally { await s.stop(); cleanup(home); }
});

test('a data folder from before the setup state, with a saved profile, counts as set up', async () => {
  const s = await startTest('onb-old');
  try {
    assert.equal((await s.call('PUT', '/api/v1/profile', PERSONA)).status, 200);
    assert.equal((await s.call('GET', '/api/v1/onboarding')).json.status, 'done');
  } finally { await s.stop(); cleanup(s.home); }
});
