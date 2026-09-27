// The fit model files: where they come from, how they are checked, and where they live.
//
// Model: BAAI/bge-small-en-v1.5 (MIT licence), fp32 ONNX export, pinned to one Hugging Face revision.
// Every file has a known size and sha256. A download goes to "<file>.part", resumes with an HTTP Range request
// after a cut, and is renamed into place only after its size and sha256 match. A file that does not match is
// deleted, never used. Once the files are in place the model is used offline: nothing contacts the network again.

import { createHash } from 'node:crypto';
import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_ID = 'bge-small-en-v1.5';
export const MODEL_DIMS = 384;
export const MODEL_REVISION = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';
export const MODEL_LICENCE = 'MIT';
/** The pinned source (JOBLEFT_MODEL_BASE_URL overrides it; tests use a loopback stand-in or a local folder). */
export const DEFAULT_MODEL_BASE_URL = `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/${MODEL_REVISION}/`;
/** Folder name under $JOBLEFT_HOME/models. */
export const MODEL_FOLDER = `bge-small-en-v1.5-${MODEL_REVISION.slice(0, 7)}`;

export interface ModelFile {
  path: string;
  bytes: number;
  sha256: string;
}

export const MODEL_FILES: readonly ModelFile[] = [
  { path: 'onnx/model.onnx', bytes: 133_093_490, sha256: '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35' },
  { path: 'vocab.txt', bytes: 231_508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' },
  { path: 'tokenizer_config.json', bytes: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
  { path: 'config.json', bytes: 743, sha256: '094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750' },
];

export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((s, f) => s + f.bytes, 0);

const USER_AGENT = 'jobleft/0.1.1 (+https://github.com/Blueturboguy07/jobleft; no personal data)';

export interface ModelSource {
  /** http(s) base URL, a file:// URL, or a local folder path. */
  base: string;
  files: readonly ModelFile[];
}

export function defaultModelSource(env: Record<string, string | undefined> = process.env): ModelSource {
  return { base: env.JOBLEFT_MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL, files: MODEL_FILES };
}

export function modelDirIn(modelsRoot: string): string {
  return join(modelsRoot, MODEL_FOLDER);
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve());
  });
  return h.digest('hex');
}

export type ModelState = 'ready' | 'missing' | 'partial' | 'damaged';

export interface ModelCheck {
  state: ModelState;
  /** Bytes already on disk (complete files plus .part files). */
  haveBytes: number;
  totalBytes: number;
  problems: string[];
}

/** Checks the files on disk. `deep` also re-hashes every file (about 0.3 s for the 133 MB model). */
export async function checkModel(dir: string, files: readonly ModelFile[] = MODEL_FILES, deep = true): Promise<ModelCheck> {
  const problems: string[] = [];
  let have = 0;
  let complete = 0;
  let partial = false;
  for (const f of files) {
    const p = join(dir, f.path);
    if (existsSync(p)) {
      const size = statSync(p).size;
      have += size;
      if (size !== f.bytes) { problems.push(`${f.path} has ${size} bytes, expected ${f.bytes}`); continue; }
      if (deep) {
        const h = await sha256File(p);
        if (h !== f.sha256) { problems.push(`${f.path} does not match its checksum`); continue; }
      }
      complete++;
    } else if (existsSync(`${p}.part`)) {
      have += statSync(`${p}.part`).size;
      partial = true;
    }
  }
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const state: ModelState = complete === files.length ? 'ready' : problems.length > 0 ? 'damaged' : partial || complete > 0 ? 'partial' : 'missing';
  return { state, haveBytes: have, totalBytes: total, problems };
}

export interface DownloadProgress {
  file: string;
  fileBytes: number;
  doneBytes: number;
  totalBytes: number;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Refuse any network access (JOBLEFT_OFFLINE=1). Local folders still work. */
  offline?: boolean;
}

