// The Linux secret store: the keyring when it works, the encrypted file when it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { linuxSecrets, memorySecrets, type ServerSecretStore } from '../src/services/secrets.ts';
import { ApiFailure } from '../src/errors.ts';
import { cleanup, scratchHome } from './helpers.ts';

/** A keyring that is installed but not running: every call fails. */
function brokenKeyring(): ServerSecretStore {
  const fail = async () => { throw new ApiFailure('write_failed', 'jobleft could not save the key in the system keyring.'); };
  return { kind: 'secret-service', get: fail, set: fail, delete: fail, knownNames: () => [] };
}

test('linux secrets: with a keyring that fails, a key is saved to the encrypted file and read back', async () => {
  const home = scratchHome('sec-broken');
  try {
    const s = linuxSecrets(home, brokenKeyring());
    await s.set('ai.own_key.openrouter', 'sk-or-v1-test');
    assert.equal(await s.get('ai.own_key.openrouter'), 'sk-or-v1-test');
    assert.ok(existsSync(join(home, 'secrets', 'secrets.enc')));
    await s.delete('ai.own_key.openrouter');
    assert.equal(await s.get('ai.own_key.openrouter'), null);
  } finally { cleanup(home); }
});

test('linux secrets: with a working keyring, the key goes there and no file copy is left', async () => {
  const home = scratchHome('sec-ok');
  try {
    const ring = memorySecrets();
    const s = linuxSecrets(home, ring);
    await s.set('k', 'from-keyring');
    assert.equal(await ring.get('k'), 'from-keyring');
    assert.equal(await s.get('k'), 'from-keyring');
    // A key saved to the file while the keyring was down moves to the keyring on the next save.
    const down = linuxSecrets(home, brokenKeyring());
    await down.set('k2', 'from-file');
    const up = linuxSecrets(home, ring);
    assert.equal(await up.get('k2'), 'from-file');
    await up.set('k2', 'from-file');
    assert.equal(await ring.get('k2'), 'from-file');
    assert.equal(await linuxSecrets(home, brokenKeyring()).get('k2'), null, 'the file copy is gone');
  } finally { cleanup(home); }
});

test('linux secrets: a key the store refuses (empty, too long) is refused, not written to the file', async () => {
  const home = scratchHome('sec-bad');
  try {
    const refusing: ServerSecretStore = { ...memorySecrets(), async set() { throw new ApiFailure('bad_request', 'The key is empty or too long.'); } };
    await assert.rejects(linuxSecrets(home, refusing).set('k', ''), (e: unknown) => e instanceof ApiFailure && e.code === 'bad_request');
    assert.equal(existsSync(join(home, 'secrets', 'secrets.enc')), false);
  } finally { cleanup(home); }
});
