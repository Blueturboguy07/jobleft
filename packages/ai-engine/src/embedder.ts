// The local fit model: bge-small-en-v1.5 (MIT), fp32 ONNX on ONNX Runtime, CPU, batch 16, CLS pooling,
// L2-normalised, 384 dimensions (spike S2). Free and offline after one download.
//   * The files are downloaded ONCE from JOBLEFT_MODEL_BASE_URL (default: the Hugging Face BAAI repository) into
//     <JOBLEFT_HOME>/models/bge-small-en-v1.5/, and each file is checked against a pinned sha256 before use.
//     A file with the wrong size or hash is deleted and refused.
//   * ONNX Runtime (onnxruntime-node, MIT) is loaded at run time. It is not a dependency of this package (287 MB);
//     the app build adds it. Without it, createLocalEmbedder answers AiError('not_ready') in plain words.
//   * The tokenizer is a WordPiece tokenizer written here (BERT uncased rules), reading the model's vocab.txt.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Embedder } from '@jobleft/contracts';
import { AiError } from './errors.ts';
import { send } from './transport.ts';

export const FIT_MODEL_ID = 'bge-small-en-v1.5';
export const FIT_MODEL_DIMS = 384;
export const FIT_MODEL_DEFAULT_BASE_URL = 'https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main';
/** Pinned files (sizes and hashes measured on the files spike S2 downloaded on 2026-09-24). */
export const FIT_MODEL_FILES: ReadonlyArray<{ path: string; bytes: number; sha256: string }> = [
  { path: 'onnx/model.onnx', bytes: 133_093_490, sha256: '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35' },
  { path: 'vocab.txt', bytes: 231_508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' },
];

export interface LocalEmbedderOptions {
  /** $JOBLEFT_HOME/models (the model is downloaded once, verified by sha256, then used offline). */
  modelDir: string;
  /** 8 was best on an M4 Pro (spike S2). */
  threads?: number;
  /** Where the files are downloaded from (JOBLEFT_MODEL_BASE_URL). */
  baseUrl?: string;
  /** false = never download; fail with not_ready when the files are missing. */
  allowDownload?: boolean;
  /** A path or file URL of an installed onnxruntime-node entry (JOBLEFT_ORT_MODULE), for builds that bundle it. */
  ortModule?: string;
}

// ------------------------------------------------------------------ WordPiece tokenizer (BERT, uncased)

function isPunct(cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(String.fromCodePoint(cp));
}
function isCjk(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}
function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  return /\p{Cc}|\p{Cf}/u.test(ch);
}

export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  readonly clsId: number;
  readonly sepId: number;
  readonly unkId: number;
  readonly padId: number;

  constructor(vocabText: string) {
    this.vocab = new Map();
    vocabText.split(/\r?\n/).forEach((tok, i) => { if (tok.length && !this.vocab.has(tok)) this.vocab.set(tok, i); });
    const need = (t: string) => { const id = this.vocab.get(t); if (id === undefined) throw new AiError('not_ready', 'The fit model vocabulary is damaged.'); return id; };
    this.clsId = need('[CLS]'); this.sepId = need('[SEP]'); this.unkId = need('[UNK]'); this.padId = need('[PAD]');
  }

  /** BERT basic tokenization: clean, split CJK characters, lower case, strip accents, split punctuation. */
  basic(text: string): string[] {
    let clean = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
      if (/\s/.test(ch)) { clean += ' '; continue; }
      clean += isCjk(cp) ? ` ${ch} ` : ch;
    }
    const out: string[] = [];
    for (const word of clean.trim().split(/\s+/)) {
      if (!word) continue;
      const w = word.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
      let cur = '';
      for (const ch of w) {
        if (isPunct(ch.codePointAt(0)!)) { if (cur) out.push(cur); out.push(ch); cur = ''; } else cur += ch;
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  /** Greedy longest-match-first WordPiece. */
  wordPiece(word: string): number[] {
    const chars = [...word];
    if (chars.length > 100) return [this.unkId];
    const ids: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        found = this.vocab.get(sub);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [this.unkId];
      ids.push(found);
      start = end;
    }
    return ids;
  }

  /** [CLS] tokens [SEP], cut to maxLength. */
  encode(text: string, maxLength = 512): number[] {
    const ids: number[] = [this.clsId];
    for (const w of this.basic(text)) {
      for (const id of this.wordPiece(w)) {
        if (ids.length >= maxLength - 1) break;
        ids.push(id);
      }
      if (ids.length >= maxLength - 1) break;
    }
    ids.push(this.sepId);
    return ids;
  }
}

// ------------------------------------------------------------------ files

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

