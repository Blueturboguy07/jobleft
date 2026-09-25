// Dataset releases: signed manifests, verified downloads, atomic installs (static-data O9; system security O13).
//
// Envelope served at the release address (JOBLEFT_DATASET_MANIFEST_URL):
//   { "format": "jobleft-dataset-release/1", "keyId": "...", "payload": "<base64 manifest JSON>", "signature": "<base64 Ed25519>" }
// Manifest (the signed payload):
//   { "format": "jobleft-dataset-manifest/1", "published": "<RFC 3339>", "datasets": [ DatasetRecord + { "url": "<file URL>" } ] }
//
// A release is installed only when ALL of these hold; otherwise nothing changes and the error is recorded:
//   1. the address is https (plain http only on 127.0.0.1 or localhost, for local mock servers);
//   2. the signature verifies with a key in data/release-keys.json (a loopback-only key only for a loopback address);
//   3. the dataset's sequence is higher than the one in use (an older or equal release is refused: no downgrade);
//   4. the download has exactly the stated size and sha256 (a cut-short or changed file is refused);
//   5. the file parses as that dataset and its own metadata agrees with the manifest.
// The file is written to a temporary name, synced and renamed; then active.json is replaced the same way.

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatasetInfo } from '@jobleft/contracts';
import { DATA_DIR } from '../paths.ts';
import { isLoopbackHost, USER_AGENT } from '../net/polite-fetch.ts';
import { validateH1bFile } from '../h1b/index.ts';
import { H1B_DATASET_ID } from '../h1b/build.ts';
import { validatePlacesFile } from '../places/index.ts';
import { PLACES_DATASET_ID } from '../places/build.ts';
import {
  bumpDatasetGeneration, readActive, readBundledIndex, writeActive, writeFileAtomic, writeStateFor,
  type DatasetRecord, type StaticDataOptions,
} from './store.ts';

export const RELEASE_FORMAT = 'jobleft-dataset-release/1';
export const MANIFEST_FORMAT = 'jobleft-dataset-manifest/1';
const MAX_MANIFEST_BYTES = 1 << 20;
const MAX_FILE_BYTES = 64 << 20;

export interface ReleaseKey { keyId: string; algorithm: 'ed25519'; publicKey: string; scope: 'any' | 'loopback-only'; note?: string }
export interface ReleaseEnvelope { format: string; keyId: string; payload: string; signature: string }
export interface ManifestEntry extends DatasetRecord { url: string }
export interface Manifest { format: string; published: string; datasets: ManifestEntry[] }

export interface UpdateOutcome { id: string; action: 'installed' | 'current' | 'refused' | 'failed'; message: string; version?: string }

/** What each releasable dataset must look like after download. */
const VALIDATORS: Record<string, (bytes: Buffer, e: ManifestEntry) => void> = {
  [H1B_DATASET_ID]: (bytes, e) => {
    const h = validateH1bFile(bytes);
    if (h.meta.version !== e.version || h.meta.sequence !== e.sequence) throw new Error('the file says it is a different release than the manifest');
    if (e.dataThrough && h.meta.dataThrough !== e.dataThrough) throw new Error('the file has a different data date than the manifest');
  },
  [PLACES_DATASET_ID]: (bytes, e) => {
    const h = validatePlacesFile(bytes);
    if (h.meta.version !== e.version || h.meta.sequence !== e.sequence) throw new Error('the file says it is a different release than the manifest');
  },
};

export function loadReleaseKeys(dataDir: string = DATA_DIR): ReleaseKey[] {
  const j = JSON.parse(readFileSync(join(dataDir, 'release-keys.json'), 'utf8')) as { keys?: ReleaseKey[] };
  return (j.keys ?? []).filter((k) => k.algorithm === 'ed25519' && typeof k.publicKey === 'string');
}

function checkAddress(url: URL, what: string): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return;
  throw new Error(`${what} must use https (plain http is accepted only from 127.0.0.1 or localhost)`);
}

