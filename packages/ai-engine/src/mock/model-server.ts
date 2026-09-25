// Stand-in model server (test tool). One loopback server that speaks three dialects:
//   OpenAI style  GET /v1/models, POST /v1/chat/completions, POST /v1/embeddings (also without /v1)
//   Ollama        GET /api/version, GET /api/tags, POST /api/show, POST /api/chat, POST /api/embed
//   Anthropic     POST /v1/messages (GET /v1/models is shared)
// A tester sets a mode to make it answer, stream slowly, stall, refuse the key, say "model not found", send a web
// page, send broken text, and more. Every request is logged with its headers (GET /__admin/log, or --log FILE).

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { answerFor, instanceOf, lastUserText, pieces, readBody, RequestLog, sendJson, sleep } from './common.ts';

export const MODEL_MODES = [
  'ok', 'slow', 'stall', 'stall-after-headers', 'half', 'refuse-key', 'model-not-found', 'html', 'broken', 'empty',
  'cutoff', 'text', 'badscore', 'think', 'think-only', 'error500',
] as const;
export type ModelMode = (typeof MODEL_MODES)[number];

export const MODE_HELP: Record<ModelMode, string> = {
  ok: 'answers normally ("ready" to the setup test; a value that fits the schema to structured requests)',
  slow: 'answers normally, one small piece every --slow-ms (default 1000 ms)',
  stall: 'accepts the connection and sends nothing at all, never',
  'stall-after-headers': 'sends the headers of a stream, then nothing, never',
  half: 'streams half of the answer, then drops the connection',
  'refuse-key': 'answers 401 to every AI request (and echoes the key it got in the error text, to catch leaks)',
  'model-not-found': 'lists its models, but answers 404 "model does not exist" to every chat',
  html: 'answers every request with a web page (200, text/html)',
  broken: 'streams one good piece, then text that is not JSON',
  empty: 'streams a complete answer with no text',
  cutoff: 'streams half of the answer and says it hit the length limit',
  text: 'answers plain text, also when JSON is asked for',
  badscore: 'answers JSON with 140 in every number (out of range)',
  think: 'starts the answer with an inline <think>...</think> block',
  'think-only': 'sends only thinking text and no answer',
  error500: 'answers 500 to every AI request',
};

export interface MockModelOptions {
  port?: number;
  mode?: ModelMode;
  /** When set, every AI request must carry this key (Bearer, or x-api-key for Anthropic). */
  key?: string | null;
  models?: string[];
  /** Ollama models that can think (their /api/show capabilities include "thinking"). */
  thinkingModels?: string[];
  slowMs?: number;
  log?: string | null;
  name?: string;
}

export interface MockModelServer {
  port: number;
  url: string;
  log: RequestLog;
  setMode(mode: ModelMode): void;
  close(): Promise<void>;
}

const HTML = '<!DOCTYPE html><html><head><title>Welcome</title></head><body><h1>It works!</h1><p>This is a web page, not an AI server.</p></body></html>';

