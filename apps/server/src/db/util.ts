// Small database helpers shared by the server's services.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonSchema } from '@jobleft/contracts';
import { storageProblem, writeFailed } from '../errors.ts';

/**
 * Runs fn in one write transaction. Everything in it is saved together or not at all (server O5: no half-written
 * record). A storage failure (full disk, read-only file) becomes a plain `write_failed` answer.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (e) {
    const p = storageProblem(e);
    if (p) throw writeFailed(p);
    throw e;
  }
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back by SQLite */ }
    const p = storageProblem(e);
    if (p) throw writeFailed(p);
    throw e;
  }
}

/** A new random id: "<prefix>_<16 hex>". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export function b(v: boolean): number { return v ? 1 : 0; }

/**
 * Keeps only what a contract declares: unknown keys of objects are dropped (contracts allow unknown keys so newer
 * writers never break older readers, but the server stores only what it understands). Arrays and anyOf branches are
 * pruned recursively.
 */
export function prune(schema: JsonSchema, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      if (branch.type === 'null' && value === null) return null;
      if (branch.type === 'object' && typeof value === 'object' && !Array.isArray(value)) return prune(branch, value);
      if (branch.type === 'array' && Array.isArray(value)) return prune(branch, value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return schema.items ? value.map((v) => prune(schema.items!, v)) : value;
  }
  if (typeof value === 'object' && schema.type === 'object') {
    if (!schema.properties) return value; // a record (rec): keys are data
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const ps = schema.properties[k];
      if (ps && v !== undefined) out[k] = prune(ps, v);
    }
    return out;
  }
  return value;
}
