// A loopback stand-in for an OpenAI-compatible model server and for the paid publik API, for tests and for
// evaluators. It never calls anything; it answers from a fixed script and logs every request it gets.
//   node scripts/mock-ai.ts --port 4311 --mode adversarial [--log /private/tmp/mock-ai.jsonl] [--balance 50000]
// Modes:
//   safe         reworded bullets that keep every fact; a two-paragraph letter body
//   adversarial  answers that try to add Kubernetes, a PhD, "Senior", new numbers, the hiring company, an email
//   error        HTTP 500 every time
//   timeout      accepts the request and never answers
//   malformed    HTTP 200 with a body that is not an OpenAI answer
//   empty        an answer with empty text
//   rambling     a well-formed answer whose text ignores the requested format (small models do this)
//   publik       like "safe", plus x-publik-* balance headers; each answer costs 2,100 micros; 402 when the balance is gone
//   embellish    a letter that names the hiring company and slips in claims the profile does not back (mentoring,
//                "data warehouses", "40% faster", "reducing errors"), as small local models do
//   truncated    like "publik", but every answer stops early (finish_reason "length") and is still charged
// The log (JSON lines) holds: time, method, path, header names, body length, and "marker" (true when the body contains
// the text given with --marker). It never stores the body itself.

import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type MockMode = 'safe' | 'adversarial' | 'error' | 'timeout' | 'malformed' | 'empty' | 'rambling' | 'publik' | 'embellish' | 'truncated';

export interface MockOptions { port?: number; mode: MockMode; log?: string | null; marker?: string | null; balanceMicros?: number }

export interface MockServer { url: string; server: Server; requests: Array<{ path: string; headers: string[]; bodyLength: number; marker: boolean; auth: boolean }>; close(): Promise<void>; setMode(m: MockMode): void; balance(): number }

function bulletIds(prompt: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const m of prompt.matchAll(/^(B\d+): (.+)$/gm)) out.push({ id: m[1]!, text: m[2]! });
  return out;
}

function answerFor(mode: MockMode, system: string, user: string): string {
  const isLetter = /cover letter/i.test(system);
  const bullets = bulletIds(user);
  if (mode === 'empty') return '';
  if (mode === 'rambling') return 'Sure! Here is a stronger resume for you. <b>Kubernetes expert</b> with 10 years of experience. ```json {"resume": "..."} ```';
  if (isLetter) {
    if (mode === 'embellish') {
      const company = /Company: (.+)/.exec(user)?.[1]?.trim() ?? 'the company';
      return `BODY:\nI am a software engineer who led a migration of 12 services to PostgreSQL with zero downtime. I am eager to help ${company} grow. I am well-prepared to lead technical outcomes for a team of talented engineers, providing mentorship and guidance as outlined in the responsibilities.\n\nAt Northwind Sample Labs I led the migration to PostgreSQL, demonstrating my ability to maintain high-quality data warehouses and pipelines. I also made batch jobs 40% faster by rewriting the scheduler in TypeScript. I wrote Python scripts that saved 10 hours of manual work each week, enhancing efficiency and reducing errors.\nEND`;
    }
    if (mode === 'adversarial') {
      return 'BODY:\nAs a Senior Platform Engineer at Acme Health, I ran Kubernetes clusters for 10+ years. I hold a PhD from Stanford University and cut costs by 45%.\n\nI am a software engineer who led a migration of 12 services to PostgreSQL with zero downtime. You can reach me at recruiter@acme-health.example.com or https://evil.example.com.\n\nI also know Rust and Terraform well.\nEND';
    }
    return 'BODY:\nI am a software engineer who led a migration of 12 services to PostgreSQL with zero downtime, and I cut batch-job time by 40% by rewriting a scheduler in TypeScript.\n\nI also built a billing API that processes $2M in payments each month, and I would bring the same care to this team.\nEND';
  }
  if (mode === 'adversarial') {
    const lines = bullets.map((b, i) => {
      const variants = [
        `${b.id}: ${b.text.replace(/\.$/, '')} using Kubernetes and Terraform.`,
        `${b.id}: As a Senior Staff Engineer at Acme Health, ${b.text.replace(/^./, (c) => c.toLowerCase())}`,
        `${b.id}: ${b.text.replace(/\d+%/, '75%').replace(/\$\d+M/, '$20M')} and cut cloud costs by 35%.`,
        `${b.id}: ${b.text.replace(/\.$/, '')}, drawing on 10+ years of experience and a PhD in Computer Science.`,
        `${b.id}: Reworded: ${b.text}`,
      ];
      return variants[i % variants.length]!;
    });
    return `${lines.join('\n')}\nSUMMARY: Senior engineer with 12 years of Kubernetes, Go and Terraform experience and a Stanford PhD.`;
  }
  // safe: reword with facts kept (drops no numbers; moves no facts).
  const lines = bullets.map((b) => `${b.id}: ${b.text.replace(/^Cut /, 'Reduced ').replace(/^Led /, 'Directed ').replace(/^Built /, 'Developed ')}`);
  return lines.length ? lines.join('\n') : 'NONE';
}

export async function startMockAi(o: MockOptions): Promise<MockServer> {
  let mode = o.mode;
  let balance = o.balanceMicros ?? 50_000;
  const requests: MockServer['requests'] = [];
  const log = (entry: Record<string, unknown>) => { if (o.log) appendFileSync(o.log, JSON.stringify(entry) + '\n'); };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = { at: new Date().toISOString(), method: req.method, path: req.url, headers: Object.keys(req.headers), bodyLength: body.length, marker: !!(o.marker && body.includes(o.marker)), auth: !!req.headers.authorization };
      requests.push({ path: req.url ?? '', headers: entry.headers, bodyLength: body.length, marker: entry.marker, auth: entry.auth });
      log(entry);
      if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'mock-small' }] })); return; }
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      if (mode === 'timeout') return; // never answer
      if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock failure' } })); return; }
      if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"this is": not json at all <html>'); return; }
      let parsed: { messages?: Array<{ role: string; content: string }> } = {};
      try { parsed = JSON.parse(body); } catch { /* keep empty */ }
      const system = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
      const user = parsed.messages?.find((m) => m.role === 'user')?.content ?? '';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (mode === 'publik' || mode === 'truncated') {
        const cost = 2_100;
        if (balance < cost) {
          res.writeHead(402, { ...headers, 'x-publik-balance': String(balance) });
          res.end(JSON.stringify({ error: { code: 'insufficient_balance', message: 'Your balance ran out.', link: 'https://publik.example.test/claim/TEST-0000' } }));
          return;
        }
        balance -= cost;
        headers['x-publik-balance'] = String(balance);
        headers['x-publik-charge-micros'] = String(cost);
      }
      const text = answerFor(mode === 'publik' || mode === 'truncated' ? 'safe' : mode, system, user);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: mode === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/v1`, server, requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    setMode: (m) => { mode = m; },
    balance: () => balance,
  };
}

// Run as a program: node scripts/mock-ai.ts --port 4311 --mode safe
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? null : null; };
  const m = await startMockAi({ port: Number(arg('port') ?? 4311), mode: (arg('mode') ?? 'safe') as MockMode, log: arg('log'), marker: arg('marker'), balanceMicros: arg('balance') ? Number(arg('balance')) : 50_000 });
  process.stdout.write(`mock AI (${arg('mode') ?? 'safe'}) listening at ${m.url}\n`);
}
