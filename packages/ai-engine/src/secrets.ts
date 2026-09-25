// Where keys live (ai-engine O8). Never in a plain-text file, never in a log, never in an argument list.
//   * keychainSecretStore: the macOS Keychain through /usr/bin/security. The secret goes to `security -i` on stdin
//     (hex-encoded), so it never appears in a process list. Items: service "jobleft" (or "jobleft-<hash>" for a
//     non-default data folder), account = the secret name.
//   * encryptedFileSecretStore: AES-256-GCM in <dir>/secrets.enc (mode 0600, folder 0700), with a random 32-byte
//     master key in <dir>/master.key (0600). It stops plain-text search and accidental copies; it cannot stop a
//     program that runs as the same user and reads both files. Backups and exports must leave <dir> out.
//   * memorySecretStore: tests.

import { execFile, spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretStore } from '@jobleft/contracts';
import { AiError } from './errors.ts';

const SECURITY = '/usr/bin/security';
const NAME_RE = /^[A-Za-z0-9._:@-]{1,200}$/;

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new AiError('bad_request', 'A secret name has characters that are not allowed.');
}

function checkValue(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4000) throw new AiError('bad_request', 'The key is empty or too long.');
}

function run(args: string[], stdin?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    if (stdin === undefined) {
      execFile(SECURITY, args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      });
      return;
    }
    const child = spawn(SECURITY, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', () => { /* never echoed: it can name the item */ });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout: '' }); });
    child.stdin.end(stdin);
  });
}

/** The Keychain item's password text: "b64:" + base64 of the UTF-8 secret (printable, unambiguous). */
function encodeForKeychain(value: string): string {
  return `b64:${Buffer.from(value, 'utf8').toString('base64')}`;
}

function decodeFromKeychain(text: string): string | null {
  const t = text.replace(/\r?\n$/, '');
  if (!t.startsWith('b64:')) return null;
  return Buffer.from(t.slice(4), 'base64').toString('utf8');
}

/** macOS Keychain through the security CLI. */
export function keychainSecretStore(service = 'jobleft'): SecretStore {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(service)) throw new AiError('bad_request', 'The Keychain service name is not valid.');
  if (process.platform !== 'darwin' || !existsSync(SECURITY)) {
    throw new AiError('not_ready', 'The macOS Keychain is not available on this computer. Use the encrypted file store (JOBLEFT_SECRET_STORE=file).');
  }
  return {
    async get(name) {
      checkName(name);
      const r = await run(['find-generic-password', '-a', name, '-s', service, '-w']);
      if (r.code !== 0) return null;
      return decodeFromKeychain(r.stdout);
    },
    async set(name, value) {
      checkName(name);
      checkValue(value);
      const hex = Buffer.from(encodeForKeychain(value), 'utf8').toString('hex');
      // -U updates an existing item, so a second save never leaves two keys.
      const r = await run(['-i'], `add-generic-password -U -a ${name} -s ${service} -l ${service} -X ${hex}\n`);
      const back = await run(['find-generic-password', '-a', name, '-s', service, '-w']);
      if (r.code !== 0 || back.code !== 0 || decodeFromKeychain(back.stdout) !== value) {
        throw new AiError('not_ready', 'jobleft could not save the key in the macOS Keychain. Unlock the Keychain and try again.');
      }
    },
    async delete(name) {
      checkName(name);
      // Delete every copy (there should be one; this also clears copies left by an older build).
      for (let i = 0; i < 5; i++) {
        const r = await run(['delete-generic-password', '-a', name, '-s', service]);
        if (r.code !== 0) break;
      }
    },
  };
}

interface EncFile {
  v: 1;
  entries: Record<string, { iv: string; tag: string; ct: string }>;
}

/** AES-256-GCM file store (mode 0600). See the file header for what it protects against. */
export function encryptedFileSecretStore(dir: string, opts: { masterKeyFile?: string } = {}): SecretStore {
  const file = join(dir, 'secrets.enc');
  const masterFile = opts.masterKeyFile ?? join(dir, 'master.key');

  function ensureDir() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  }
  function masterKey(create: boolean): Buffer | null {
    if (existsSync(masterFile)) {
      const k = readFileSync(masterFile);
      if (k.length !== 32) throw new AiError('not_ready', 'The key file of the encrypted secret store is damaged. Forget the saved keys and save them again.');
      return k;
    }
    if (!create) return null;
    ensureDir();
    const k = randomBytes(32);
    writeFileSync(masterFile, k, { mode: 0o600, flag: 'wx' });
    return k;
  }
  function load(): EncFile {
    if (!existsSync(file)) return { v: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as EncFile;
      if (parsed?.v === 1 && parsed.entries && typeof parsed.entries === 'object') return parsed;
    } catch { /* damaged */ }
    throw new AiError('not_ready', 'The encrypted secret store is damaged. Forget the saved keys and save them again.');
  }
  function save(data: EncFile) {
    ensureDir();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* ignore */ }
  }
  return {
    async get(name) {
      checkName(name);
      const key = masterKey(false);
      if (!key) return null;
      const e = load().entries[name];
      if (!e) return null;
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
        d.setAAD(Buffer.from(name, 'utf8'));
        d.setAuthTag(Buffer.from(e.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
    async set(name, value) {
      checkName(name);
      checkValue(value);
      const key = masterKey(true)!;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(name, 'utf8'));
      const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      const data = load();
      data.entries[name] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
      save(data);
    },
    async delete(name) {
      checkName(name);
      if (!existsSync(file)) return;
      const data = load();
      if (!(name in data.entries)) return;
      delete data.entries[name];
      save(data);
    },
  };
}

/** In-memory secrets for tests. */
export function memorySecretStore(): SecretStore {
  const m = new Map<string, string>();
  return {
    async get(name) { return m.get(name) ?? null; },
    async set(name, value) { m.set(name, value); },
    async delete(name) { m.delete(name); },
  };
}

/**
 * The OS secret store: the macOS Keychain on macOS; elsewhere the encrypted file store in `fileDir`
 * (Windows Credential Manager is not wired yet). JOBLEFT_SECRET_STORE=keychain|file overrides the choice.
 */
export function osSecretStore(service = 'jobleft', opts: { fileDir?: string; env?: Record<string, string | undefined> } = {}): SecretStore {
  const env = opts.env ?? process.env;
  const choice = env.JOBLEFT_SECRET_STORE ?? (process.platform === 'darwin' ? 'keychain' : 'file');
  if (choice === 'keychain') return keychainSecretStore(service);
  if (choice === 'file') {
    if (!opts.fileDir) throw new AiError('not_ready', 'The encrypted file store needs a folder (the data folder\'s secrets/ folder).');
    return encryptedFileSecretStore(opts.fileDir);
  }
  if (choice === 'memory') return memorySecretStore();
  throw new AiError('bad_request', 'JOBLEFT_SECRET_STORE must be keychain, file or memory.');
}
