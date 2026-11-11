// Builds an AiEngine from the environment and the data folder, the way the CLI and the dev server do.
// Files: <JOBLEFT_HOME>/ai/state.json (key-free settings and publik connection, 0600),
//        <JOBLEFT_HOME>/secrets/ (only when JOBLEFT_SECRET_STORE=file: encrypted keys, 0600).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { AiEngine } from './engine.ts';
import { memoryPublikSignIn, PUBLIK_DEFAULT_BASE_URL, type PublikSignIn } from './publik.ts';
import { osSecretStore } from './secrets.ts';
import { fileKvStore, kvSettingsStore } from './state.ts';
import { shortHash } from './urls.ts';

/** The data folder: JOBLEFT_HOME, else the OS default (same rule as apps/server resolveHome). */
export function resolveHome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.JOBLEFT_HOME) return env.JOBLEFT_HOME;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jobleft');
}

/** The Keychain service for a data folder: "jobleft" for the default folder, "jobleft-<hash>" for any other. */
export function keychainServiceFor(home: string, env: Record<string, string | undefined> = process.env): string {
  const defaultHome = resolveHome({ ...env, JOBLEFT_HOME: undefined });
  return home === defaultHome ? 'jobleft' : `jobleft-${shortHash(home).slice(0, 10)}`;
}

/**
 * The CLI's sign-in: Sign in with publik happens in the jobleft app (the server's publik module), not here. For
 * development, PUBLIK_API_KEY (and PUBLIK_API_BASE_URL) in the environment stand in for a signed-in computer, the
 * same override the publik module honours.
 */
export function envPublikSignIn(env: Record<string, string | undefined> = process.env): PublikSignIn {
  const key = env.PUBLIK_API_KEY?.trim();
  const base = (env.PUBLIK_API_BASE_URL || env.JOBLEFT_PUBLIK_BASE_URL || PUBLIK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return memoryPublikSignIn(key && key.startsWith('pk_') ? { key, baseUrl: base, installId: 'env', claimUrl: null, choice: 'publik' } : null);
}

export function createEngineFromEnv(opts: { env?: Record<string, string | undefined>; home?: string } = {}): { engine: AiEngine; home: string; statePath: string; keysAt: string } {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveHome(env);
  const statePath = join(home, 'ai', 'state.json');
  const kv = fileKvStore(statePath);
  const secrets = osSecretStore(keychainServiceFor(home, env), { fileDir: join(home, 'secrets'), env });
  const publikBaseUrl = env.JOBLEFT_PUBLIK_BASE_URL || PUBLIK_DEFAULT_BASE_URL;
  const engine = new AiEngine({
    settings: kvSettingsStore(kv),
    secrets,
    state: kv,
    env,
    publikBaseUrl,
    publikSignIn: envPublikSignIn(env),
  });
  const choice = env.JOBLEFT_SECRET_STORE ?? (process.platform === 'darwin' ? 'keychain' : 'file');
  const keysAt = choice === 'keychain'
    ? `the macOS Keychain, service "${keychainServiceFor(home, env)}"`
    : choice === 'file' ? `an encrypted file, ${join(home, 'secrets', 'secrets.enc')}` : 'memory only (lost when the command ends)';
  return { engine, home, statePath, keysAt };
}
