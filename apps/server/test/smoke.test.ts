import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, homeLayout, newLaunchToken, resolveHome } from '../src/index.ts';

test('@jobleft/server loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/server');
});

test('data folder: JOBLEFT_HOME wins, else the OS default; every path stays inside it', () => {
  assert.equal(resolveHome({ JOBLEFT_HOME: '/private/tmp/jl' }, 'darwin'), '/private/tmp/jl');
  assert.match(resolveHome({}, 'darwin'), /Library\/Application Support\/jobleft$/);
  const l = homeLayout('/private/tmp/jl');
  for (const p of Object.values(l)) assert.ok(p.startsWith('/private/tmp/jl'), p);
});

test('launch token: 32 random bytes, base64url, new every time', () => {
  const a = newLaunchToken(), b = newLaunchToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});
