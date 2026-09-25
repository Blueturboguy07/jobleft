// A local mock release server for testing updates (static-data O9, system security O13). Loopback only.
//
// It serves a SYNTHETIC test release made from the shipped H-1B table: one extra fiscal quarter (FY2026 Q4,
// "TEST-SYNTHETIC") with made-up counts (half of each filer's FY2026 Q3 count), data through 2026-09-30, and the name
// and source marked "TEST RELEASE (synthetic data)". Nothing in it is real DOL data beyond the shipped table.
// The manifest is signed with the TEST key (test/fixtures/release-test-key.pem), which jobleft trusts only on
// 127.0.0.1 and localhost.
//
// Modes (each uses its own sequence number, so they can be served in any order):
//   valid      sequence = shipped + 1  a good release: it installs, the date and counts change
//   truncated  sequence = shipped + 2  the file stops halfway (the connection is cut)
//   tampered   sequence = shipped + 3  the file's bytes differ from the signed sha256
//   badsig     sequence = shipped + 4  the manifest was changed after signing
//   older      sequence = shipped - 10 a correctly signed but OLDER release (a downgrade)

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { H1B_DATASET_ID, serializeH1bTable, type H1bTable } from '../h1b/build.ts';
import { parseH1bTable } from '../h1b/index.ts';
import { PACKAGE_DIR } from '../paths.ts';
import { MANIFEST_FORMAT, RELEASE_FORMAT, type ManifestEntry } from './release.ts';
import { readBundledIndex, type StaticDataOptions } from './store.ts';

export type MockMode = 'valid' | 'truncated' | 'tampered' | 'badsig' | 'older';
export const MOCK_MODES: readonly MockMode[] = ['valid', 'truncated', 'tampered', 'badsig', 'older'];
export const TEST_KEY_ID = 'jobleft-test-2026-09';
export const TEST_KEY_PATH = join(PACKAGE_DIR, 'test', 'fixtures', 'release-test-key.pem');

function loadShippedTable(opts: StaticDataOptions): { table: H1bTable; sequence: number; version: string } {
  const rec = readBundledIndex(opts).datasets.find((d) => d.id === H1B_DATASET_ID);
  if (!rec) throw new Error('no shipped H-1B table to base a test release on (build it first)');
  const dir = opts.bundledDir ?? join(PACKAGE_DIR, 'dist');
  const table = parseH1bTable(readFileSync(join(dir, rec.file)));
  return { table, sequence: rec.sequence, version: rec.version };
}

/** A synthetic newer (or older) H-1B release built from the shipped table. */
export function syntheticRelease(base: H1bTable, sequence: number, version: string, kind: 'newer' | 'older'): Buffer {
  const t = JSON.parse(JSON.stringify(base)) as H1bTable;
  t.meta.sequence = sequence;
  t.meta.version = version;
  t.meta.test = true;
  t.meta.builtAt = '2026-10-01T00:00:00.000Z';
  t.meta.name = `${base.meta.name} (TEST RELEASE: synthetic data)`;
  t.meta.source = `TEST RELEASE (synthetic data, not DOL figures for the added quarter): ${base.meta.source}`;
  if (kind === 'newer') {
    const q3 = t.meta.quarters.indexOf('2026Q3');
    t.meta.quarters.push('2026Q4');
    t.meta.files.push({
      name: 'TEST-SYNTHETIC-FY2026_Q4', url: null, fiscalYear: 2026, quarters: [4], coverage: { from: '2026-07-01', to: '2026-09-30' },
      bytes: 0, sha256: '0'.repeat(64), official: false, rows: 0, certifiedH1b: 0, statusCounts: {}, decisionDates: { min: '2026-07-01', max: '2026-09-30' }, rowsOutsideCoverage: 0,
    });
    for (const e of t.entities) {
      const add = Math.round((q3 >= 0 ? e[7][q3] ?? 0 : 0) / 2);
      e[7].push(add);
      e[6].push(add);
      e[5] += add;
      t.meta.files[t.meta.files.length - 1]!.certifiedH1b += add;
    }
    t.meta.dataThrough = '2026-09-30';
    t.meta.window = { from: t.meta.window.from, to: '2026-09-30' };
    for (const fy of t.meta.fiscalYears) if (fy.year === 2026) { fy.to = '2026-09-30'; fy.partial = false; }
  }
  return serializeH1bTable(t);
}

function envelope(entries: ManifestEntry[], keyPem: string, tamperAfterSigning: boolean): string {
  const manifest = { format: MANIFEST_FORMAT, published: '2026-10-01T00:00:00.000Z', datasets: entries };
  const payload = Buffer.from(JSON.stringify(manifest));
  const key = createPrivateKey(keyPem.slice(keyPem.indexOf('-----BEGIN')));
  const signature = sign(null, payload, key).toString('base64');
  let signedPayload = payload;
  if (tamperAfterSigning) signedPayload = Buffer.from(JSON.stringify({ ...manifest, datasets: entries.map((e) => ({ ...e, sequence: e.sequence + 100 })) }));
  return JSON.stringify({ format: RELEASE_FORMAT, keyId: TEST_KEY_ID, payload: signedPayload.toString('base64'), signature }, null, 2);
}

export interface MockRelease { server: Server; url: string; mode: MockMode; close(): Promise<void> }

export async function startMockRelease(opts: StaticDataOptions & { port?: number; mode: MockMode; log?: (line: string) => void; keyPath?: string }): Promise<MockRelease> {
  const log = opts.log ?? (() => {});
  const { table, sequence, version } = loadShippedTable(opts);
  const keyPem = readFileSync(opts.keyPath ?? TEST_KEY_PATH, 'utf8');
  const bump: Record<MockMode, number> = { valid: 1, truncated: 2, tampered: 3, badsig: 4, older: -10 };
  const seq = sequence + bump[opts.mode];
  const ver = opts.mode === 'older' ? `${version}-TEST-OLDER` : `FY2026Q4-TEST-${opts.mode.toUpperCase()}`;
  const file = syntheticRelease(table, seq, ver, opts.mode === 'older' ? 'older' : 'newer');
  const sha256 = createHash('sha256').update(file).digest('hex');
  const fileName = `h1b-lca-${ver}.json.gz`;
  const entry: ManifestEntry = {
    id: H1B_DATASET_ID, name: `${table.meta.name} (TEST RELEASE: synthetic data)`, file: fileName, sha256, bytes: file.length,
    version: ver, sequence: seq, dataThrough: opts.mode === 'older' ? table.meta.dataThrough : '2026-09-30', licence: table.meta.licence,
    attribution: table.meta.attribution, sourceUrl: table.meta.sourceUrl, builtAt: '2026-10-01T00:00:00.000Z', test: true,
    url: `files/${fileName}`,
  };
  const manifestText = envelope([entry], keyPem, opts.mode === 'badsig');
  const server = createServer((req, res) => {
    log(`${new Date().toISOString()} ${req.method} ${req.url} (mode ${opts.mode})`);
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestText);
      return;
    }
    if (req.url === `/files/${fileName}`) {
      if (opts.mode === 'truncated') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(file.length) });
        res.write(file.subarray(0, Math.floor(file.length / 2)), () => res.destroy());
        return;
      }
      let body = file;
      if (opts.mode === 'tampered') {
        body = Buffer.from(file);
        for (let i = 64; i < body.length; i += 4096) body[i] = body[i]! ^ 0xff;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4777, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 4777;
  const url = `http://127.0.0.1:${port}/manifest.json`;
  return { server, url, mode: opts.mode, close: () => new Promise((r) => server.close(() => r())) };
}
