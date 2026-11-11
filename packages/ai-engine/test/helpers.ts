// Test helpers: an engine on memory stores, pointed at in-process stand-ins.
import { randomUUID } from 'node:crypto';
import { AiEngine, kvSettingsStore, memoryKvStore, memoryPublikSignIn, memorySecretStore, type PublikSignInCredential } from '../src/index.ts';
import type { AiSettingsUpdate, SecretStore } from '@jobleft/contracts';
import { startMockModelServer, type MockModelOptions } from '../src/mock/model-server.ts';
import { startMockPublikServer, STANDIN_APP_TOKEN, type MockPublikOptions } from '../src/mock/publik-server.ts';

export const CANARY = 'sk-canary-7Q4Z-jobleft-test';

/**
 * What Sign in with publik does in the app (the publik module's provision()), done here by the test against the
 * stand-in: POST /installs with the app token, the key kept in memory. null token = a build without one.
 */
export function standInMint(baseUrl: string, appToken: string | null): () => Promise<PublikSignInCredential> {
  return async () => {
    if (!appToken) throw new Error('Connecting to publik is not available in this build yet (it has no publik app token). Choose a local model or your own key instead.');
    const installId = randomUUID();
    const res = await fetch(`${baseUrl}/installs`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ app_token: appToken, app_slug: 'jobleft', app_version: '0.0.0-test', os: 'macos', install_id: installId, disclosure_version: 1, dialects: ['chat_completions'] }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.status !== 201 || typeof body.key !== 'string') throw new Error(body.error?.message ?? `publik did not accept this build (HTTP ${res.status}).`);
    return { key: body.key, baseUrl: typeof body.base_url === 'string' ? body.base_url : baseUrl, installId: body.install_id ?? installId, claimUrl: body.claim_url ?? null, choice: null };
  };
}

export function makeEngine(opts: { publikBaseUrl?: string; appToken?: string | null; idleTimeoutMs?: number; connectTimeoutMs?: number; secrets?: SecretStore; env?: Record<string, string | undefined> } = {}) {
  const kv = memoryKvStore();
  const secrets = opts.secrets ?? memorySecretStore();
  const publikBaseUrl = opts.publikBaseUrl ?? 'http://127.0.0.1:9/api/v1';
  const signIn = memoryPublikSignIn(null, standInMint(publikBaseUrl, opts.appToken === undefined ? STANDIN_APP_TOKEN : opts.appToken));
  const engine = new AiEngine({
    settings: kvSettingsStore(kv), secrets, state: kv, env: opts.env ?? {},
    publikBaseUrl, publikSignIn: signIn,
    idleTimeoutMs: opts.idleTimeoutMs, connectTimeoutMs: opts.connectTimeoutMs,
  });
  return { engine, kv, secrets, signIn };
}

export async function withModel<T>(o: MockModelOptions, fn: (m: Awaited<ReturnType<typeof startMockModelServer>>) => Promise<T>): Promise<T> {
  const m = await startMockModelServer(o);
  try { return await fn(m); } finally { await m.close(); }
}

export async function withPublik<T>(o: MockPublikOptions, fn: (p: Awaited<ReturnType<typeof startMockPublikServer>>) => Promise<T>): Promise<T> {
  const p = await startMockPublikServer(o);
  try { return await fn(p); } finally { await p.close(); }
}

export async function use(engine: AiEngine, update: AiSettingsUpdate) {
  return engine.updateSettings(update);
}

export async function collect(it: AsyncIterable<{ type: string; text?: string }>) {
  let text = '';
  let last: any = null;
  for await (const c of it) { if (c.type === 'delta') text += c.text; last = c; }
  return { text, last };
}
