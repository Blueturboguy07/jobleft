// Small helpers shared by the mock servers. Node 24, erasable TypeScript only.
// The mock stands in for apps/server so the UI lane can be built and checked on its own. It follows
// packages/contracts exactly; it is NOT the product server.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** A small seeded PRNG (mulberry32). The same seed gives the same fixtures on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)]!;
}

export function pickSome<T>(r: () => number, list: readonly T[], min: number, max: number): T[] {
  const n = min + Math.floor(r() * (max - min + 1));
  const copy = [...list];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(r() * copy.length), 1)[0]!);
  return out;
}

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A stable 32-bit number from a string (for seeds and colours). */
export function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function slug(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The company match key, same rules as @jobleft/static-data companyKey (INTERFACES section static-data). */
export function companyKey(name: string): string {
  let s = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[&+]/g, ' and ');
  s = s.replace(/^\s*the\s+/, '');
  s = s.replace(/[,.]/g, ' ');
  s = s.replace(/\b(inc|llc|l l c|corp|corporation|co|ltd|llp|plc|pbc|gmbh)\b\.?/g, ' ');
  return s.replace(/[^a-z0-9]+/g, '');
}

/**
 * Writes JSON so a crash or a force-quit never leaves a half-written file: write a temporary file, flush it to disk,
 * then rename it over the old one (rename is atomic on one file system). Throws when the folder is not writable.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Parses "--name value" and "--flag" arguments. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Loopback ports of the stand-ins (the API mock uses the real app range 47821 to 47830). */
export const PORTS = { publik: 47910, ai: 47911, boards: 47920 } as const;
