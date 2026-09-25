// Test helpers: an assistant on an in-memory database, the stand-in world, an engine on memory stores, and stand-in servers.
import { AiEngine, kvSettingsStore, memoryKvStore, memorySecretStore } from '@jobleft/ai-engine';
import type { ChatRequest, ChatStreamEvent } from '@jobleft/contracts';
import { Assistant, openAssistantDb } from '../src/index.ts';
import { startScriptedModel, type Script, type ScriptedModelServer } from '../src/mock/scripted-model.ts';
import { World } from '../src/standin/world.ts';
import { demoData, scenarioExtras } from '../src/standin/persona.ts';
import { startMockPublikServer, STANDIN_APP_TOKEN, type MockPublikOptions } from '../../ai-engine/src/mock/publik-server.ts';

export interface Rig {
  assistant: Assistant;
  world: World;
  engine: AiEngine;
  model: ScriptedModelServer;
  close(): Promise<void>;
}

export async function makeRig(opts: { script?: Script; extras?: boolean; env?: Record<string, string | undefined>; publikBaseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<Rig> {
  const model = await startScriptedModel({ script: opts.script });
  const kv = memoryKvStore();
  const engine = new AiEngine({
    settings: kvSettingsStore(kv), secrets: memorySecretStore(), state: kv, env: opts.env ?? {},
    publikBaseUrl: opts.publikBaseUrl ?? 'http://127.0.0.1:9/api/v1', publikAppToken: STANDIN_APP_TOKEN,
  });
  const upd = await engine.updateSettings({ provider: 'custom', baseUrl: model.url, model: 'scripted-model' });
  if (!upd.check.ok) throw new Error('the stand-in model failed its setup check: ' + upd.check.message);
  const seed = demoData();
  if (opts.extras) { const x = scenarioExtras(); seed.jobs.push(...x.jobs); seed.tracker.push(...x.tracker); }
  const world = new World(seed, null);
  const db = openAssistantDb(':memory:');
  const assistant = new Assistant({ engine, api: world.asApi(), db, env: { JOBLEFT_TZ: 'America/Chicago' }, fetchImpl: opts.fetchImpl });
  return { assistant, world, engine, model, close: () => model.close() };
}

let n = 0;
export function chatReq(text: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return { requestId: `req-${++n}`, messages: [{ role: 'user', content: text }], ...extra };
}

export async function runChat(a: Assistant, req: ChatRequest): Promise<{ events: ChatStreamEvent[]; text: string; done: Extract<ChatStreamEvent, { type: 'done' }> | null; error: Extract<ChatStreamEvent, { type: 'error' }> | null; proposals: Array<Extract<ChatStreamEvent, { type: 'proposal' }>['proposal']> }> {
  const events: ChatStreamEvent[] = [];
  for await (const e of a.chatEvents(req)) events.push(e);
  return {
    events,
    text: events.filter((e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text).join(''),
    done: (events.find((e) => e.type === 'done') as never) ?? null,
    error: (events.find((e) => e.type === 'error') as never) ?? null,
    proposals: events.filter((e): e is Extract<ChatStreamEvent, { type: 'proposal' }> => e.type === 'proposal').map((e) => e.proposal),
  };
}

export { startScriptedModel, startMockPublikServer, STANDIN_APP_TOKEN, type MockPublikOptions };
