// Builds an AiEngine from the environment and the data folder, the way the CLI and the dev server do.
// Files: <JOBLEFT_HOME>/ai/state.json (key-free settings and publik connection, 0600),
//        <JOBLEFT_HOME>/secrets/ (only when JOBLEFT_SECRET_STORE=file: encrypted keys, 0600).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { AiEngine } from './engine.ts';
import { PUBLIK_DEFAULT_BASE_URL } from './publik.ts';
import { osSecretStore } from './secrets.ts';
import { fileKvStore, kvSettingsStore } from './state.ts';
import { isLoopbackHost, shortHash } from './urls.ts';

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

export function createEngineFromEnv(opts: { env?: Record<string, string | undefined>; home?: string } = {}): { engine: AiEngine; home: string; statePath: string; keysAt: string } {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveHome(env);
  const statePath = join(home, 'ai', 'state.json');
  const kv = fileKvStore(statePath);
  const secrets = osSecretStore(keychainServiceFor(home, env), { fileDir: join(home, 'secrets'), env });
  const publikBaseUrl = env.JOBLEFT_PUBLIK_BASE_URL || PUBLIK_DEFAULT_BASE_URL;
  // Gate G-publik: until the owner approves a real app token, this build never provisions against a non-loopback
  // publik address. A stand-in on 127.0.0.1 works; the live service needs JOBLEFT_PUBLIK_ALLOW_LIVE=1.
  let loopback = false;
  try { loopback = isLoopbackHost(new URL(publikBaseUrl).hostname); } catch { loopback = false; }
  const publikAppToken = loopback || env.JOBLEFT_PUBLIK_ALLOW_LIVE === '1' ? env.JOBLEFT_PUBLIK_APP_TOKEN || null : null;
  const engine = new AiEngine({
    settings: kvSettingsStore(kv),
    secrets,
    state: kv,
    env,
    publikBaseUrl,
    publikAppToken,
  });
  const choice = env.JOBLEFT_SECRET_STORE ?? (process.platform === 'darwin' ? 'keychain' : 'file');
  const keysAt = choice === 'keychain'
    ? `the macOS Keychain, service "${keychainServiceFor(home, env)}"`
    : choice === 'file' ? `an encrypted file, ${join(home, 'secrets', 'secrets.enc')}` : 'memory only (lost when the command ends)';
  return { engine, home, statePath, keysAt };
}
