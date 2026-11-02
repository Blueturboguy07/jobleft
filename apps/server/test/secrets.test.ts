// The secret store off macOS (and with JOBLEFT_SECRET_STORE=file): keys live in an encrypted file in the data folder
// and survive a stop of the local service. Until 0.1.3 every system but macOS kept them in memory only, so on
// Windows the publik connection died with every quit, reboot or update, and the next connect made a new, unlinked
// publik install that had to be linked again (the "linked, but the plan is never used" reports).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSecretStore, fileSecrets, secretsDirFor } from '../src/services/secrets.ts';
import { startPublik } from '../scripts/mocks.ts';
import { cleanup, scratchHome, startTest } from './helpers.ts';

const CANARY = 'pk_test_canaryaaaaaa_7q4zjobleftcanary0000000000000000';

test('file store: a key saved by one server instance is read by the next one on the same data folder; delete-all removes it', async () => {
  const home = scratchHome('secrets-file');
  try {
    const first = fileSecrets(secretsDirFor(home));
    assert.equal(first.kind, 'file');
    assert.equal(await first.get('jobleft.publik.key'), null);
    await first.set('jobleft.publik.key', CANARY);
    assert.equal(await first.get('jobleft.publik.key'), CANARY);
    assert.deepEqual(first.knownNames(), ['jobleft.publik.key']);
    // Nothing in plain text, every file 0600 (POSIX modes only: Windows has no owner-only bit).
    for (const name of readdirSync(join(home, 'secrets'))) {
      const p = join(home, 'secrets', name);
      assert.ok(!readFileSync(p).includes(Buffer.from('canary')), `${name} has no plain key`);
      if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600);
    }
    // A new instance (the next start of the local service) sees the same key.
    const second = fileSecrets(secretsDirFor(home));
    assert.equal(await second.get('jobleft.publik.key'), CANARY);
    assert.deepEqual(second.knownNames(), ['jobleft.publik.key'], 'delete-all learns the names from the file, not from this process');
    await second.delete('jobleft.publik.key');
    assert.equal(await fileSecrets(secretsDirFor(home)).get('jobleft.publik.key'), null);
    assert.deepEqual(second.knownNames(), []);
  } finally { cleanup(home); }
});

test('the default store keeps keys across a stop on every system (Keychain on macOS, the encrypted file elsewhere); memory is for tests only', () => {
  const home = scratchHome('secrets-default');
  try {
    assert.equal(createSecretStore('memory', home).kind, 'memory');
    assert.equal(createSecretStore('file', home).kind, 'file');
    const byDefault = createSecretStore(undefined, home);
    assert.equal(byDefault.kind, process.platform === 'darwin' ? 'keychain' : 'file');
    assert.notEqual(byDefault.kind, 'memory', 'a real data folder never forgets its keys at stop');
    assert.equal(createSecretStore('keychain', home).kind, process.platform === 'darwin' ? 'keychain' : 'file', 'no Keychain: the file store stands in');
    assert.ok(!existsSync(join(home, 'secrets')), 'the folder is made only when a key is saved');
  } finally { cleanup(home); }
});

test('publik stays connected after the local service restarts (the Windows path), and no second install is made', async () => {
  const pub = await startPublik({ balanceMicros: 0 });
  const home = scratchHome('secrets-restart');
  const env = { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pub.origin}/api/v1` };
  const mints = () => pub.log.filter((e) => e.path === '/api/v1/installs' && e.method === 'POST').length;
  try {
    const a = await startTest('secrets-restart-a', { home, env, secrets: createSecretStore('file', home) });
    try {
      const c = await a.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
      assert.equal(c.status, 200, c.text);
      assert.equal(c.json.state, 'connected');
      assert.equal(mints(), 1);
    } finally { await a.stop(); }

    // Quit, reboot, update: the service starts again on the same data folder, with a new store instance.
    const b = await startTest('secrets-restart-b', { home, env, secrets: createSecretStore('file', home) });
    try {
      const again = await b.call('GET', '/api/v1/publik');
      assert.equal(again.json.state, 'connected', `before the fix (memory store) this was "disconnected": ${again.text.slice(0, 120)}`);
      assert.equal(again.json.wallet.balanceMicros, 0);
      const connect = await b.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
      assert.equal(connect.json.state, 'connected');
      assert.equal(mints(), 1, 'one connection, one install: nothing is minted again');
      // Delete all data: the key and the whole secrets folder go.
      assert.equal((await b.call('POST', '/api/v1/data/delete', { confirm: 'delete everything' })).status, 200);
      assert.equal((await b.call('GET', '/api/v1/publik')).json.state, 'disconnected');
      assert.ok(!existsSync(join(home, 'secrets')), 'delete-all removes the encrypted store');
    } finally { await b.stop(); }
  } finally { await pub.close(); cleanup(home); }
});
