import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { PACKAGE_NAME, homeLayout, newLaunchToken, resolveHome } from '../src/index.ts';

test('@jobleft/server loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/server');
});

test('data folder: JOBLEFT_HOME wins, else the OS default; every path stays inside it', () => {
  const home = join('scratch', 'jl');
  assert.equal(resolveHome({ JOBLEFT_HOME: home }, 'darwin'), home);
  assert.match(resolveHome({}, 'darwin'), /Library[\\/]Application Support[\\/]jobleft$/);
  assert.match(resolveHome({ APPDATA: join('C', 'Roaming') }, 'win32'), /Roaming[\\/]jobleft$/);
  const l = homeLayout(home);
  for (const p of Object.values(l)) assert.ok(p === home || p.startsWith(home + sep), p);
});

test('launch token: 32 random bytes, base64url, new every time', () => {
  const a = newLaunchToken(), b = newLaunchToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});
