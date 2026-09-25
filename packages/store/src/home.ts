// Where the store's files live ($JOBLEFT_HOME). The folder is private to the account (0700, files 0600).

import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface StoreHome {
  home: string;
  dataDir: string;
  db: string;
  models: string;
  run: string;
  logs: string;
}

/** $JOBLEFT_HOME, else the OS default (macOS ~/Library/Application Support/jobleft). */
export function resolveStoreHome(env: Record<string, string | undefined> = process.env, platform = process.platform): string {
  if (env.JOBLEFT_HOME) return resolve(env.JOBLEFT_HOME);
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jobleft');
}

export function storeHome(home: string): StoreHome {
  return {
    home,
    dataDir: join(home, 'data'),
    db: join(home, 'data', 'jobleft.db'),
    models: join(home, 'models'),
    run: join(home, 'run'),
    logs: join(home, 'logs'),
  };
}

/** Creates the folders with mode 0700 (and tightens an existing home folder). */
export function ensureHome(h: StoreHome): void {
  for (const d of [h.home, h.dataDir, h.models, h.run]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    try { chmodSync(d, 0o700); } catch { /* not ours */ }
  }
}