async function ensureFiles(dir: string, baseUrl: string, allowDownload: boolean): Promise<void> {
  for (const f of FIT_MODEL_FILES) {
    const target = join(dir, f.path);
    if (existsSync(target) && statSync(target).size === f.bytes && (await sha256File(target)) === f.sha256) continue;
    if (existsSync(target)) rmSync(target);
    if (!allowDownload) throw new AiError('not_ready', 'The fit model is not downloaded yet. Fit ranking starts after the one-time download.');
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${target}.part`;
    const res = await send({ method: 'GET', url: `${baseUrl.replace(/\/+$/, '')}/${f.path}`, headers: { accept: 'application/octet-stream' }, idleTimeoutMs: 60_000 });
    if (res.status !== 200) { res.close(); throw new AiError('not_ready', `The fit model download failed (HTTP ${res.status}). Fit ranking stays off until the download works.`); }
    const h = createHash('sha256');
    const parts: Buffer[] = [];
    let size = 0;
    for await (const c of res.chunks()) {
      size += c.length;
      if (size > f.bytes) { res.close(); throw new AiError('not_ready', 'The fit model download is larger than expected, so it was refused.'); }
      h.update(c);
      parts.push(c);
    }
    if (size !== f.bytes || h.digest('hex') !== f.sha256) throw new AiError('not_ready', 'The downloaded fit model does not match its pinned checksum, so it was refused.');
    writeFileSync(tmp, Buffer.concat(parts), { mode: 0o600 });
    renameSync(tmp, target);
  }
}

// ------------------------------------------------------------------ the embedder

interface OrtLike {
  InferenceSession: { create(path: string, o: Record<string, unknown>): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>; inputNames: readonly string[] }> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

async function loadOrt(ortModule: string | undefined): Promise<OrtLike> {
  try {
    const spec = ortModule ? (ortModule.startsWith('file:') ? ortModule : pathToFileURL(ortModule).href) : 'onnxruntime-node';
    const mod = (await import(spec)) as { default?: OrtLike } & OrtLike;
    return (mod.InferenceSession ? mod : mod.default) as OrtLike;
  } catch {
    throw new AiError('not_ready', 'The fit model runtime (ONNX Runtime) is not installed in this build, so fit ranking is off. Search and filters still work.');
  }
}

/** bge-small-en-v1.5 fp32 on ONNX Runtime, CPU, batch 16, CLS pooling, L2-normalised, 384 dims (spike S2). */
export async function createLocalEmbedder(opts: LocalEmbedderOptions): Promise<Embedder> {
  const env = process.env;
  const dir = join(opts.modelDir, FIT_MODEL_ID);
  await ensureFiles(dir, opts.baseUrl ?? env.JOBLEFT_MODEL_BASE_URL ?? FIT_MODEL_DEFAULT_BASE_URL, opts.allowDownload ?? true);
  const ort = await loadOrt(opts.ortModule ?? env.JOBLEFT_ORT_MODULE);
  const tokenizer = new WordPieceTokenizer(readFileSync(join(dir, 'vocab.txt'), 'utf8'));
  const session = await ort.InferenceSession.create(join(dir, 'onnx', 'model.onnx'), {
    executionProviders: ['cpu'], intraOpNumThreads: opts.threads ?? 8, graphOptimizationLevel: 'all',
  });
  const wantsTypes = session.inputNames.includes('token_type_ids');

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const encoded = texts.map((t) => tokenizer.encode(t));
    const len = Math.max(...encoded.map((e) => e.length));
    const n = encoded.length;
    const ids = new BigInt64Array(n * len);
    const mask = new BigInt64Array(n * len);
    encoded.forEach((e, i) => e.forEach((id, j) => { ids[i * len + j] = BigInt(id); mask[i * len + j] = 1n; }));
    for (let i = 0; i < n; i++) for (let j = encoded[i]!.length; j < len; j++) ids[i * len + j] = BigInt(tokenizer.padId);
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', ids, [n, len]),
      attention_mask: new ort.Tensor('int64', mask, [n, len]),
    };
    if (wantsTypes) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n * len), [n, len]);
    const out = await session.run(feeds);
    const hidden = out.last_hidden_state ?? Object.values(out)[0]!;
    const dim = hidden.dims[2]!;
    const vecs: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      const v = Float32Array.from(hidden.data.subarray(i * len * dim, i * len * dim + dim)); // CLS token
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < v.length; k++) v[k]! /= norm;
      vecs.push(v);
    }
    return vecs;
  }

  return {
    model: FIT_MODEL_ID,
    dims: FIT_MODEL_DIMS,
    async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 16) {
        if (signal?.aborted) throw new AiError('cancelled', 'The request was cancelled.');
        out.push(...(await embedBatch(texts.slice(i, i + 16))));
      }
      return out;
    },
  };
}
