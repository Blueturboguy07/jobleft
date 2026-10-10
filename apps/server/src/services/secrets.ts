// Where keys live (INTERFACES section 2: "Secrets live in the OS secret store, never in a plain-text file").
//   * keychain (macOS default): /usr/bin/security. The secret goes to `security -i` on stdin, hex-encoded, so it
//     never shows in a process list. One Keychain service per data folder ("jobleft-<hash>"), so a scratch folder
//     never sees another folder's keys, and a backup restored elsewhere carries none.
//   * secret-service (Linux default): the desktop keyring (GNOME Keyring, KWallet) through `secret-tool` (libsecret).
//     The secret goes in on stdin, base64-encoded, never in an argument. Same service name per data folder.
//   * file (Linux without a keyring): @jobleft/ai-engine's AES-256-GCM file store under <home>/secrets.
//   * memory: tests and other systems; keys are forgotten when the server stops.
// Interim: @jobleft/ai-engine owns the real secret store (osSecretStore). This one keeps the server whole until it lands.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { SecretStore } from '@jobleft/contracts';
import { encryptedFileSecretStore } from '@jobleft/ai-engine';
import { ApiFailure } from '../errors.ts';

const SECURITY = '/usr/bin/security';
const NAME_RE = /^[A-Za-z0-9._:@-]{1,200}$/;

export interface ServerSecretStore extends SecretStore {
  readonly kind: 'keychain' | 'secret-service' | 'file' | 'memory';
  /** Every name this store holds for this data folder (for delete-all). */
  knownNames(): string[];
}

export function memorySecrets(): ServerSecretStore {
  const m = new Map<string, string>();
  return {
    kind: 'memory',
    async get(name) { return m.get(name) ?? null; },
    async set(name, value) { m.set(name, value); },
    async delete(name) { m.delete(name); },
    knownNames: () => [...m.keys()],
  };
}

function run(args: string[], stdin?: string, bin = SECURITY): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    if (stdin === undefined) {
      execFile(bin, args, { timeout: 15_000, maxBuffer: 1 << 20 }, (err, stdout) => {
        resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') });
      });
      return;
    }
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout: '' }); });
    child.stdin.end(stdin);
  });
}

function encode(value: string): string { return `b64:${Buffer.from(value, 'utf8').toString('base64')}`; }
function decode(text: string): string | null {
  const t = text.replace(/\r?\n$/, '');
  return t.startsWith('b64:') ? Buffer.from(t.slice(4), 'base64').toString('utf8') : null;
}

export function keychainServiceFor(home: string): string {
  return `jobleft-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
}

export function keychainSecrets(service: string): ServerSecretStore {
  if (process.platform !== 'darwin' || !existsSync(SECURITY)) throw new Error('the macOS Keychain is not available');
  const names = new Set<string>();
  const check = (name: string) => { if (!NAME_RE.test(name)) throw new ApiFailure('bad_request', 'A secret name has characters that are not allowed.'); };
  return {
    kind: 'keychain',
    async get(name) {
      check(name);
      const r = await run(['find-generic-password', '-a', name, '-s', service, '-w']);
      if (r.code !== 0) return null;
      names.add(name);
      return decode(r.stdout);
    },
    async set(name, value) {
      check(name);
      if (typeof value !== 'string' || value.length === 0 || value.length > 4000) throw new ApiFailure('bad_request', 'The key is empty or too long.');
      const hex = Buffer.from(encode(value), 'utf8').toString('hex');
      const r = await run(['-i'], `add-generic-password -U -a ${name} -s ${service} -l ${service} -X ${hex}\n`);
      const back = await run(['find-generic-password', '-a', name, '-s', service, '-w']);
      if (r.code !== 0 || back.code !== 0 || decode(back.stdout) !== value) {
        throw new ApiFailure('write_failed', 'jobleft could not save the key in the macOS Keychain. Unlock the Keychain and try again.');
      }
      names.add(name);
    },
    async delete(name) {
      check(name);
      for (let i = 0; i < 5; i++) {
        const r = await run(['delete-generic-password', '-a', name, '-s', service]);
        if (r.code !== 0) break;
      }
      names.delete(name);
    },
    knownNames: () => [...names],
  };
}

/** `secret-tool` on PATH, or null. */
function findSecretTool(): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin').split(delimiter)) {
    const p = join(dir, 'secret-tool');
    if (dir && existsSync(p)) return p;
  }
  return null;
}

/** The Linux desktop keyring (Secret Service) through libsecret's `secret-tool`. */
export function secretServiceSecrets(service: string): ServerSecretStore {
  const tool = process.platform === 'linux' ? findSecretTool() : null;
  if (!tool || !process.env.DBUS_SESSION_BUS_ADDRESS) throw new Error('no Secret Service keyring is available');
  const names = new Set<string>();
  const check = (name: string) => { if (!NAME_RE.test(name)) throw new ApiFailure('bad_request', 'A secret name has characters that are not allowed.'); };
  const lookup = (name: string) => run(['lookup', 'service', service, 'account', name], undefined, tool);
  return {
    kind: 'secret-service',
    async get(name) {
      check(name);
      const r = await lookup(name);
      if (r.code !== 0) return null;
      names.add(name);
      return decode(r.stdout);
    },
    async set(name, value) {
      check(name);
      if (typeof value !== 'string' || value.length === 0 || value.length > 4000) throw new ApiFailure('bad_request', 'The key is empty or too long.');
      const r = await run(['store', `--label=${service}`, 'service', service, 'account', name], encode(value), tool);
      const back = await lookup(name);
      if (r.code !== 0 || back.code !== 0 || decode(back.stdout) !== value) {
        throw new ApiFailure('write_failed', 'jobleft could not save the key in the system keyring. Unlock the keyring and try again.');
      }
      names.add(name);
    },
    async delete(name) {
      check(name);
      await run(['clear', 'service', service, 'account', name], undefined, tool);
      names.delete(name);
    },
    knownNames: () => [...names],
  };
}

/** The encrypted file store in <home>/secrets (a keyring-less Linux). */
export function fileSecrets(home: string): ServerSecretStore {
  const inner = encryptedFileSecretStore(join(home, 'secrets'));
  const names = new Set<string>();
  return {
    kind: 'file',
    async get(name) { const v = await inner.get(name); if (v !== null) names.add(name); return v; },
    async set(name, value) { await inner.set(name, value); names.add(name); },
    async delete(name) { await inner.delete(name); names.delete(name); },
    knownNames: () => [...names],
  };
}

export function createSecretStore(kind: string | undefined, home: string): ServerSecretStore {
  if (kind === 'memory') return memorySecrets();
  if (kind === 'file') return fileSecrets(home);
  if (kind === 'keychain' || (kind === undefined && process.platform === 'darwin')) {
    try { return keychainSecrets(keychainServiceFor(home)); } catch { return memorySecrets(); }
  }
  if (kind === 'secret-service' || (kind === undefined && process.platform === 'linux')) {
    try { return secretServiceSecrets(keychainServiceFor(home)); } catch { return fileSecrets(home); }
  }
  return memorySecrets();
}