/** Verifies the envelope and returns the manifest. Throws a plain message on any problem. */
export function verifyEnvelope(raw: string, manifestUrl: URL, keys: ReleaseKey[]): Manifest {
  let env: ReleaseEnvelope;
  try { env = JSON.parse(raw) as ReleaseEnvelope; } catch { throw new Error('the release manifest is not valid JSON'); }
  if (env.format !== RELEASE_FORMAT || typeof env.payload !== 'string' || typeof env.signature !== 'string') throw new Error('the release manifest is not a signed jobleft release');
  const key = keys.find((k) => k.keyId === env.keyId);
  if (!key) throw new Error(`the release is signed with an unknown key ("${String(env.keyId)}")`);
  if (key.scope === 'loopback-only' && !isLoopbackHost(manifestUrl.hostname)) throw new Error(`the key "${key.keyId}" is a test key and is trusted only for a local mock server`);
  const payload = Buffer.from(env.payload, 'base64');
  const sig = Buffer.from(env.signature, 'base64');
  const pub = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  let ok = false;
  try { ok = verifySignature(null, payload, pub, sig); } catch { ok = false; }
  if (!ok) throw new Error('the release signature does not verify');
  let m: Manifest;
  try { m = JSON.parse(payload.toString('utf8')) as Manifest; } catch { throw new Error('the signed manifest is not valid JSON'); }
  if (m.format !== MANIFEST_FORMAT || !Array.isArray(m.datasets)) throw new Error('the signed manifest has an unknown format');
  for (const e of m.datasets) {
    if (typeof e.id !== 'string' || typeof e.url !== 'string' || !Number.isInteger(e.sequence) || !Number.isInteger(e.bytes) || e.bytes <= 0 || e.bytes > MAX_FILE_BYTES || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error(`the manifest entry for "${String(e.id)}" is incomplete`);
    }
  }
  return m;
}

