// Which copy of each dataset is in use, and what went wrong last time.
//
//   <bundledDir>/datasets.json            the shipped datasets (written by the build commands)
//   <dataDir>/active.json                 releases installed by updateDatasets (verified before they were written)
//   <dataDir>/installed/<id>/<file>       the installed release files
//   <dataDir>/state.json                  the last update attempt and error per dataset
//
// An installed release is used only when its sequence is higher than the shipped copy's and its bytes still match
// the sha256 recorded when it was installed. Otherwise the shipped copy is used and the problem is recorded, so the
// app never loses its sponsor or place data (static-data O9).

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DIST_DIR } from '../paths.ts';

export interface DatasetRecord {
  id: string;
  name: string;
  /** File name, relative to the folder that holds it. */
  file: string;
  sha256: string;
  bytes: number;
  version: string;
  /** Grows with every release. An update with a lower or equal number is refused. */
  sequence: number;
  dataThrough: string | null;
  licence: string;
  attribution: string | null;
  sourceUrl: string | null;
  builtAt: string;
  installedAt?: string;
  /** Synthetic data for update tests (mock release server only). */
  test?: boolean;
}

export interface DatasetIndexFile {
  format: 'jobleft-datasets/1';
  datasets: DatasetRecord[];
}

export interface DatasetState {
  lastAttemptAt?: string;
  lastError?: string | null;
  lastErrorAt?: string;
}

export interface StaticDataOptions {
  /** $JOBLEFT_HOME/datasets (updated releases, verified before use). */
  dataDir: string;
  /** Defaults to this package's dist/ folder (the built copies that ship with the app). */
  bundledDir?: string;
}

export const INDEX_FILE = 'datasets.json';
export const ACTIVE_FILE = 'active.json';
export const STATE_FILE = 'state.json';

/** Bumped by updateDatasets in this process, so loaded indexes reload at once. */
let generation = 0;
export function datasetGeneration(): number { return generation; }
export function bumpDatasetGeneration(): void { generation += 1; }

export function bundledDirOf(opts: StaticDataOptions): string {
  return opts.bundledDir ?? DIST_DIR;
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

/** Writes a file so that a crash leaves either the old or the new bytes, never a mix. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readBundledIndex(opts: StaticDataOptions): DatasetIndexFile {
  const idx = readJson<DatasetIndexFile>(join(bundledDirOf(opts), INDEX_FILE));
  return idx && Array.isArray(idx.datasets) ? idx : { format: 'jobleft-datasets/1', datasets: [] };
}

export function writeBundledRecord(bundledDir: string, rec: DatasetRecord): void {
  const path = join(bundledDir, INDEX_FILE);
  const idx = readJson<DatasetIndexFile>(path) ?? { format: 'jobleft-datasets/1', datasets: [] };
  idx.datasets = idx.datasets.filter((d) => d.id !== rec.id).concat([rec]).sort((a, b) => a.id.localeCompare(b.id));
  writeFileAtomic(path, JSON.stringify(idx, null, 2) + '\n');
}

export function readActive(opts: StaticDataOptions): Record<string, DatasetRecord> {
  const a = readJson<{ datasets?: Record<string, DatasetRecord> }>(join(opts.dataDir, ACTIVE_FILE));
  return a?.datasets ?? {};
}

export function writeActive(opts: StaticDataOptions, datasets: Record<string, DatasetRecord>): void {
  writeFileAtomic(join(opts.dataDir, ACTIVE_FILE), JSON.stringify({ format: 'jobleft-active-datasets/1', datasets }, null, 2) + '\n');
}

export function readState(opts: StaticDataOptions): Record<string, DatasetState> {
  return readJson<{ datasets?: Record<string, DatasetState> }>(join(opts.dataDir, STATE_FILE))?.datasets ?? {};
}

export function writeStateFor(opts: StaticDataOptions, id: string, patch: DatasetState): void {
  try {
    const all = readState(opts);
    all[id] = { ...all[id], ...patch };
    writeFileAtomic(join(opts.dataDir, STATE_FILE), JSON.stringify({ format: 'jobleft-dataset-state/1', datasets: all }, null, 2) + '\n');
  } catch {
    // The data folder may be read-only (a stranger's dry run); the error still shows in the command's own output.
  }
}

/** A change marker for the installed-release files: their mtimes. Cheap to check before every lookup batch. */
export function activeStamp(opts: StaticDataOptions): string {
  const parts: string[] = [String(generation)];
  for (const f of [join(opts.dataDir, ACTIVE_FILE), join(bundledDirOf(opts), INDEX_FILE)]) {
    try { const s = statSync(f); parts.push(`${s.mtimeMs}:${s.size}`); } catch { parts.push('-'); }
  }
  return parts.join('|');
}

export interface LoadedDataset {
  record: DatasetRecord;
  origin: 'bundled' | 'installed';
  bytes: Buffer;
  /** Why the installed release was not used, when it was not. */
  warning: string | null;
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The bytes of the dataset in use: the installed release when it is newer than the shipped copy and still intact,
 * else the shipped copy. `validate` may throw to reject content (the next candidate is then tried).
 * Returns null only when no intact copy exists at all.
 */
export function loadDataset(opts: StaticDataOptions, id: string, validate: (bytes: Buffer, rec: DatasetRecord) => void): LoadedDataset | null {
  const bundled = readBundledIndex(opts).datasets.find((d) => d.id === id) ?? null;
  const installed = readActive(opts)[id] ?? null;
  const candidates: Array<{ rec: DatasetRecord; origin: 'bundled' | 'installed'; path: string }> = [];
  if (installed && (!bundled || installed.sequence > bundled.sequence)) {
    candidates.push({ rec: installed, origin: 'installed', path: join(opts.dataDir, 'installed', id, installed.file) });
  }
  if (bundled) candidates.push({ rec: bundled, origin: 'bundled', path: join(bundledDirOf(opts), bundled.file) });
  let warning: string | null = null;
  for (const c of candidates) {
    try {
      if (!existsSync(c.path)) throw new Error('the file is missing');
      const bytes = readFileSync(c.path);
      if (bytes.length !== c.rec.bytes) throw new Error(`the file has ${bytes.length} bytes, ${c.rec.bytes} expected`);
      if (sha256(bytes) !== c.rec.sha256) throw new Error('the file does not match its sha256');
      validate(bytes, c.rec);
      return { record: c.rec, origin: c.origin, bytes, warning };
    } catch (err) {
      const what = c.origin === 'installed' ? `The installed ${id} release ${c.rec.version} is damaged (${(err as Error).message}); using the shipped copy.` : `The shipped ${id} data is damaged (${(err as Error).message}).`;
      warning = warning ? `${warning} ${what}` : what;
    }
  }
  return null;
}
