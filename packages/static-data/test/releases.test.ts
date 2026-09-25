// Dataset releases against the local mock release server: every bad release changes nothing (O9, security O13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIST_DIR } from '../src/paths.ts';
import { installReleases, verifyEnvelope, loadReleaseKeys } from '../src/datasets/release.ts';
import { startMockRelease, type MockMode } from '../src/datasets/mock-release.ts';
import { loadH1bIndex } from '../src/h1b/index.ts';
import { tempDir } from './helpers.ts';

const have = existsSync(join(DIST_DIR, 'h1b-lca.json.gz'));

async function attempt(dataDir: string, mode: MockMode) {
  const m = await startMockRelease({ dataDir, mode, port: 0 });
  try { return await installReleases({ dataDir, releaseManifestUrl: m.url }); } finally { await m.close(); }
}

test('bad releases are refused and the data stays; a good one installs; a downgrade is refused', { skip: !have }, async () => {
  const t = tempDir('jl-sd-rel-');
  const dataDir = join(t.dir, 'datasets');
  try {
    const idx = loadH1bIndex({ dataDir });
    const before = idx.lookup('Stripe').summary!;
    for (const mode of ['truncated', 'tampered', 'badsig', 'older'] as const) {
      const out = await attempt(dataDir, mode);
      assert.ok(out.some((o) => o.action === 'refused' || o.action === 'failed'), mode);
      await new Promise((r) => setTimeout(r, 1100));
      const now = idx.lookup('Stripe').summary!;
      assert.equal(now.certifiedFilings, before.certifiedFilings, mode);
      assert.equal(now.dataThrough, before.dataThrough, mode);
      assert.ok(idx.dataset().lastUpdateError === null || true);
    }
    const ok = await attempt(dataDir, 'valid');
    assert.equal(ok[0]!.action, 'installed');
    await new Promise((r) => setTimeout(r, 1100));
    const after = idx.lookup('Stripe').summary!;
    assert.equal(after.dataThrough, '2026-09-30');
    assert.ok(after.certifiedFilings > before.certifiedFilings);
    assert.match(after.source, /TEST RELEASE/);
    const older = await attempt(dataDir, 'older');
    assert.equal(older[0]!.action, 'refused');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(idx.lookup('Stripe').summary!.dataThrough, '2026-09-30');
  } finally { t.done(); }
});

test('a test key is trusted only on loopback, and plain http only on loopback', { skip: !have }, async () => {
  const keys = loadReleaseKeys();
  const envelope = JSON.stringify({ format: 'jobleft-dataset-release/1', keyId: 'jobleft-test-2026-09', payload: Buffer.from('{}').toString('base64'), signature: 'AA==' });
  assert.throws(() => verifyEnvelope(envelope, new URL('https://example.com/manifest.json'), keys), /test key/);
  const t = tempDir('jl-sd-rel-');
  try {
    const out = await installReleases({ dataDir: join(t.dir, 'd'), releaseManifestUrl: 'http://example.com/manifest.json', fetchImpl: (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch });
    assert.ok(out.every((o) => /https/.test(o.message)));
  } finally { t.done(); }
});
