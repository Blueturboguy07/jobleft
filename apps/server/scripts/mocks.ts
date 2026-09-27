// Loopback stand-ins for testing the server without the internet (INTERFACES section 11):
//   * job boards: Greenhouse, Lever and Ashby list endpoints, served from a JSON file that is read again on every
//     request, so a tester adds, changes or removes postings by editing the file;
//   * an OpenAI-compatible AI server (GET /v1/models, POST /v1/chat/completions, streamed or not);
//   * a publik stand-in (POST /api/v1/installs, GET /api/v1/wallet, POST /api/v1/installs/revoke, chat), with a
//     balance you can set to 0 to see the "balance too low" answer.
// Every mock listens on 127.0.0.1 only and logs every request (time, method, path, headers, body) as JSON lines.

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LogEntry { at: string; mock: string; method: string; path: string; headers: Record<string, unknown>; body: string }

export interface Mock { name: string; port: number; origin: string; log: LogEntry[]; close(): Promise<void> }

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const t = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t), ...headers });
  res.end(t);
}

type LogFiles = string | string[] | null;

async function start(name: string, port: number, logFile: LogFiles, handle: (req: IncomingMessage, res: ServerResponse, body: string, url: URL) => void | Promise<void>): Promise<Mock> {
  const log: LogEntry[] = [];
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const e: LogEntry = { at: new Date().toISOString(), mock: name, method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
    log.push(e);
    for (const f of logFile === null ? [] : Array.isArray(logFile) ? logFile : [logFile]) appendFileSync(f, JSON.stringify(e) + '\n');
    try { await handle(req, res, body, url); } catch { if (!res.headersSent) json(res, 500, { error: 'mock failed' }); else res.end(); }
  });
  // The asked port, or any free loopback port when it is taken (the caller prints the real address).
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && port !== 0) server.listen(0, '127.0.0.1', () => resolve());
      else reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const p = (server.address() as AddressInfo).port;
  return { name, port: p, origin: `http://127.0.0.1:${p}`, log, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

// ---------------------------------------------------------------- job boards

/**
 * The boards file: { "greenhouse": { "<token>": [ jobs ] }, "lever": {...}, "ashby": {...} } in each ATS's own shape,
 * and "pages": { "/path": "<html>" } for job pages added by link (map their host to this server with JOBLEFT_HOST_MAP).
 */
export type BoardsFile = Partial<Record<'greenhouse' | 'lever' | 'ashby', Record<string, unknown[]>>> & { pages?: Record<string, string> };

export function startBoards(opts: { file: string; port?: number; logFile?: LogFiles }): Promise<Mock> {
  const load = (): BoardsFile => { try { return JSON.parse(readFileSync(opts.file, 'utf8')) as BoardsFile; } catch { return {}; } };
  return start('boards', opts.port ?? 0, opts.logFile ?? null, (_req, res, _body, url) => {
    const b = load();
    let m: RegExpExecArray | null;
    if (url.pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    const page = b.pages?.[url.pathname];
    if (page !== undefined) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
    if ((m = /^\/v1\/boards\/([^/]+)\/jobs$/.exec(url.pathname))) {
      const jobs = b.greenhouse?.[decodeURIComponent(m[1]!)];
      if (!jobs) { json(res, 404, { status: 404, error: 'Job not found' }); return; }
      json(res, 200, { jobs, meta: { total: jobs.length } });
      return;
    }
    if ((m = /^\/v0\/postings\/([^/]+)$/.exec(url.pathname))) {
      const jobs = b.lever?.[decodeURIComponent(m[1]!)];
      if (!jobs) { json(res, 404, { ok: false, error: 'Document not found' }); return; }
      json(res, 200, jobs);
      return;
    }
    if ((m = /^\/posting-api\/job-board\/([^/]+)$/.exec(url.pathname))) {
      const jobs = b.ashby?.[decodeURIComponent(m[1]!)];
      if (!jobs) { json(res, 404, { success: false }); return; }
      json(res, 200, { jobs });
      return;
    }
    json(res, 404, { error: 'not found' });
  });
}

/** A Greenhouse posting in the list API's shape (content is entity-encoded HTML, as Greenhouse serves it). */
export function greenhouseJob(id: number, o: { title: string; location?: string; content?: string; posted?: string | null; board: string; pay?: { min: number; max: number; period?: 'hour' | 'year' } | null }): Record<string, unknown> {
  const html = o.content ?? '<p>About the role.</p>';
  return {
    id,
    title: o.title,
    absolute_url: `https://boards.greenhouse.io/${o.board}/jobs/${id}`,
    location: { name: o.location ?? '' },
    content: html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    // Like the real API: `updated_at` (the last edit) is always there; `first_published` only when the board says it.
    ...(o.posted === null ? {} : { first_published: o.posted ?? '2026-09-20T15:00:00-04:00' }),
    updated_at: '2026-09-24T10:00:00-04:00',
    metadata: [],
    departments: [],
    // Like a real board: the range carries a title that names its unit (a range with no unit is not read as pay).
    ...(o.pay ? { pay_input_ranges: [{ min_cents: o.pay.min * 100, max_cents: o.pay.max * 100, currency_type: 'USD', title: o.pay.period === 'hour' ? 'Hourly rate' : 'Annual salary' }] } : {}),
  };
}

// ---------------------------------------------------------------- AI (OpenAI-compatible)

export function startAi(opts: { port?: number; logFile?: LogFiles; reply?: string; model?: string } = {}): Promise<Mock> {
  const model = opts.model ?? 'mock-model';
  const reply = opts.reply ?? 'This answer comes from the local mock model.';
  return start('ai', opts.port ?? 0, opts.logFile ?? null, async (req, res, body, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/models') { json(res, 200, { object: 'list', data: [{ id: model, object: 'model' }] }); return; }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let b: { stream?: boolean; model?: string } = {};
      try { b = JSON.parse(body); } catch { /* keep empty */ }
      if (b.model !== model) { json(res, 404, { error: { message: `model ${b.model} not found` } }); return; }
      if (!b.stream) {
        json(res, 200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of reply.split(/(?<= )/)) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    json(res, 404, { error: { message: 'not found' } });
  });
}

// ---------------------------------------------------------------- publik

export function startPublik(opts: { port?: number; logFile?: LogFiles; balanceMicros?: number; chargeMicros?: number; holdMicros?: number; priceMicros?: number; walletDelayMs?: number; reply?: string; finishReason?: string } = {}): Promise<Mock & { setBalance(m: number): void; balance(): number; setDaily(d: { capMicros: number; spentMicros: number; refuse: boolean } | null): void }> {
  let balance = opts.balanceMicros ?? 2_000_000;
  // Like the real gateway: a streamed answer's headers carry the balance minus a temporary hold; the charge settles
  // when the answer ends (holdMicros and priceMicros, both 0 by default).
  const hold = opts.holdMicros ?? 0;
  const price = opts.priceMicros ?? 0;
  // The daily spending limit per computer: reported in the wallet; `refuse` answers 429 daily_cap_reached to AI calls.
  let daily: { capMicros: number; spentMicros: number; refuse: boolean } | null = null;
  const keys = new Set<string>();
  const m = start('publik', opts.port ?? 0, opts.logFile ?? null, async (req, res, body, url) => {
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const wallet = () => ({ balance_micros: balance, claim_state: 'anonymous', plan: 'none', starter: { remaining_micros: balance }, week: { used_micros: 0, budget_micros: null, resets_at: null }, claim_url: 'https://publikhq.com/claim/stand-in', add_credit_url: 'https://publikhq.com/dashboard/api', ...(daily ? { daily_cap_micros: daily.capMicros, spent_today_micros: daily.spentMicros } : {}) });
    if (url.pathname === '/__admin/balance' && req.method === 'POST') { balance = Number(JSON.parse(body || '{}').micros ?? 0); json(res, 200, { balance }); return; }
    if (url.pathname === '/api/v1/installs' && req.method === 'POST') {
      const key = `pk_test_${'a'.repeat(12)}_${Math.random().toString(36).slice(2).padEnd(32, '0').slice(0, 32)}`;
      keys.add(key);
      json(res, 201, { key, base_url: `http://127.0.0.1:${(req.socket.localPort)}/api/v1`, wallet: wallet() });
      return;
    }
    if (!keys.has(auth)) { json(res, 401, { error: { type: 'invalid_key' } }); return; }
    if (url.pathname === '/api/v1/wallet' && req.method === 'GET') {
      // walletDelayMs: a slow balance read, as over the internet (the app must not show an older balance meanwhile)
      if (opts.walletDelayMs) await new Promise((r) => setTimeout(r, opts.walletDelayMs));
      json(res, 200, wallet()); return;
    }
    if (url.pathname === '/api/v1/installs/revoke' && req.method === 'POST') { keys.delete(auth); json(res, 200, { revoked: true }); return; }
    if (url.pathname === '/api/v1/chat/completions' && req.method === 'POST') {
      if (daily?.refuse) {
        const d = new Date();
        const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil((midnight - Date.now()) / 1000)) });
        res.end(JSON.stringify({ error: { type: 'daily_cap_reached', message: 'Daily cap reached.', daily_cap_micros: daily.capMicros, spent_today_micros: daily.spentMicros, claim_state: 'anonymous' } }));
        return;
      }
      if (balance <= 0) { json(res, 402, { error: { type: 'insufficient_balance', available_micros: balance, top_up_url: 'https://publikhq.com/claim/stand-in' } }); return; }
      // Each answer costs chargeMicros (default nothing), like a streamed publik answer; the headers carry the balance minus a hold.
      balance = Math.max(0, balance - (opts.chargeMicros ?? 0));
      res.writeHead(200, { 'content-type': 'text/event-stream', ...(hold ? { 'x-publik-balance': String(balance - hold) } : {}) });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: opts.reply ?? 'publik stand-in answer' } }] })}\n\n`);
      if (opts.finishReason) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: opts.finishReason }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      balance -= price;
      res.end();
      return;
    }
    json(res, 404, { error: { type: 'not_found' } });
  });
  return m.then((x) => ({ ...x, setBalance: (v: number) => { balance = v; }, balance: () => balance, setDaily: (v: typeof daily) => { daily = v; } }));
}
