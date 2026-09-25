// run/server.json: { pid, port, token, version, startedAt } (mode 0600), written after the server listens and removed
// on a clean exit (INTERFACES section 2). The shell, `pnpm app:up` and `pnpm app:down` read it.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  renameSync(tmp, file);
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
