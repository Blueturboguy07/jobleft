// Fit scoring: centering on the average job, kept exact as vectors come and go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CENTER_WEIGHT, VectorIndex } from '../src/vectors.ts';
import { freshStore } from './helpers.ts';

const unit = (xs: number[]): Float32Array => {
  const v = new Float32Array(384);
  xs.forEach((x, i) => { v[i] = x; });
  let s = 0;
  for (const x of v) s += x * x;
  for (let i = 0; i < 384; i++) v[i]! /= Math.sqrt(s);
  return v;
};

test('fit score takes off part of the closeness to the average job, so a generic job ranks below a specific one', () => {
  const s = freshStore();
  const vi = new VectorIndex(s.db, 'test-model');
  vi.load();
  // 50 generic jobs lean on axis 0 (shared boilerplate); the specific job has the profile's duties (axis 1).
  for (let rid = 1; rid <= 50; rid++) vi.putFloat(rid, unit([0.9, 0.3 + 0.01 * (rid % 3), 0.3]), true);
  const specific = unit([0.3, 0.9, 0.3]);
  vi.putFloat(51, specific, true);
  const profile = unit([0.8, 0.6, 0]);
  const plain = (rid: number) => { const v = vi.vectorOf(rid)!; let d = 0; for (let i = 0; i < 384; i++) d += v[i]! * profile[i]!; return d; };
  // Plain cosine prefers the generic job; the centered score prefers the specific one.
  assert.ok(plain(1) > plain(51));
  vi.begin(profile);
  assert.ok(vi.scoreOne(51, profile) > vi.scoreOne(1, profile));
  // The score is cos(profile, job) - CENTER_WEIGHT * cos(average, job).
  const mean = vi.centroid();
  let md = 0;
  for (let i = 0; i < 384; i++) md += mean[i]! * specific[i]!;
  assert.ok(Math.abs(vi.scoreOne(51, profile) - (plain(51) - CENTER_WEIGHT * md)) < 1e-5);
});

test('the running average equals the average recomputed from scratch after replacing, staling and dropping vectors', () => {
  const s = freshStore();
  const vi = new VectorIndex(s.db, 'test-model');
  vi.load();
  const vecs = new Map<number, Float32Array>();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  for (let rid = 1; rid <= 40; rid++) { const v = unit(Array.from({ length: 384 }, rnd)); vecs.set(rid, v); vi.putFloat(rid, v, true); }
  for (let rid = 1; rid <= 10; rid++) { const v = unit(Array.from({ length: 384 }, rnd)); vecs.set(rid, v); vi.putFloat(rid, v, true); }
  for (let rid = 11; rid <= 15; rid++) { vi.putFloat(rid, vecs.get(rid)!, false); vecs.delete(rid); }
  const expect = new Float64Array(384);
  for (const v of vecs.values()) for (let i = 0; i < 384; i++) expect[i]! += v[i]! / vecs.size;
  const got = vi.centroid();
  for (let i = 0; i < 384; i++) assert.ok(Math.abs(got[i]! - expect[i]!) < 1e-6, `dim ${i}`);
  // Same data, same scores: a second index built from the same vectors scores identically.
  const vi2 = new VectorIndex(s.db, 'test-model');
  vi2.load();
  for (const [rid, v] of [...vecs.entries()].sort((a, b) => a[0] - b[0])) vi2.putFloat(rid, v, true);
  const p = unit([1, 2, 3]);
  vi.begin(p);
  vi2.begin(p);
  for (const rid of vecs.keys()) assert.equal(vi.scoreOne(rid, p), vi2.scoreOne(rid, p));
});
