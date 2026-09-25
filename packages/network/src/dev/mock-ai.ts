// A local stand-in AI provider for tests and for checking the outcomes by hand. It speaks the OpenAI
// chat-completions dialect on 127.0.0.1 and, with `publik: true`, also plays the publik API (a balance in dollars,
// a charge per call, x-publik-* headers, 402 when the balance is too low).
// It logs every request (time, method, path, headers without secrets, body) to memory (GET /__admin/log) and to an
// optional log file, so a tester can see exactly what the app sent.
// It writes drafts from the facts block of the request. Modes make it misbehave on purpose.

import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const MOCK_MODES = {
  ok: 'A true draft built only from the facts in the request',
  invent: 'Claims a shared employer ("we worked together at Initech") and a referral promise',
  'wrong-name': 'Greets the wrong person ("Hi Taylor")',
  bad: 'Both: the wrong first name and an invented shared employer',
  numbers: 'Adds numbers that are not in the inputs ("7 years", "a team of 12")',
  placeholder: 'Leaves placeholders ("{first_name}", "[Your Name]")',
  markup: 'Wraps the draft in markdown, HTML tags and zero-width characters',
  long: 'Writes a draft far over the character limit',
  custom: 'Answers the exact text set with {"mode":"custom","text":"..."}',
  empty: 'Answers an empty message',
  error500: 'Answers 500 to every chat request',
  slow: 'Waits `slowMs` (default 3000) before answering',
} as const;
export type MockMode = keyof typeof MOCK_MODES;

export interface MockAiOptions {
  port?: number;
  mode?: MockMode;
  /** Also play the publik API under /api/v1 with a balance. */
  publik?: boolean;
  balanceUsd?: number;
  priceUsd?: number;
  logFile?: string | null;
  quiet?: boolean;
}

export interface MockAi {
  port: number;
  origin: string;
  log: Array<Record<string, unknown>>;
  close(): Promise<void>;
  setMode(mode: MockMode, text?: string): void;
}

interface Facts {
  charLimit?: number;
  kind?: string;
  contact?: { firstName?: string; lastName?: string; title?: string | null; company?: string | null };
  job?: { title?: string; company?: string } | null;
  aboutMe?: string;
}

function readFacts(messages: Array<{ role: string; content: string }>): { facts: Facts; sender: string | null } {
  const all = messages.map((m) => m.content).join('\n');
  const m = /<<FACTS>>\s*([\s\S]*?)\s*<<END FACTS>>/.exec(all);
  let facts: Facts = {};
  if (m) { try { facts = JSON.parse(m[1]!) as Facts; } catch { facts = {}; } }
  const s = /Sign off with the sender's name: ([^\n]+?)\.\s*$/m.exec(all);
  return { facts, sender: s ? s[1]!.trim() : null };
}

