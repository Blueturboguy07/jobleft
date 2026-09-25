// Shared parts of the stand-in servers: a request log (every request with its headers, as the test setup asks),
// answer text, and a value that fits a JSON Schema. Test tools only: never used by the app itself.

import { appendFileSync, mkdirSync } from 'node:fs';
import type http from 'node:http';
import { dirname } from 'node:path';
import type { JsonSchema } from '@jobleft/contracts';

export interface LogEntry {
  at: string;
  server: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  status?: number;
  note?: string;
}

export class RequestLog {
  readonly entries: LogEntry[] = [];
  private readonly file: string | null;
  private readonly server: string;
  constructor(server: string, file: string | null) {
    this.server = server;
    this.file = file;
    if (file) mkdirSync(dirname(file), { recursive: true });
  }
  add(req: http.IncomingMessage, body: string, extra: { status?: number; note?: string } = {}): LogEntry {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    const entry: LogEntry = { at: new Date().toISOString(), server: this.server, method: req.method ?? '', path: req.url ?? '', headers, body: body.slice(0, 65_536), ...extra };
    this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.shift();
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + '\n');
    return entry;
  }
  note(entry: LogEntry, note: string, status?: number): void {
    entry.note = entry.note ? `${entry.note}; ${note}` : note;
    if (status !== undefined) entry.status = status;
    if (this.file) appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), server: this.server, followUp: entry.path, note, status }) + '\n');
  }
}

export function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= limit) parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A value that fits a JSON Schema (all properties filled). `bad` puts 140 in every number (an out-of-range answer). */
export function instanceOf(schema: JsonSchema | undefined, opts: { bad?: boolean } = {}, depth = 0): unknown {
  if (!schema || depth > 8) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length) return schema.enum[0];
  if (schema.anyOf && schema.anyOf.length) {
    const branch = schema.anyOf.find((b) => b.type !== 'null') ?? schema.anyOf[0]!;
    return instanceOf(branch, opts, depth + 1);
  }
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = instanceOf(v, opts, depth + 1);
      return out;
    }
    case 'array': return [instanceOf(schema.items, opts, depth + 1)];
    case 'integer': return opts.bad ? 140 : Math.max(schema.minimum ?? 0, Math.min(schema.maximum ?? 72, 72));
    case 'number': return opts.bad ? 140 : Math.max(schema.minimum ?? 0, Math.min(schema.maximum ?? 72.5, 72.5));
    case 'boolean': return true;
    case 'null': return null;
    case 'string': {
      if (schema.format === 'date-time') return new Date(0).toISOString();
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'uri') return 'https://example.com/';
      if (schema.format === 'email') return 'jordan.testwell@example.com';
      return 'stand-in text'.padEnd(schema.minLength ?? 0, 'x').slice(0, schema.maxLength ?? 1000);
    }
    default: return null;
  }
}

/** The JSON Schema a structured request asks for: from response_format, Ollama `format`, or the system prompt. */
export function schemaFromRequest(body: Record<string, any>): JsonSchema | null {
  const rf = body.response_format;
  if (rf?.type === 'json_schema' && rf.json_schema?.schema) return rf.json_schema.schema as JsonSchema;
  if (body.format && typeof body.format === 'object') return body.format as JsonSchema;
  const texts: string[] = [];
  if (typeof body.system === 'string') texts.push(body.system);
  for (const m of body.messages ?? []) if (m?.role === 'system' && typeof m.content === 'string') texts.push(m.content);
  for (const t of texts) {
    const idx = t.indexOf('JSON Schema');
    if (idx < 0) continue;
    const start = t.indexOf('{', idx);
    if (start < 0) continue;
    const line = t.slice(start).split('\n')[0]!;
    try { return JSON.parse(line) as JsonSchema; } catch { /* next */ }
  }
  if (rf?.type === 'json_object' || body.format === 'json') return { type: 'object', properties: {} };
  return null;
}

/** The last user message text of a chat body (OpenAI, Ollama or Anthropic shape). */
export function lastUserText(body: Record<string, any>): string {
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  }
  return '';
}

/** The answer text of the "ok" mode: "ready" for the setup test, JSON for structured requests, else a fixed sentence. */
export function answerFor(body: Record<string, any>, opts: { bad?: boolean } = {}): string {
  const schema = schemaFromRequest(body);
  if (schema) return JSON.stringify(instanceOf(schema, opts));
  const user = lastUserText(body);
  if (/reply with the word ready/i.test(user)) return 'ready';
  return `This is the stand-in answer to your message (${Math.min(user.length, 9999)} characters). It has several words so that streaming sends many pieces.`;
}

/** Splits text into small pieces for streaming. */
export function pieces(text: string, size = 6): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
