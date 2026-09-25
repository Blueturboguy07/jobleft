// Test helpers: an engine on memory stores, pointed at in-process stand-ins.
import { AiEngine, kvSettingsStore, memoryKvStore, memorySecretStore } from '../src/index.ts';
import type { AiSettingsUpdate, SecretStore } from '@jobleft/contracts';
import { startMockModelServer, type MockModelOptions } from '../src/mock/model-server.ts';
import { startMockPublikServer, STANDIN_APP_TOKEN, type MockPublikOptions } from '../src/mock/publik-server.ts';

export const CANARY = 'sk-canary-7Q4Z-jobleft-test';

export function makeEngine(opts: { publikBaseUrl?: string; appToken?: string | null; idleTimeoutMs?: number; connectTimeoutMs?: number; secrets?: SecretStore; env?: Record<string, string | undefined> } = {}) {
  const kv = memoryKvStore();
  const secrets = opts.secrets ?? memorySecretStore();
  const engine = new AiEngine({
    settings: kvSettingsStore(kv), secrets, state: kv, env: opts.env ?? {},
    publikBaseUrl: opts.publikBaseUrl ?? 'http://127.0.0.1:9/api/v1',
    publikAppToken: opts.appToken === undefined ? STANDIN_APP_TOKEN : opts.appToken,
    idleTimeoutMs: opts.idleTimeoutMs, connectTimeoutMs: opts.connectTimeoutMs,
  });
  return { engine, kv, secrets };
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
