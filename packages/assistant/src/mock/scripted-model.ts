// A scripted stand-in model (test tool). It speaks the OpenAI dialect (`custom` or `local` provider address) with tool
// calls, and it answers by a SCRIPT, so a tester can make it behave well, lie, or obey planted instructions:
//   * `script(ctx)` in code (tests), or a JSON rules file on the command line (`mock-model --script rules.json`);
//   * every request is logged in full with its headers (GET /__admin/log), so a tester can search what was sent.
// Rules file (JSON array, first match wins):
//   { "when": { "userIncludes": "match", "afterTool": false }, "reply": { "toolCalls": [{ "name": "get_match", "arguments": { "job_id": "..." } }] } }
//   { "when": { "toolResultIncludes": "percent" }, "reply": { "text": "Your match is 72%." } }
//   { "reply": { "text": "fallback" } }
// `when` keys (all must hold): userIncludes, systemIncludes, afterTool (true = the last message is a tool result),
// toolResultIncludes, toolCount (the tools offered), hasTool (a tool name that is offered), toolResults (>= this many tool messages).
// `reply` keys: text, toolCalls [{ name, arguments }], status (an HTTP error), delayMs, dropAfter (drop the connection after N pieces).
// Without a rules file the model uses a small built-in policy that calls a matching tool and then repeats what the tool said.

import { appendFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface ScriptCtx {
  lastUser: string;
  system: string;
  afterTool: boolean;
  lastToolResult: string;
  toolResults: string[];
  tools: string[];
  messages: any[];
  body: any;
}
export interface ScriptReply { text?: string; toolCalls?: Array<{ name: string; arguments: unknown }>; status?: number; delayMs?: number; dropAfter?: number }
export type Script = (ctx: ScriptCtx) => ScriptReply | Promise<ScriptReply>;

export interface ScriptedModelServer {
  port: number;
  url: string;
  requests: Array<{ at: string; path: string; headers: Record<string, string>; body: string }>;
  setScript(s: Script): void;
  close(): Promise<void>;
}

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
}

export function ctxOf(body: any): ScriptCtx {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const users = messages.filter((m) => m.role === 'user');
  const last = messages.at(-1);
  const tools = (Array.isArray(body?.tools) ? body.tools : []).map((t: any) => String(t?.function?.name ?? t?.name ?? ''));
  const toolResults = messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
  return {
    lastUser: textOf(users.at(-1)?.content),
    system: messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'),
    afterTool: last?.role === 'tool',
    lastToolResult: last?.role === 'tool' ? textOf(last.content) : '',
    toolResults, tools, messages, body,
  };
}

export function rulesScript(rules: Array<{ when?: Record<string, any>; reply: ScriptReply }>): Script {
  return (ctx) => {
    for (const r of rules) {
      const w = r.when ?? {};
      if (w.userIncludes !== undefined && !ctx.lastUser.toLowerCase().includes(String(w.userIncludes).toLowerCase())) continue;
      if (w.systemIncludes !== undefined && !ctx.system.toLowerCase().includes(String(w.systemIncludes).toLowerCase())) continue;
      if (w.afterTool !== undefined && ctx.afterTool !== w.afterTool) continue;
      if (w.toolResultIncludes !== undefined && !ctx.lastToolResult.toLowerCase().includes(String(w.toolResultIncludes).toLowerCase())) continue;
      if (w.toolCount !== undefined && ctx.tools.length !== w.toolCount) continue;
      if (w.hasTool !== undefined && !ctx.tools.includes(w.hasTool)) continue;
      if (w.toolResults !== undefined && ctx.toolResults.length < w.toolResults) continue;
      return r.reply;
    }
    return { text: 'No rule matched.' };
  };
}

