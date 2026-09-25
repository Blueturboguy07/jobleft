import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, sidecarEnv } from '../src/index.ts';

test('@jobleft/shell loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/shell');
});

test('sidecar environment carries the data folder, the launch token and the parent pid', () => {
  const env = sidecarEnv({ home: '/h', launchToken: 't', parentPid: 42, uiDir: null });
  assert.deepEqual(env, { JOBLEFT_HOME: '/h', JOBLEFT_LAUNCH_TOKEN: 't', JOBLEFT_PARENT_PID: '42' });
});