function isHttp(base: string): boolean { return /^https?:\/\//i.test(base); }

function localPathOf(base: string): string {
  return base.startsWith('file://') ? fileURLToPath(base) : base;
}

async function downloadHttp(url: string, dest: string, f: ModelFile, opts: DownloadOptions, doneBefore: number, total: number): Promise<void> {
  const part = `${dest}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > f.bytes) { rmSync(part); have = 0; }
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/octet-stream' };
  if (have > 0) headers.range = `bytes=${have}-`;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { headers, signal: opts.signal, redirect: 'follow' });
  } catch (e) {
    const why = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e);
    throw new Error(`The fit model could not be downloaded (${why}). Nothing half-done is used; run the download again to resume.`);
  }
  if (res.status === 200 && have > 0) { have = 0; rmSync(part, { force: true }); }
  else if (res.status !== 200 && res.status !== 206) throw new Error(`the model host answered ${res.status} for ${f.path}`);
  if (!res.body) throw new Error(`the model host sent no data for ${f.path}`);
  const fd = openSync(part, have > 0 ? 'a' : 'w', 0o600);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writeSync(fd, value);
      have += value.byteLength;
      if (have > f.bytes) throw new Error(`${f.path} is larger than expected`);
      opts.onProgress?.({ file: f.path, fileBytes: have, doneBytes: doneBefore + have, totalBytes: total });
    }
  } catch (e) {
    if (e instanceof Error && /larger than expected/.test(e.message)) throw e;
    throw new Error(`The fit model download was cut at ${have} of ${f.bytes} bytes of ${f.path}. Run the download again to resume.`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Downloads (or copies from a local folder) every missing file, resuming partial ones, and verifies each one.
 * Returns the model folder. Throws a plain error when a file cannot be fetched or does not verify.
 */
export async function ensureModel(dir: string, source: ModelSource = defaultModelSource(), opts: DownloadOptions = {}): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const total = source.files.reduce((s, f) => s + f.bytes, 0);
  let done = 0;
  for (const f of source.files) {
    const dest = join(dir, f.path);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    if (existsSync(dest) && statSync(dest).size === f.bytes && (await sha256File(dest)) === f.sha256) { done += f.bytes; continue; }
    rmSync(dest, { force: true });
    if (isHttp(source.base)) {
      if (opts.offline) throw new Error('The fit model is not downloaded yet and the app is offline.');
      const url = new URL(f.path, source.base.endsWith('/') ? source.base : `${source.base}/`).toString();
      await downloadHttp(url, dest, f, opts, done, total);
    } else {
      const src = join(localPathOf(source.base), f.path);
      if (!existsSync(src)) throw new Error(`The model folder has no ${f.path}.`);
      // A copy-on-write clone where the file system supports it (no extra disk), else a plain copy.
      copyFileSync(src, `${dest}.part`, constants.COPYFILE_FICLONE);
    }
    const part = `${dest}.part`;
    const size = statSync(part).size;
    if (size !== f.bytes) {
      if (size > f.bytes) rmSync(part, { force: true });
      throw new Error(`${f.path} stopped at ${size} of ${f.bytes} bytes; run the download again to resume.`);
    }
    const h = await sha256File(part);
    if (h !== f.sha256) {
      rmSync(part, { force: true });
      throw new Error(`${f.path} did not match its checksum and was deleted.`);
    }
    renameSync(part, dest);
    done += f.bytes;
    opts.onProgress?.({ file: f.path, fileBytes: f.bytes, doneBytes: done, totalBytes: total });
  }
  writeFileSync(join(dir, 'VERIFIED.json'), JSON.stringify({ model: MODEL_ID, revision: MODEL_REVISION, files: source.files }, null, 2), { mode: 0o600 });
  return dir;
}

/** Reads the vocabulary and tokenizer settings of a verified model folder. */
export function readTokenizerFiles(dir: string): { vocab: string; lowercase: boolean } {
  const vocab = readFileSync(join(dir, 'vocab.txt'), 'utf8');
  let lowercase = true;
  try {
    const cfg = JSON.parse(readFileSync(join(dir, 'tokenizer_config.json'), 'utf8')) as { do_lower_case?: boolean };
    if (cfg.do_lower_case === false) lowercase = false;
  } catch { /* default: uncased */ }
  return { vocab, lowercase };
}
