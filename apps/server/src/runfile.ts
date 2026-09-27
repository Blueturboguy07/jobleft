// run/server.json: { pid, port, token, version, startedAt } (mode 0600), written after the server listens and removed
// on a clean exit (INTERFACES section 2). The shell, `pnpm app:up` and `pnpm app:down` read it.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Puts `tmp` in place of `file` (atomic on POSIX). On Windows a rename over a file that a scanner or a reader holds
 * open for a moment is refused with EPERM (seen after a killed server left its run file), so it retries briefly,
 * removing the old file first; never a wrong file in place, at worst a delay.
 */
function replaceFile(tmp: string, file: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (process.platform !== 'win32' || attempt >= 30) throw e;
      try { unlinkSync(file); } catch { /* already gone, or still held: the next try tells */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export interface RunInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: string;
}

export function writeRunFile(file: string, info: RunInfo): void {
  const tmp = join(dirname(file), `.server.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  replaceFile(tmp, file);
}

export function readRunFile(file: string): RunInfo | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as RunInfo;
    if (typeof v.pid === 'number' && typeof v.port === 'number' && typeof v.token === 'string') return v;
  } catch { /* none */ }
  return null;
}

/** Removes the file only when it is this process's own. */
export function removeRunFile(file: string, pid = process.pid): void {
  const v = readRunFile(file);
  if (v && v.pid !== pid) return;
  try { unlinkSync(file); } catch { /* already gone */ }
}