async function download(url: URL, expectedBytes: number, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream, */*' }, redirect: 'error', signal });
  if (!res.ok || !res.body) throw new Error(`the server answered HTTP ${res.status}`);
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > expectedBytes) throw new Error(`the download is larger than the ${expectedBytes.toLocaleString('en-US')} bytes the manifest states`);
      parts.push(Buffer.from(chunk));
    }
  } catch (err) {
    if ((err as Error).message.includes('larger than')) throw err;
    throw new Error(`the download stopped after ${total.toLocaleString('en-US')} of ${expectedBytes.toLocaleString('en-US')} bytes`);
  }
  if (total !== expectedBytes) throw new Error(`the download stopped after ${total.toLocaleString('en-US')} of ${expectedBytes.toLocaleString('en-US')} bytes`);
  return Buffer.concat(parts);
}

function inUse(opts: StaticDataOptions, id: string): DatasetRecord | null {
  const bundled = readBundledIndex(opts).datasets.find((d) => d.id === id) ?? null;
  const installed = readActive(opts)[id] ?? null;
  if (installed && installed.file && (!bundled || installed.sequence > bundled.sequence)) {
    const path = join(opts.dataDir, 'installed', id, installed.file);
    // A damaged installed copy is not "in use": the same release may be downloaded again.
    if (existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === installed.sha256) return installed;
  }
  return bundled;
}

/**
 * Downloads, verifies and installs newer releases. A bad release changes nothing: the data in use and its date stay,
 * and the error is kept for listDatasets (lastUpdateError).
 */
export async function installReleases(opts: StaticDataOptions & { releaseManifestUrl: string; fetchImpl?: typeof fetch; keys?: ReleaseKey[]; now?: () => number }): Promise<UpdateOutcome[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = () => new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const releasable = Object.keys(VALIDATORS);
  const failAll = (msg: string): UpdateOutcome[] => {
    for (const id of releasable) writeStateFor(opts, id, { lastAttemptAt: now(), lastError: `Update failed: ${msg}. The data in use has not changed.`, lastErrorAt: now() });
    return releasable.map((id) => ({ id, action: 'failed' as const, message: `Update failed: ${msg}. The data in use has not changed.` }));
  };
  let manifestUrl: URL;
  try { manifestUrl = new URL(opts.releaseManifestUrl); } catch { return failAll('the release address is not a valid URL'); }
  if (process.env.JOBLEFT_OFFLINE === '1') return failAll('the app is offline (JOBLEFT_OFFLINE=1), so no release was fetched');
  let manifest: Manifest;
  try {
    checkAddress(manifestUrl, 'the release address');
    const res = await fetchImpl(manifestUrl, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) throw new Error(`the release server answered HTTP ${res.status}`);
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error('the release manifest is too large');
    manifest = verifyEnvelope(text, manifestUrl, opts.keys ?? loadReleaseKeys());
  } catch (err) {
    return failAll((err as Error).message);
  }

  const outcomes: UpdateOutcome[] = [];
  const active = readActive(opts);
  let changed = false;
  for (const e of manifest.datasets) {
    const validate = VALIDATORS[e.id];
    if (!validate) continue;
    const current = inUse(opts, e.id);
    try {
      if (current && e.sequence < current.sequence) throw new Error(`refused: release ${e.version} (sequence ${e.sequence}) is older than the data in use (${current.version}, sequence ${current.sequence}); a downgrade is never installed`);
      if (current && e.sequence === current.sequence) {
        outcomes.push({ id: e.id, action: 'current', message: `${e.id} ${current.version} is already in use.`, version: current.version });
        writeStateFor(opts, e.id, { lastAttemptAt: now(), lastError: null });
        continue;
      }
      const fileUrl = new URL(e.url, manifestUrl);
      checkAddress(fileUrl, 'the dataset file address');
      const bytes = await download(fileUrl, e.bytes, fetchImpl);
      if (createHash('sha256').update(bytes).digest('hex') !== e.sha256) throw new Error('refused: the downloaded file does not match the sha256 in the signed manifest (changed bytes)');
      validate(bytes, e);
      const file = `${e.id}-${e.sequence}-${e.sha256.slice(0, 12)}${e.url.endsWith('.gz') || e.file.endsWith('.gz') ? '.json.gz' : '.bin'}`;
      writeFileAtomic(join(opts.dataDir, 'installed', e.id, file), bytes);
      const { url: _url, ...rest } = e;
      void _url;
      active[e.id] = { ...rest, file, installedAt: now() };
      writeActive(opts, active);
      changed = true;
      writeStateFor(opts, e.id, { lastAttemptAt: now(), lastError: null });
      // Keep the new file and the one it replaced; remove older installed files.
      const keep = new Set([file, current?.file].filter(Boolean) as string[]);
      for (const f of readdirSync(join(opts.dataDir, 'installed', e.id))) if (!keep.has(f) && !f.includes('.tmp-')) rmSync(join(opts.dataDir, 'installed', e.id, f), { force: true });
      outcomes.push({ id: e.id, action: 'installed', message: `Installed ${e.id} ${e.version} (data through ${e.dataThrough ?? 'unknown'}).`, version: e.version });
    } catch (err) {
      const msg = (err as Error).message;
      const text = msg.startsWith('refused:') ? `Update refused: ${msg.slice(8).trim()}. The data in use has not changed.` : `Update failed for ${e.id} ${e.version}: ${msg}. The data in use has not changed.`;
      writeStateFor(opts, e.id, { lastAttemptAt: now(), lastError: text, lastErrorAt: now() });
      outcomes.push({ id: e.id, action: msg.startsWith('refused:') ? 'refused' : 'failed', message: text, version: e.version });
    }
  }
  if (changed) bumpDatasetGeneration();
  return outcomes;
}

/** The interface function: installs what it can and returns the dataset list (errors in lastUpdateError). */
export async function updateDatasets(opts: StaticDataOptions & { releaseManifestUrl: string; fetchImpl?: typeof fetch }): Promise<DatasetInfo[]> {
  await installReleases(opts);
  const { listDatasets } = await import('./list.ts');
  return listDatasets(opts);
}
