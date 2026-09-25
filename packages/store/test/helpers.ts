// Test helpers: a fresh in-memory store, a hand-written job maker (persona-free), and a deterministic fake embedder.
import type { Embedder, Job } from '@jobleft/contracts';
import { migrate, openDatabase, JobStore } from '../src/index.ts';

export const NOW = Date.parse('2026-09-25T12:00:00Z');
export const CTX = { profileVector: null, h1b: null, places: null, now: NOW };

export function freshStore(): JobStore {
  const db = openDatabase(':memory:');
  migrate(db);
  return new JobStore(db);
}

let n = 0;
/** A lenient input job. Every fact is written here; nothing is filled by default. */
export function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  n++;
  return {
    id: `t:acme:${n}`,
    title: `Operations Coordinator ${n}`,
    company: 'Acme Health',
    url: `https://jobs.example.com/acme/${n}`,
    description: 'Coordinate schedules and keep records current.',
    postedAt: '2026-09-20T15:00:00Z',
    ...over,
  };
}

/** A deterministic bag-of-words vector (same words, similar vectors). Only for tests: no semantics beyond words. */
export class WordEmbedder implements Embedder {
  readonly model = 'bge-small-en-v1.5';
  readonly dims = 384;
  calls = 0;
  texts = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.texts += texts.length;
    return texts.map((t) => {
      const v = new Float32Array(384);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        v[(h >>> 0) % 384]! += 1;
      }
      let s = 0;
      for (const x of v) s += x * x;
      s = Math.sqrt(s) || 1;
      for (let i = 0; i < 384; i++) v[i]! /= s;
      return v;
    });
  }
}

export function ids(items: Array<{ job: Pick<Job, 'id'> }>): string[] {
  return items.map((i) => i.job.id);
}