/** The built-in policy: call a matching tool, then say what the tool said (plain, from its JSON). */
export const defaultScript: Script = (ctx) => {
  const u = ctx.lastUser.toLowerCase();
  if (/reply with the word ready/i.test(ctx.lastUser)) return { text: 'ready' };
  if (ctx.afterTool) {
    let v: any = null;
    try { v = JSON.parse(ctx.lastToolResult); } catch { /* text */ }
    if (v?.error) return { text: `I could not read that: ${v.error}` };
    if (v?.items) return { text: `You have ${v.count} job(s) in this list:\n${v.items.map((i: any) => `- ${i.title} at ${i.company}${i.trackerStatus ? ` (${i.trackerStatus})` : ''}`).join('\n')}` };
    if (v?.jobs) return { text: v.total === 0 ? 'I found no job that matches.' : `I found ${v.total} job(s):\n${v.jobs.map((j: any) => `- ${j.title} at ${j.company}, pay: ${j.pay ?? 'not listed'}`).join('\n')}` };
    if (v?.match && !('untrusted' in v)) return { text: v.match.available ? `Your match for ${v.job.title} at ${v.job.company} is ${v.match.percent}% (${v.match.band}). Missing skills: ${v.match.missingSkills.join(', ') || 'none'}.` : String(v.match.reason ?? 'The match is not available for this job.') };
    if (v?.job && 'untrusted' in v) return { text: `${v.job.title} at ${v.job.company}. Pay: ${v.job.pay == null ? 'not listed in the posting' : typeof v.job.pay === 'string' ? v.job.pay : JSON.stringify(v.job.pay)}.` };
    if (v?.proposed !== undefined) return { text: v.proposed ? `I proposed ${v.actions?.length ?? 1} change(s)${v.costMicros != null || v.price ? ' with a price' : ''}. Nothing has changed yet. Please approve or decline each one.` : `I could not propose that: ${(v.problems ?? []).join(' ')}` };
    if (v?.facts !== undefined) return { text: `${v.name}: ${v.facts.length} stored fact(s). Not known: ${v.notKnown.slice(0, 4).join(', ')}. ${v.sponsorship.text}` };
    if (v?.overdueFollowUps !== undefined) return { text: `Overdue: ${v.overdueFollowUps.length}. Interviews: ${v.interviews.length}. Liked and not applied: ${v.likedNotAppliedYet.length}.` };
    return { text: `The tool answered: ${ctx.lastToolResult.slice(0, 200)}` };
  }
  const has = (n: string) => ctx.tools.includes(n);
  if (has('propose_changes') && /\b(move|mark|archive|delete|reject)\b/.test(u)) return { text: 'Which job do you mean? Tell me its title and company.' };
  if (has('list_tracker') && /(interview|applied|liked|saved|stage|tracker)/.test(u)) {
    const status = /interview/.test(u) ? 'interviewing' : undefined;
    return { toolCalls: [{ name: 'list_tracker', arguments: status ? { view: 'applied', status } : { view: /liked/.test(u) ? 'liked' : 'applied' } }] };
  }
  if (has('next_steps') && /(next|should i do)/.test(u)) return { toolCalls: [{ name: 'next_steps', arguments: {} }] };
  if (has('search_jobs') && /(find|search|jobs at|remote)/.test(u)) return { toolCalls: [{ name: 'search_jobs', arguments: { query: u.replace(/.*(?:jobs? at|for)\s+/, '').replace(/[?.]/g, '') } }] };
  return { text: 'I can look at your jobs, tracker and matches. What would you like to know?' };
};

export async function startScriptedModel(opts: { port?: number; script?: Script; log?: string | null; models?: string[] } = {}): Promise<ScriptedModelServer> {
  let script: Script = opts.script ?? defaultScript;
  const requests: ScriptedModelServer['requests'] = [];
  const sockets = new Set<Socket>();
  const models = opts.models ?? ['scripted-model'];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    const entry = { at: new Date().toISOString(), path: req.url ?? '', headers, body: raw };
    requests.push(entry);
    if (opts.log) appendFileSync(opts.log, JSON.stringify(entry) + '\n');
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const json = (status: number, v: unknown) => { const t = JSON.stringify(v); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t); };
    if (path === '/__admin/log') return json(200, requests);
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
    if (!(req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions'))) return json(404, { error: { message: 'no such route' } });
    let body: any = {};
    try { body = JSON.parse(raw); } catch { return json(400, { error: { message: 'bad json' } }); }
    const reply = await script(ctxOf(body));
    if (reply.status) return json(reply.status, { error: { message: 'scripted error', type: 'server_error' } });
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    const model = String(body.model ?? 'scripted-model');
    const calls = (reply.toolCalls ?? []).map((c, i) => ({ id: `call_${Date.now().toString(36)}_${i}`, name: c.name, args: JSON.stringify(c.arguments ?? {}) }));
    if (body.stream !== true) {
      return json(200, { id: 'scripted', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const chunk = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (reply.text) {
      const parts = reply.text.match(/[\s\S]{1,7}/g) ?? [];
      for (let i = 0; i < parts.length; i++) {
        if (res.destroyed) return;
        if (reply.dropAfter !== undefined && i >= reply.dropAfter) { req.socket.destroy(); return; }
        chunk({ content: parts[i] }, null);
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    calls.forEach((c, i) => {
      chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }, null);
      chunk({ tool_calls: [{ index: i, function: { arguments: c.args } }] }, null);
    });
    chunk({}, calls.length ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  return {
    port, url: `http://127.0.0.1:${port}/v1`, requests,
    setScript(s) { script = s; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}
