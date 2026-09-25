// Single-instance guard: one server per data folder (INTERFACES 5.2, server O9). The lock is run/server.lock,
// created with O_EXCL. A lock left by a process that is gone (a crash, a kill -9, a reboot) is stale and is taken
// over, so a leftover file never blocks the next launch (server O11). A pid that was reused by another program is
// detected by comparing the process start time recorded in the lock with the start time `ps` reports.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

export interface LockHolder {
  pid: number;
  /** ms since the epoch when the holder process started. */
  procStart: number;
  lockedAt: string;
  nonce: string;
}

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; holder: LockHolder | null };

export function processStartMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Elapsed seconds of a process from `ps -o etime=` ([[dd-]hh:]mm:ss), or null when unknown. */
function processAgeSeconds(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } }).trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(out);
    if (!m) return null;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  } catch {
    return null;
  }
}

function readHolder(file: string): LockHolder | null {
  try {
    const h = JSON.parse(readFileSync(file, 'utf8')) as LockHolder;
    if (typeof h.pid === 'number' && typeof h.procStart === 'number') return h;
  } catch { /* partial or foreign content */ }
  return null;
}

/** True when the process that wrote the lock still runs (same pid AND same start time). */
export function holderAlive(h: LockHolder): boolean {
  if (h.pid === process.pid) return false;
  if (!isAlive(h.pid)) return false;
  const age = processAgeSeconds(h.pid);
  if (age === null) return true; // cannot tell: be safe, treat as alive
  const start = Date.now() - age * 1000;
  return Math.abs(start - h.procStart) < 5000;
}

function tryCreate(file: string, h: LockHolder): boolean {
  let fd: number;
  try { fd = openSync(file, 'wx', 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try { writeSync(fd, JSON.stringify(h)); fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

export function acquireLock(file: string): LockResult {
  const me: LockHolder = { pid: process.pid, procStart: processStartMs(), lockedAt: new Date().toISOString(), nonce: randomBytes(8).toString('hex') };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(file, me)) {
      if (attempt > 0) {
        // We removed a stale lock first. Another starter may have removed it at the same moment and then removed
        // ours: read it back after a short pause, and step back when it is no longer ours.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        const back = readHolder(file);
        if (!back || back.nonce !== me.nonce) return { ok: false, holder: back };
      }
      return {
        ok: true,
        release: () => {
          const h = readHolder(file);
          if (h && h.nonce === me.nonce) { try { unlinkSync(file); } catch { /* gone */ } }
        },
      };
    }
    const holder = readHolder(file);
    if (holder && holderAlive(holder)) return { ok: false, holder };
    if (!holder) {
      // Unreadable content: a writer may be half-way. Give a young file a moment, then treat it as stale.
      try { if (Date.now() - statSync(file).mtimeMs < 2000) return { ok: false, holder: null }; } catch { continue; }
    }
    try { unlinkSync(file); } catch { /* another starter removed it first */ }
  }
  return { ok: false, holder: readHolder(file) };
}