export async function startMockModelServer(opts: MockModelOptions = {}): Promise<MockModelServer> {
  let mode: ModelMode = opts.mode ?? 'ok';
  let slowMs = opts.slowMs ?? 1000;
  let key = opts.key ?? null;
  const models = opts.models?.length ? opts.models : ['standin-7b', 'standin-think-8b', 'standin-embed'];
  const thinking = new Set(opts.thinkingModels ?? ['standin-think-8b']);
  const log = new RequestLog(opts.name ?? 'model', opts.log ?? null);
  const sockets = new Set<Socket>();

  const keyOk = (req: http.IncomingMessage, anthropic: boolean): boolean => {
    if (!key) return true;
    if (anthropic || req.headers['anthropic-version']) return req.headers['x-api-key'] === key;
    return req.headers.authorization === `Bearer ${key}`;
  };
  const givenKey = (req: http.IncomingMessage): string => {
    const a = req.headers.authorization ?? '';
    return (a.startsWith('Bearer ') ? a.slice(7) : String(req.headers['x-api-key'] ?? '')).slice(0, 200);
  };

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const entry = log.add(req, body);
    let json: Record<string, any> = {};
    try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }

    // ---- admin (for testers): GET /__admin/state, POST /__admin/mode {mode, slowMs?, key?}, GET /__admin/log
    if (path === '/__admin/state') return sendJson(res, 200, { mode, slowMs, keyRequired: !!key, models, requests: log.entries.length });
    if (path === '/__admin/log') return sendJson(res, 200, log.entries);
    if (path === '/__admin/mode' && req.method === 'POST') {
      if (json.mode && !(MODEL_MODES as readonly string[]).includes(json.mode)) return sendJson(res, 400, { error: `mode must be one of ${MODEL_MODES.join(', ')}` });
      if (json.mode) mode = json.mode;
      if (typeof json.slowMs === 'number') slowMs = json.slowMs;
      if (json.key !== undefined) key = json.key || null;
      return sendJson(res, 200, { mode, slowMs, keyRequired: !!key });
    }

    const isAi = path !== '/' && !path.startsWith('/__admin');
    if (isAi && mode === 'html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    if (isAi && mode === 'stall') { log.note(entry, 'stalled'); return; /* never answer */ }

    const anthropic = path === '/v1/messages';
    const ollama = path.startsWith('/api/');
    if (isAi && !ollama && (!keyOk(req, anthropic) || (mode === 'refuse-key' && path !== '/api/version'))) {
      log.note(entry, 'key refused', 401);
      if (anthropic) return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${givenKey(req)}` } });
      return sendJson(res, 401, { error: { message: `Incorrect API key provided: ${givenKey(req)}. You can find your API key at the stand-in.`, type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    if (isAi && ollama && (mode === 'refuse-key' || (key && req.headers.authorization !== `Bearer ${key}`))) {
      log.note(entry, 'key refused', 401);
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    if (isAi && mode === 'error500' && req.method === 'POST') { log.note(entry, 'error 500', 500); return sendJson(res, 500, { error: { message: 'internal stand-in error', type: 'server_error' } }); }

    // ---- model lists
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      return sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', type: 'model', owned_by: 'stand-in' })) });
    }
    if (req.method === 'GET' && path === '/api/version') return sendJson(res, 200, { version: '0.0.0-standin' });
    if (req.method === 'GET' && path === '/api/tags') {
      return sendJson(res, 200, { models: models.map((name) => ({ name, model: name, size: 1, details: { family: 'standin' } })) });
    }
    if (req.method === 'POST' && path === '/api/show') {
      const name = String(json.model ?? json.name ?? '');
      if (!models.some((m) => sameName(m, name))) return sendJson(res, 404, { error: `model '${name}' not found` });
      const caps = /embed/.test(name) ? ['embedding'] : thinking.has(name) ? ['completion', 'thinking'] : ['completion'];
      return sendJson(res, 200, { capabilities: caps, details: { family: 'standin' }, model_info: { 'standin.context_length': 8192 } });
    }
    if (req.method === 'POST' && (path === '/api/pull' || path === '/api/create' || path === '/api/delete')) {
      log.note(entry, 'REFUSED: model management', 403);
      return sendJson(res, 403, { error: 'this stand-in never downloads or changes models' });
    }

    // ---- embeddings
    if (req.method === 'POST' && (path === '/v1/embeddings' || path === '/embeddings' || path === '/api/embed')) {
      const input: string[] = Array.isArray(json.input) ? json.input : [String(json.input ?? '')];
      const vecs = input.map((t) => vector(String(t)));
      if (path === '/api/embed') return sendJson(res, 200, { model: json.model, embeddings: vecs });
      return sendJson(res, 200, { object: 'list', data: vecs.map((embedding, index) => ({ object: 'embedding', index, embedding })), model: json.model });
    }

    // ---- chat
    const isChat = req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions' || path === '/api/chat' || anthropic);
    if (!isChat) return sendJson(res, 404, { error: { message: `no route ${req.method} ${path}`, type: 'not_found' } });

    const model = String(json.model ?? '');
    if (ollama && json.think !== undefined && !thinking.has(model)) {
      log.note(entry, 'think sent to a model that cannot think', 400);
      return sendJson(res, 400, { error: `registry.ollama.ai/library/${model} does not support thinking` });
    }
    if (mode === 'model-not-found' || !models.some((m) => sameName(m, model))) {
      log.note(entry, 'model not found', 404);
      if (ollama) return sendJson(res, 404, { error: `model "${model}" not found, try pulling it first` });
      if (anthropic) return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `model: ${model}` } });
      return sendJson(res, 404, { error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } });
    }

    // Tool use: with tools and mode "ok", the first answer is one call of the first tool; after a tool result, text.
    const tools: any[] = Array.isArray(json.tools) ? json.tools : [];
    const lastMsg = Array.isArray(json.messages) ? json.messages.at(-1) : null;
    const toolResult = lastMsg?.role === 'tool' ? String(lastMsg.content ?? '')
      : Array.isArray(lastMsg?.content) ? lastMsg.content.filter((p: any) => p?.type === 'tool_result').map((p: any) => String(p.content ?? '')).join(' ') || null : null;
    if (mode === 'ok' && tools.length && toolResult === null) {
      const t = tools[0];
      const name = String(t.function?.name ?? t.name ?? 'tool');
      const args = instanceOf(t.function?.parameters ?? t.input_schema ?? t.parameters);
      const argText = JSON.stringify(args);
      log.note(entry, `tool call ${name}`);
      if (ollama) {
        const line = { model, message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false };
        if (json.stream === false) return sendJson(res, 200, { ...line, done: true, done_reason: 'stop' });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify(line) + '\n');
        res.end(JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (anthropic) {
        const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
        ev('message_start', { type: 'message_start', message: { id: 'standin', role: 'assistant', model } });
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_standin_1', name, input: {} } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argText.slice(0, 5) } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argText.slice(5) } });
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } });
        ev('message_stop', { type: 'message_stop' });
        res.end();
        return;
      }
      const chunk = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'standin', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ tool_calls: [{ index: 0, id: 'call_standin_1', type: 'function', function: { name, arguments: '' } }] }, null);
      chunk({ tool_calls: [{ index: 0, function: { arguments: argText.slice(0, 5) } }] }, null);
      chunk({ tool_calls: [{ index: 0, function: { arguments: argText.slice(5) } }] }, null);
      chunk({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }

    let text = toolResult !== null && mode === 'ok' ? `The tool answered: ${toolResult.slice(0, 100)}` : answerFor(json, { bad: mode === 'badscore' });
    if (mode === 'text') text = `The candidate looks like a good fit for this job. ${lastUserText(json).length > 0 ? 'Good luck.' : ''}`.trim();
    if (mode === 'empty' || mode === 'think-only') text = '';
    if (mode === 'think') text = `<think>Let me think about the question first.</think>${text}`;
    let parts = pieces(text);
    let finish = 'stop';
    if (mode === 'cutoff') { parts = parts.slice(0, Math.max(1, Math.floor(parts.length / 2))); finish = 'length'; }
    if (mode === 'think-only') finish = 'length';
    const stream = ollama ? json.stream !== false : json.stream === true;

    if (!stream) {
      if (mode === 'half' || mode === 'broken') { req.socket.destroy(); return; }
      const content = parts.join('');
      if (ollama) return sendJson(res, 200, { model, message: { role: 'assistant', content, ...(mode === 'think-only' ? { thinking: 'thinking...' } : {}) }, done: true, done_reason: finish === 'length' ? 'length' : 'stop' });
      if (anthropic) return sendJson(res, 200, { type: 'message', content: [{ type: 'text', text: content }], stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn' });
      return sendJson(res, 200, { id: 'standin', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content, ...(mode === 'think-only' ? { reasoning_content: 'thinking...' } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: parts.length, total_tokens: 10 + parts.length } });
    }

    res.writeHead(200, { 'content-type': ollama ? 'application/x-ndjson' : 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    if (mode === 'stall-after-headers') { log.note(entry, 'stalled after headers'); return; }
    const halfAt = mode === 'half' ? Math.max(1, Math.floor(parts.length / 2)) : -1;
    const write = (s: string) => { if (!res.destroyed) res.write(s); };
    if (anthropic) {
      write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'standin', role: 'assistant', model } })}\n\n`);
      write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: mode === 'think-only' ? 'thinking' : 'text', text: '' } })}\n\n`);
    }
    if (mode === 'think-only') {
      for (let i = 0; i < 3; i++) {
        if (ollama) write(JSON.stringify({ model, message: { role: 'assistant', content: '', thinking: 'still thinking ' }, done: false }) + '\n');
        else if (anthropic) write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'still thinking ' } })}\n\n`);
        else write(`data: ${JSON.stringify({ id: 'standin', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'still thinking ' }, finish_reason: null }] })}\n\n`);
      }
    }
    for (let i = 0; i < parts.length; i++) {
      if (res.destroyed) { log.note(entry, 'client closed the connection'); return; }
      if (i === halfAt) { log.note(entry, 'dropped the connection half way'); req.socket.destroy(); return; }
      if (mode === 'broken' && i === 1) { write('data: {"choices":[{"delta":{"content":"broken\n\n'); write('data: this is not json\n\n'); break; }
      const p = parts[i]!;
      if (ollama) write(JSON.stringify({ model, message: { role: 'assistant', content: p }, done: false }) + '\n');
      else if (anthropic) write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })}\n\n`);
      else write(`data: ${JSON.stringify({ id: 'standin', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`);
      await sleep(mode === 'slow' ? slowMs : 2);
    }
    if (mode === 'broken') { res.end(); return; }
    if (ollama) write(JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: finish }) + '\n');
    else if (anthropic) {
      write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn' } })}\n\n`);
      write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    } else {
      write(`data: ${JSON.stringify({ id: 'standin', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      write('data: [DONE]\n\n');
    }
    res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    log,
    setMode(m: ModelMode) { mode = m; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

function sameName(a: string, b: string): boolean {
  const n = (s: string) => (s.includes(':') ? s : `${s}:latest`).toLowerCase();
  return a === b || n(a) === n(b);
}

/** A small deterministic vector for a text (8 dimensions, L2-normalised). */
function vector(text: string): number[] {
  const v = new Array<number>(8).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 8]! += (text.charCodeAt(i) % 31) / 31;
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
