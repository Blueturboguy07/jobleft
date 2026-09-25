// The fit model in a worker thread. ONNX Runtime's run() keeps the calling thread busy for the whole batch, so in
// the app the model lives here and the main thread stays free to answer searches while a backlog is indexed.

import { parentPort, Worker, isMainThread, workerData } from 'node:worker_threads';
import { MODEL_DIMS, MODEL_ID } from './model.ts';
import { JOB_MAX_TOKENS, type LocalEmbedder } from './onnx.ts';

interface Request { id: number; type: 'embed' | 'close'; texts?: string[]; maxTokens?: number }
interface Reply { id: number; ok: boolean; vecs?: Float32Array[]; error?: string }

if (!isMainThread && parentPort && (workerData as { jobleftEmbedWorker?: boolean } | null)?.jobleftEmbedWorker) {
  const { modelDir, threads } = workerData as { modelDir: string; threads?: number };
  const port = parentPort;
  const ready = import('./onnx.ts').then((m) => m.createBgeEmbedder({ modelDir, threads }));
  port.on('message', (m: Request) => {
    void (async () => {
      try {
        const e = await ready;
        if (m.type === 'close') { await e.close(); port.postMessage({ id: m.id, ok: true } satisfies Reply); port.close(); return; }
        const vecs = await e.embedWith(m.texts ?? [], m.maxTokens ?? JOB_MAX_TOKENS);
        port.postMessage({ id: m.id, ok: true, vecs } satisfies Reply, vecs.map((v) => v.buffer as ArrayBuffer));
      } catch (err) {
        port.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Reply);
      }
    })();
  });
}

/** The embedder, running in a worker thread. Resolves once the model has loaded (or rejects with the reason). */
export async function createWorkerEmbedder(opts: { modelDir: string; threads?: number }): Promise<LocalEmbedder> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { jobleftEmbedWorker: true, modelDir: opts.modelDir, threads: opts.threads } });
  worker.unref();
  let next = 1;
  const waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
  worker.on('message', (r: Reply) => {
    const w = waiting.get(r.id);
    if (!w) return;
    waiting.delete(r.id);
    if (r.ok) w.resolve(r.vecs ?? []); else w.reject(new Error(r.error ?? 'embedding failed'));
  });
  const fail = (e: Error) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
  worker.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
  worker.on('exit', (code) => { if (code !== 0) fail(new Error(`the embedding worker stopped (${code})`)); });
  const send = (type: Request['type'], texts?: string[], maxTokens?: number): Promise<Float32Array[]> => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    worker.ref();
    worker.postMessage({ id, type, texts, maxTokens } satisfies Request);
  }).finally(() => { if (waiting.size === 0) worker.unref(); }) as Promise<Float32Array[]>;
  // Load check: one tiny embedding proves the model opened.
  await send('embed', ['ok'], 8);
  const embedWith = (texts: string[], maxTokens: number, signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(new Error('embedding cancelled'));
    return send('embed', texts, maxTokens);
  };
  return {
    model: MODEL_ID,
    dims: MODEL_DIMS,
    embed: (texts, signal) => embedWith(texts, JOB_MAX_TOKENS, signal),
    embedWith,
    close: async () => { try { await send('close'); } catch { /* already gone */ } await worker.terminate(); },
  };
}