function draftFor(mode: MockMode, custom: string, facts: Facts, sender: string | null): string {
  const first = facts.contact?.firstName || 'there';
  const me = sender ? ` I'm ${sender}.` : '';
  const senderFirst = sender ? sender.split(/\s+/)[0] : null;
  const where = facts.job?.title && facts.job?.company
    ? `the ${facts.job.title} role at ${facts.job.company}`
    : facts.contact?.company ? `working at ${facts.contact.company}` : 'your work';
  const longer = facts.kind === 'longer message';
  const base = facts.job
    ? `Hi ${first},${me} I'm interested in ${where} and would value your perspective. Would you be open to a short chat?`
    : `Hi ${first},${me} I'd value your perspective on ${where}. Would you be open to a short chat?`;
  const sign = longer && senderFirst ? `\n\nThanks,\n${senderFirst}` : '';
  switch (mode) {
    case 'ok': return base + sign;
    case 'invent': return `Hi ${first}, great to reconnect! Since we worked together at Initech, I hoped you could refer me for ${where}. You offered to refer me when we met.${sign}`;
    case 'wrong-name': return `Hi Taylor,${me} I'm interested in ${where} and would value your perspective. Would you be open to a short chat?${sign}`;
    case 'bad': return `Hi Taylor, it was great working with you at Initech!${me} Could you refer me for ${where}?${sign}`;
    case 'numbers': return `Hi ${first},${me} I have 7 years of experience and led a team of 12. I'm interested in ${where}. Would you be open to a short chat?${sign}`;
    case 'placeholder': return `Hi {first_name}, I'm [Your Name]. I'm interested in ${where}. Would you be open to a short chat?${sign}`;
    case 'markup': return `Here is a draft:\n\n**Hi ${first},**​${me} <b>I'm interested</b> in ${where} and would value your perspective.﻿ Would you be open to a short chat?${sign}`;
    case 'long': return `${base} ${'I would be glad to learn how the team works, what a normal week looks like, and what you enjoy most about the work. '.repeat(12)}${sign}`;
    case 'custom': return custom;
    case 'empty': return '';
    default: return base + sign;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) break;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function startMockAi(opts: MockAiOptions = {}): Promise<MockAi> {
  let mode: MockMode = opts.mode ?? 'ok';
  let custom = '';
  let slowMs = 3000;
  let balance = Math.round((opts.balanceUsd ?? 5) * 1e6);
  let price = Math.round((opts.priceUsd ?? 0.01) * 1e6);
  const log: Array<Record<string, unknown>> = [];
  const publik = !!opts.publik;
  let port = 0;

  const record = (entry: Record<string, unknown>) => {
    log.push(entry);
    if (log.length > 2000) log.shift();
    if (opts.logFile) { try { appendFileSync(opts.logFile, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch { /* ignore */ } }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const raw = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : '';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = k === 'authorization' || k.includes('key') || k.includes('token') ? '(present, not logged)' : String(v);

    if (path.startsWith('/__admin')) {
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
      if (path === '/__admin/log') return send(res, 200, log);
      if (path === '/__admin/clear-log') { log.length = 0; return send(res, 200, { ok: true }); }
      if (path === '/__admin/state') return send(res, 200, { mode, publik, balanceMicros: balance, priceMicros: price, requests: log.length });
      if (path === '/__admin/mode') {
        if (typeof body.mode === 'string' && body.mode in MOCK_MODES) mode = body.mode as MockMode;
        else return send(res, 400, { error: `unknown mode; use one of ${Object.keys(MOCK_MODES).join(', ')}` });
        if (typeof body.text === 'string') custom = body.text;
        if (typeof body.slowMs === 'number') slowMs = body.slowMs;
        return send(res, 200, { mode });
      }
      if (path === '/__admin/balance' && typeof body.usd === 'number') { balance = Math.round(body.usd * 1e6); return send(res, 200, { balanceMicros: balance }); }
      if (path === '/__admin/price' && typeof body.usd === 'number') { price = Math.round(body.usd * 1e6); return send(res, 200, { priceMicros: price }); }
      return send(res, 404, { error: 'unknown admin path' });
    }

    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
    record({ at: new Date().toISOString(), method: req.method, path, headers, body: parsed });

    const isModels = path === '/v1/models' || path === '/api/v1/models' || path === '/models';
    const isChat = path === '/v1/chat/completions' || path === '/api/v1/chat/completions' || path === '/chat/completions';
    const meter = (charged: number | null): Record<string, string> => publik
      ? { 'x-publik-balance': String(balance), ...(charged !== null ? { 'x-publik-charge-micros': String(charged) } : {}) }
      : {};

    if (isModels) {
      const ids = publik ? ['publik-fast', 'publik-balanced', 'publik-smart'] : ['mock-draft-7b'];
      return send(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }, meter(null));
    }
    if (publik && (path === '/api/v1/wallet' || path === '/api/v1/balance')) {
      return send(res, 200, { balance_micros: balance, currency: 'USD' }, meter(null));
    }
    if (!isChat || req.method !== 'POST') return send(res, 404, { error: { message: 'not found' } });
    if (mode === 'error500') return send(res, 500, { error: { message: 'stand-in failure' } }, meter(null));
    if (publik && balance < price) {
      return send(res, 402, { error: { type: 'insufficient_balance', message: 'Your balance is too low for this request.', top_up_url: `http://127.0.0.1:${port}/top-up` } }, meter(null));
    }
    if (mode === 'slow') await new Promise((r) => setTimeout(r, slowMs));
    const body = (parsed ?? {}) as { messages?: Array<{ role: string; content: string }>; model?: string; stream?: boolean };
    const { facts, sender } = readFacts(Array.isArray(body.messages) ? body.messages : []);
    const text = draftFor(mode, custom, facts, sender);
    let charged: number | null = null;
    if (publik) { balance -= price; charged = price; }
    const model = body.model || (publik ? 'publik-balanced' : 'mock-draft-7b');
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...meter(charged) });
      const pieces = text.match(/[\s\S]{1,40}/g) ?? [];
      for (const p of pieces) res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return send(res, 200, {
      id: 'mock-1', object: 'chat.completion', model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }, meter(charged));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        log,
        setMode(m: MockMode, text?: string) { mode = m; if (text !== undefined) custom = text; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
