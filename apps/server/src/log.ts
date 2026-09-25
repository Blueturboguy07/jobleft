// The server log: $JOBLEFT_HOME/logs/server.log (mode 0600), one line per event, rotated at 5 MB (one old file kept).
// Rule (INTERFACES 6.1 rule 9, server O8): no key, token, resume text, chat text, network row, persona detail,
// request body or query string is ever logged. Request lines carry the route NAME only, never the path.
// Free text that reaches the log (error messages) passes through redact(): the home folder becomes "~", tokens and
// quoted strings are masked.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_BYTES = 5 * 1024 * 1024;

export interface Logger {
  error(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  /** Adds a value that must never appear in a log line (a token, a key). */
  addSecret(value: string): void;
}

const HOME = homedir();

/** Masks everything that could be personal or secret in free text. */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let t = String(text);
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join('[secret]');
  if (HOME && HOME.length > 1) t = t.split(HOME).join('~');
  t = t.replace(/\/Users\/[^/\s"']+/g, '/Users/[user]').replace(/\/home\/[^/\s"']+/g, '/home/[user]');
  // Long random-looking runs (tokens, keys, hashes).
  t = t.replace(/[A-Za-z0-9_-]{32,}/g, '[masked]');
  t = t.replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{6,}/gi, '[masked]');
  // Quoted strings can carry user text (JSON parse errors quote the input).
  t = t.replace(/"[^"]{0,2000}"/g, '"…"').replace(/'[^']{0,2000}'/g, "'…'");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
  return t.length > 600 ? t.slice(0, 600) + '…' : t;
}

function fieldText(v: unknown, secrets: Iterable<string>): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const t = redact(String(v), secrets);
  return /^[\w.:/()-]{1,120}$/.test(t) ? t : JSON.stringify(t);
}

export function createLogger(opts: { dir: string | null; level?: LogLevel; echo?: boolean }): Logger {
  const level = ORDER[opts.level ?? 'info'] ?? ORDER.info;
  const secrets = new Set<string>();
  const file = opts.dir ? join(opts.dir, 'server.log') : null;
  if (opts.dir) {
    try { mkdirSync(opts.dir, { recursive: true, mode: 0o700 }); } catch { /* logged to nowhere */ }
  }
  function write(lv: LogLevel, event: string, fields?: Record<string, unknown>) {
    if (ORDER[lv] > level) return;
    let line = `${new Date().toISOString()} ${lv} ${/^[\w.]+$/.test(event) ? event : 'event'}`;
    if (fields) for (const [k, v] of Object.entries(fields)) line += ` ${k}=${fieldText(v, secrets)}`;
    line = line.replace(/[\r\n]+/g, ' ') + '\n';
    if (opts.echo) process.stderr.write(line);
    if (!file) return;
    try {
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1');
      } catch { /* no file yet */ }
      appendFileSync(file, line, { mode: 0o600 });
    } catch { /* a full disk must not stop the server; the write path reports its own errors */ }
  }
  return {
    error: (e, f) => write('error', e, f),
    warn: (e, f) => write('warn', e, f),
    info: (e, f) => write('info', e, f),
    debug: (e, f) => write('debug', e, f),
    addSecret: (s) => { if (s) secrets.add(s); },
  };
}

export function parseLogLevel(v: string | undefined): LogLevel {
  return v === 'error' || v === 'warn' || v === 'info' || v === 'debug' ? v : 'info';
}
