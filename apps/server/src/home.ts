// The data folder (docs/INTERFACES.md section 2). Everything personal lives here and nowhere else (server O6).
// The folder is 0700 and every file the server makes is 0600 (the server also sets umask 077 in main.ts).

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The data folder: JOBLEFT_HOME when set, else the OS default
 * (macOS ~/Library/Application Support/jobleft, Windows %APPDATA%\jobleft, others ~/.local/share/jobleft).
 */
export function resolveHome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.JOBLEFT_HOME) return env.JOBLEFT_HOME;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jobleft');
}

/** Every path inside the data folder. Nothing personal is written outside it (server O6). */
export function homeLayout(home: string) {
  return {
    home,
    data: join(home, 'data'),
    db: join(home, 'data', 'jobleft.db'),
    files: join(home, 'files'),
    resumes: join(home, 'files', 'resumes'),
    exports: join(home, 'files', 'exports'),
    datasets: join(home, 'datasets'),
    models: join(home, 'models'),
    backups: join(home, 'backups'),
    logs: join(home, 'logs'),
    tmp: join(home, 'tmp'),
    run: join(home, 'run'),
    runFile: join(home, 'run', 'server.json'),
    lockFile: join(home, 'run', 'server.lock'),
  } as const;
}

export type HomeLayout = ReturnType<typeof homeLayout>;

/** A fresh launch token: 32 random bytes, base64url (43 characters). New at every launch. */
export function newLaunchToken(): string {
  return randomBytes(32).toString('base64url');
}

function mkdir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const st = statSync(dir);
    if (st.uid === process.getuid?.() && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch { /* not ours to change */ }
}

/** Creates the folder tree (0700). Safe to call again. */
export function ensureHome(l: HomeLayout): void {
  mkdir0700(l.home);
  for (const d of [l.data, l.files, l.resumes, l.exports, l.backups, l.logs, l.tmp, l.run]) mkdir0700(d);
}

/** Empties tmp/ (INTERFACES: "emptied at start and after each step"), except an interrupted restore's journal parts. */
export function cleanTmp(l: HomeLayout, keep: (name: string) => boolean = () => false): void {
  if (!existsSync(l.tmp)) return;
  for (const name of readdirSync(l.tmp)) {
    if (keep(name)) continue;
    try { rmSync(join(l.tmp, name), { recursive: true, force: true }); } catch { /* next start tries again */ }
  }
}

/** A unique name for a temporary file or folder under tmp/. */
export function tmpName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}
