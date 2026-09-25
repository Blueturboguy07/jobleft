// bge-small-en-v1.5 fp32 on ONNX Runtime (CPU only; spike S2: CoreML was 7 to 10 times slower and the int8 model
// is rejected). CLS pooling, L2-normalised, 384 dimensions. Batches of 16, texts sorted by length to cut padding.

import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from '@jobleft/contracts';
import { MODEL_DIMS, MODEL_ID, readTokenizerFiles } from './model.ts';
import { WordPieceTokenizer } from './tokenizer.ts';

export const BATCH = 16;
/** Job texts are about 200 tokens; 256 keeps the whole excerpt. The profile uses up to 512. */
export const JOB_MAX_TOKENS = 256;

export interface LocalEmbedder extends Embedder {
  /** Embeds with an explicit token limit (the profile text uses 512). */
  embedWith(texts: string[], maxTokens: number, signal?: AbortSignal): Promise<Float32Array[]>;
  close(): Promise<void>;
}

interface OrtTensor { data: Float32Array; dims: readonly number[] }
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
interface OrtModule {
  InferenceSession: { create(path: string, opts: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

export function defaultThreads(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

export async function createBgeEmbedder(opts: { modelDir: string; threads?: number }): Promise<LocalEmbedder> {
  const ort = (await import('onnxruntime-node')) as unknown as OrtModule;
  const { vocab, lowercase } = readTokenizerFiles(opts.modelDir);
  const tok = new WordPieceTokenizer(vocab, { lowercase });
  const session = await ort.InferenceSession.create(join(opts.modelDir, 'onnx', 'model.onnx'), {
    executionProviders: ['cpu'],
    intraOpNumThreads: opts.threads ?? defaultThreads(),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
  });
  const hasTypeIds = session.inputNames.includes('token_type_ids');
  const outName = session.outputNames.includes('last_hidden_state') ? 'last_hidden_state' : session.outputNames[0]!;

  async function runBatch(ids: number[][]): Promise<Float32Array[]> {
    const b = ids.length;
    const len = Math.max(...ids.map((x) => x.length));
    const inputIds = new BigInt64Array(b * len);
    const mask = new BigInt64Array(b * len);
    for (let i = 0; i < b; i++) {
      const row = ids[i]!;
      for (let t = 0; t < len; t++) {
        if (t < row.length) { inputIds[i * len + t] = BigInt(row[t]!); mask[i * len + t] = 1n; }
        else { inputIds[i * len + t] = BigInt(tok.padId); }
      }
    }
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', inputIds, [b, len]),
      attention_mask: new ort.Tensor('int64', mask, [b, len]),
    };
    if (hasTypeIds) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(b * len), [b, len]);
    const out = await session.run(feeds);
    const t = out[outName]!;
    const hidden = t.dims[t.dims.length - 1]!;
    const seq = t.dims.length === 3 ? t.dims[1]! : 1;
    const vecs: Float32Array[] = [];
    for (let i = 0; i < b; i++) {
      const v = new Float32Array(MODEL_DIMS);
      const base = i * seq * hidden; // CLS token = position 0
      let norm = 0;
      for (let d = 0; d < MODEL_DIMS; d++) { const x = t.data[base + d]!; v[d] = x; norm += x * x; }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < MODEL_DIMS; d++) v[d]! /= norm;
      vecs.push(v);
    }
    return vecs;
  }

  async function embedWith(texts: string[], maxTokens: number, signal?: AbortSignal): Promise<Float32Array[]> {
    const encoded = texts.map((t, i) => ({ i, ids: tok.encode(t, maxTokens) }));
    const order = [...encoded].sort((a, b) => a.ids.length - b.ids.length);
    const out: Float32Array[] = new Array(texts.length);
    for (let s = 0; s < order.length; s += BATCH) {
      if (signal?.aborted) throw new Error('embedding cancelled');
      const part = order.slice(s, s + BATCH);
      const vecs = await runBatch(part.map((p) => p.ids));
      part.forEach((p, k) => { out[p.i] = vecs[k]!; });
    }
    return out;
  }

  return {
    model: MODEL_ID,
    dims: MODEL_DIMS,
    embed: (texts, signal) => embedWith(texts, JOB_MAX_TOKENS, signal),
    embedWith,
    close: async () => { await session.release(); },
  };
}
