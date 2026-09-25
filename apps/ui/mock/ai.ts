// Stand-in AI model on this computer: an OpenAI-compatible server at http://127.0.0.1:47911/v1 (like Ollama or
// LM Studio). It answers with short, deterministic text built from what it was sent, streams word by word, and
// charges nothing. Stop it to test what the app does when the local model does not answer.
// Run: node apps/ui/mock/ai.ts [--port 47911] [--delay-ms 30]

import { createServer, type IncomingMessage } from 'node:http';
import { PORTS, parseArgs, sleep } from './util.ts';

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? PORTS.ai);
const delay = Number(args['delay-ms'] ?? 30);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
}

interface Msg { role: string; content: string }

function reply(messages: Msg[]): string {
  const task = messages.find((m) => m.role === 'system' && m.content.startsWith('task:'))?.content.slice(5).trim() ?? 'chat';
  const all = messages.map((m) => m.content).join('\n');
  const job = /Job: (.+?) at (.+?)\. Skills named: (.*?)\./.exec(all);
  const mine = /My skills: (.*?)\./.exec(all)?.[1]?.split(/,\s*/).filter(Boolean) ?? [];
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (task.startsWith('cover_letter')) return 'I would bring careful, steady work to the team and I learn new tools quickly.';
  if (task.startsWith('outreach')) return 'I would be grateful for any advice you can share.';
  if (task.startsWith('practice_feedback')) return 'Say what changed because of your work, in one sentence.';
  if (task.startsWith('tailor') || task.startsWith('practice_questions')) return 'Done.';
  const parts: string[] = [];
  if (job) {
    const named = job[3]!.split(/,\s*/).filter((s) => s && s !== 'none');
    const have = named.filter((s) => mine.some((m) => m.toLowerCase() === s.toLowerCase()));
    const lack = named.filter((s) => !have.includes(s));
    parts.push(`About ${job[1]} at ${job[2]}:`);
    if (have.length) parts.push(`your profile lists ${have.join(', ')}, which the posting names.`);
    if (lack.length) parts.push(`The posting also names ${lack.join(', ')}, which your profile does not list.`);
    if (!named.length) parts.push('the posting names no skills I can compare.');
  }
  if (!parts.length) parts.push(`You asked: "${last.slice(0, 120)}".`, 'I am the stand-in model on this computer, so my answers are short.');
  parts.push('Ask me to compare your profile with a job, or to help you prepare for an interview.');
  return parts.join(' ');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'standin-7b' }, { id: 'standin-14b' }] }));
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as { messages?: Msg[]; stream?: boolean; model?: string };
    const model = body.model ?? 'standin-7b';
    if (model !== 'standin-7b' && model !== 'standin-14b') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `model "${model}" not found` } }));
      return;
    }
    const text = reply(body.messages ?? []);
    if (!body.stream) {
      await sleep(delay * 4);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: text } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const w of text.split(/(?<= )/)) {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      await sleep(delay);
    }
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"not found"}}');
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use, so the stand-in AI model cannot start.`);
  else console.error(`The stand-in AI model cannot start: ${e.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`Stand-in AI model (OpenAI-compatible) on http://127.0.0.1:${port}/v1 (models standin-7b, standin-14b)`));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
