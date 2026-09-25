#!/usr/bin/env node
// jobleft-ai: the AI engine from the command line (the lane's own front end until the app screens exist).
// Run: node packages/ai-engine/src/cli.ts <command>. `help` lists every command. Plain words; no key is ever printed.

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AiSettingsUpdate, JsonSchema, LocalServerKind, OwnKeyVendor } from '@jobleft/contracts';
import { formatDollars, int, arr, str, obj, named } from '@jobleft/contracts';
import type { AiEngine } from './engine.ts';
import { asAiError } from './errors.ts';
import { PUBLIK_DISCLOSURE, PUBLIK_DISCLOSURE_VERSION, PUBLIK_JUSTIFICATION } from './publik.ts';
import { createEngineFromEnv } from './setup.ts';
import { METERED_PRICES_PER_1000_MICROS } from './state.ts';
import { parseScoresHeader, readFieldLines } from './structured.ts';
import { startDevServer } from './serve.ts';
import { MODE_HELP, MODEL_MODES, startMockModelServer, type ModelMode } from './mock/model-server.ts';
import { PUBLIK_MODES, STANDIN_APP_TOKEN, startMockPublikServer } from './mock/publik-server.ts';

const HELP = `jobleft-ai: choose an AI provider, test it, chat, and manage the publik connection.

Usage: node packages/ai-engine/src/cli.ts <command> [options]
Data folder: $JOBLEFT_HOME (default: the app's data folder). Keys go to the macOS Keychain
(JOBLEFT_SECRET_STORE=file: an encrypted 0600 file in $JOBLEFT_HOME/secrets instead).

Provider
  providers                         List the provider options
  status                            Show the active provider, model, key (last 4 characters only) and publik balance
  detect                            Look for local model servers on this computer (Ollama, LM Studio, llama.cpp)
  use publik [--model publik-balanced|publik-fast|publik-smart]
  use local [--kind ollama|llamacpp|mlx|lmstudio|openai_compatible] [--url URL] [--model NAME]
  use custom --url URL [--model NAME]
  use own-key --vendor openai|anthropic|openrouter|google [--model NAME]
  use none                          No provider (the app still works; AI features say they need one)
  key set                           Save the key of the current provider (read from stdin; never shown)
  key forget                        Forget the key of the current provider
  check                             Test the provider now and name the problem, if any
  models                            List the models the provider says it has

AI requests
  chat "message"                    Stream one answer. Ctrl-C cancels. A failed message is kept for --resend
  chat --resend                     Send the kept message again
  json "text"                       Ask for a structured fit answer (score 0-100, reasons) and check it

publik
  publik connect [--yes]            Show the disclosure, then connect (no key is typed, pasted or shown)
  publik status                     Read the balance again and show it in dollars
  publik disconnect                 Revoke and delete the publik key on this computer
  metered status|on|off [--yes]     Paid page fetch and web search (off until you turn it on; prices shown first)

Test tools (loopback only)
  mock-model [--port 4030] [--mode ok] [--key K] [--models a,b] [--thinking-models a] [--slow-ms 1000] [--log FILE]
  mock-publik [--port 4020] [--balance 5.00] [--price 0.01] [--log FILE]
  serve [--port 0]                  This lane's local API routes with the app's security rules
  secrets forget-all                Delete every key this data folder saved (provider keys and publik)
`;

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function flag(flags: Record<string, string | true>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

const out = (s = '') => process.stdout.write(`${s}\n`);
// A closed pipe (for example "| head") ends the command quietly.
process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    // Read without echo, so the key never shows on the screen.
    process.stdout.write('Paste the key and press Enter (it is not shown): ');
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let buf = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const onData = (ch: string) => {
        for (const c of ch) {
          if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(buf); return; }
          if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
          if (c === '\u007f') buf = buf.slice(0, -1); else buf += c;
        }
      };
      stdin.on('data', onData);
    });
  }
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

async function confirm(question: string, flags: Record<string, string | true>): Promise<boolean> {
  if (flags.yes === true) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} Type yes to go on: `, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

function printCheck(check: { ok: boolean; problem: string | null; message: string; link?: { label: string; url: string } }): void {
  out(check.ok ? `Setup check: ${check.message}` : `Setup check: problem${check.problem ? ` (${check.problem.replace(/_/g, ' ')})` : ''}. ${check.message}`);
  if (check.link) out(`${check.link.label}: ${check.link.url}`);
}

function pricesText(): string {
  const p = METERED_PRICES_PER_1000_MICROS;
  return `Prices per 1,000 requests: web search ${formatDollars(p.search)}, page fetch ${formatDollars(p.page)}, page that needs JavaScript ${formatDollars(p.jsPage)}. jobleft always tries a free plain fetch first.`;
}

async function printStatus(engine: AiEngine): Promise<void> {
  const s = engine.settings();
  out(`Provider: ${s.provider ? engine.describe(s) : 'none (the app works without one; AI features ask you to set one up)'}`);
  if (s.provider && s.provider !== 'publik') out(`Key: ${s.keySet ? (s.keyHint ? `saved, ends in "${s.keyHint}"` : 'saved') : 'none saved'}`);
  out(`Paid page fetch and web search: ${s.meteredFetch.enabled ? 'on' : 'off'}. ${pricesText()}`);
  let conn = await engine.publik.status();
  if (conn.state === 'connected') {
    try { conn = await engine.publik.refresh(); } catch (e) { out(`publik: the balance could not be read now (${asAiError(e).message})`); }
  }
  if (conn.state === 'connected') {
    const w = conn.wallet;
    out(`publik: connected. Balance: ${w ? formatDollars(w.balanceMicros) : 'unknown (not read yet)'}${w ? ` (read ${w.updatedAt})` : ''}`);
    if (w) out(`${w.claimState === 'anonymous' ? 'Link this computer & pick a plan' : 'Add a plan or pack'}: ${w.topUpUrl}`);
  } else out('publik: not connected');
}

// ------------------------------------------------------------------ chat

function unsentPath(home: string): string { return join(home, 'ai', 'unsent.json'); }

function keepUnsent(home: string, text: string, reason: string): void {
  mkdirSync(dirname(unsentPath(home)), { recursive: true, mode: 0o700 });
  writeFileSync(unsentPath(home), JSON.stringify({ text, reason, at: new Date().toISOString(), status: 'not sent' }), { mode: 0o600 });
}

async function chat(engine: AiEngine, home: string, text: string): Promise<number> {
  let client;
  try { client = engine.client(); } catch (e) {
    keepUnsent(home, text, asAiError(e).message);
    out(`Not sent: ${asAiError(e).message}`);
    out('Your message is kept. Send it again with: jobleft-ai chat --resend');
    return 1;
  }
  const requestId = randomUUID();
  out(`[${engine.describe()}]`);
  let cancelled = false;
  const onSig = () => {
    if (cancelled) process.exit(130);
    cancelled = true;
    engine.cancel(requestId);
  };
  process.on('SIGINT', onSig);
  let got = '';
  try {
    for await (const c of client.chat({ messages: [{ role: 'user', content: text }], requestId })) {
      if (c.type === 'delta') { got += c.text; process.stdout.write(c.text); }
      if (c.type === 'done') {
        if (got && !got.endsWith('\n')) process.stdout.write('\n');
        if (c.incomplete) {
          out(`[incomplete: ${c.reason?.message ?? 'the answer stopped early.'}]`);
          keepUnsent(home, text, c.reason?.message ?? 'incomplete answer');
          out('Your message is kept. Send it again with: jobleft-ai chat --resend');
        } else {
          out(`[done${c.costMicros !== null ? `, publik charged ${formatDollars(c.costMicros)}` : ''}]`);
          if (existsSync(unsentPath(home))) rmSync(unsentPath(home));
        }
      }
    }
    await engine.idle();
    if (client.provider === 'publik') {
      const w = (await engine.publik.status()).wallet;
      if (w) out(`publik balance: ${formatDollars(w.balanceMicros)}`);
    }
    return 0;
  } catch (e) {
    const err = asAiError(e);
    if (got && !got.endsWith('\n')) process.stdout.write('\n');
    if (err.code === 'cancelled') {
      out(got ? '[cancelled: the part above is incomplete]' : '[cancelled]');
      keepUnsent(home, text, 'cancelled');
      return 130;
    }
    out(`Not sent: ${err.message}`);
    if (err.topUpUrl) out(`${err.code === 'needs_claim' ? 'Link this computer' : 'Add money'}: ${err.topUpUrl}`);
    keepUnsent(home, text, err.message);
    out('Your message is kept. Send it again with: jobleft-ai chat --resend');
    await engine.idle();
    return 1;
  } finally {
    process.off('SIGINT', onSig);
  }
}

const FitSchema = named(obj({
  score: int({ minimum: 0, maximum: 100 }),
  reasons: arr(str({ minLength: 1 }), { minItems: 1, maxItems: 5 }),
}, { missing: arr(str()) }), 'FitAnswer', 'A fit score with its reasons');

async function jsonTask(engine: AiEngine, text: string): Promise<number> {
  try {
    const client = engine.client();
    out(`[${engine.describe()}]`);
    const result = await client.json({
      schema: FitSchema as JsonSchema & typeof FitSchema,
      messages: [
        { role: 'system', content: 'You rate how well a candidate fits a job, from 0 to 100, and give short reasons. If you cannot write JSON, write "SCORES: fit=<number>" on the first line and one reason per line starting with "- ".' },
        { role: 'user', content: text },
      ],
      lineFallback: (t) => {
        const scores = parseScoresHeader(t);
        const fields = readFieldLines(t, FitSchema);
        const reasons = t.split(/\r?\n/).map((l) => /^\s*[-•]\s+(.+)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
        const score = scores?.fit ?? scores?.score ?? (typeof fields?.score === 'number' ? fields.score : undefined);
        if (score === undefined || reasons.length === 0) return null;
        return { score, reasons: reasons.slice(0, 5) };
      },
    });
    out(JSON.stringify(result, null, 2));
    await engine.idle();
    return 0;
  } catch (e) {
    const err = asAiError(e);
    out(err.code === 'bad_answer' ? `Cannot use this answer: ${err.message}` : `Not done: ${err.message}`);
    if (err.topUpUrl) out(`${err.code === 'needs_claim' ? 'Link this computer' : 'Add money'}: ${err.topUpUrl}`);
    out('Try again: run the same command again.');
    await engine.idle();
    return 1;
  }
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] ?? 'help';

  if (cmd === 'help' || cmd === '--help' || flags.help) { out(HELP); return 0; }

  if (cmd === 'mock-model') {
    const mode = (flag(flags, 'mode') ?? 'ok') as ModelMode;
    if (!(MODEL_MODES as readonly string[]).includes(mode)) fail(`--mode must be one of: ${MODEL_MODES.join(', ')}`, 2);
    const m = await startMockModelServer({
      port: Number(flag(flags, 'port') ?? 4030), mode, key: flag(flags, 'key') ?? null,
      models: flag(flags, 'models')?.split(',').map((x) => x.trim()).filter(Boolean),
      thinkingModels: flag(flags, 'thinking-models')?.split(',').map((x) => x.trim()).filter(Boolean),
      slowMs: flag(flags, 'slow-ms') ? Number(flag(flags, 'slow-ms')) : undefined, log: flag(flags, 'log') ?? null,
    });
    out(`Stand-in model server on ${m.url} (OpenAI style: ${m.url}/v1, Ollama: ${m.url}, Anthropic: ${m.url}/v1/messages)`);
    out(`Mode: ${mode}. Change it: curl -s -X POST ${m.url}/__admin/mode -H 'content-type: application/json' -d '{"mode":"stall"}'`);
    out(`Modes:\n${MODEL_MODES.map((x) => `  ${x.padEnd(20)} ${MODE_HELP[x]}`).join('\n')}`);
    out(`Request log (with headers): curl -s ${m.url}/__admin/log${flag(flags, 'log') ? ` (also appended to ${flag(flags, 'log')})` : ''}`);
    out('Press Ctrl-C to stop.');
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    await m.close();
    return 0;
  }
  if (cmd === 'mock-publik') {
    const p = await startMockPublikServer({
      port: Number(flag(flags, 'port') ?? 4020), balanceUsd: Number(flag(flags, 'balance') ?? 5), priceUsd: Number(flag(flags, 'price') ?? 0.01),
      log: flag(flags, 'log') ?? null,
    });
    out(`Stand-in publik API on ${p.baseUrl} (balance ${formatDollars(p.state().balanceMicros)}, ${formatDollars(p.state().priceMicros)} per metered call)`);
    out(`Point jobleft at it: export JOBLEFT_PUBLIK_BASE_URL=${p.baseUrl} JOBLEFT_PUBLIK_APP_TOKEN=${STANDIN_APP_TOKEN}`);
    out(`Set the balance: curl -s -X POST http://127.0.0.1:${p.port}/__admin/balance -H 'content-type: application/json' -d '{"usd":0}'`);
    out(`Add money:       curl -s -X POST http://127.0.0.1:${p.port}/__admin/add -H 'content-type: application/json' -d '{"usd":5}'`);
    out(`Other admin: /__admin/price {"usd":0.01}, /__admin/claim {"claimed":true}, /__admin/mode {"mode":"${PUBLIK_MODES.join('|')}"}, GET /__admin/log, GET /__admin/state`);
    out('Press Ctrl-C to stop.');
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    await p.close();
    return 0;
  }

  const { engine, home } = createEngineFromEnv();

  switch (cmd) {
    case 'providers':
      out('Provider options (choose one; jobleft never moves a request to another provider by itself):');
      out('  publik     the publik API: connect once, no key to type; paid from your publik balance in dollars');
      out('  local      a model server on this computer: Ollama, llama.cpp, MLX, LM Studio, or any OpenAI-style server on 127.0.0.1');
      out('  custom     any OpenAI-style address (with or without /v1), with an optional key');
      out('  own-key    your own key for OpenAI, Anthropic, OpenRouter or Google');
      out('There is no sign-in with a Claude consumer subscription.');
      return 0;
    case 'status':
      await printStatus(engine);
      return 0;
    case 'detect': {
      const found = await engine.detectLocal();
      if (found.length === 0) { out('No local model server answers on this computer (checked Ollama 11434, LM Studio 1234, llama.cpp 8080).'); return 1; }
      for (const f of found) out(`${f.kind} at ${f.baseUrl}: ${f.models.length ? f.models.join(', ') : 'no models installed'}`);
      return 0;
    }
    case 'use': {
      const kind = pos[1];
      if (kind === 'none') { engine.clearProvider(); out('No provider. AI features will say that they need one.'); return 0; }
      const map: Record<string, AiSettingsUpdate['provider']> = { publik: 'publik', local: 'local', custom: 'custom', 'own-key': 'own_key', own_key: 'own_key' };
      const provider = kind ? map[kind] : undefined;
      if (!provider) fail('Usage: use publik|local|custom|own-key|none [options]. Run "help" for the options.', 2);
      const update: AiSettingsUpdate = { provider };
      if (flag(flags, 'kind')) update.localKind = flag(flags, 'kind') as LocalServerKind;
      if (flag(flags, 'url')) update.baseUrl = flag(flags, 'url')!;
      if (flag(flags, 'model')) update.model = flag(flags, 'model')!;
      if (flag(flags, 'vendor')) update.vendor = flag(flags, 'vendor') as OwnKeyVendor;
      try {
        const { check } = await engine.updateSettings(update);
        out(`Saved. Active provider: ${engine.describe()}`);
        printCheck(check);
        return check.ok ? 0 : 1;
      } catch (e) { fail(asAiError(e).message); }
    }
    case 'key': {
      if (pos[1] === 'set') {
        const key = (await readStdin()).trim();
        try {
          const s = await engine.setKey(key);
          out(`Key saved for ${engine.describe(s)}. It shows as ${s.keyHint ? `"...${s.keyHint}"` : '"saved"'} from now on.`);
          out('Run "check" to test it.');
          return 0;
        } catch (e) { fail(asAiError(e).message); }
      }
      if (pos[1] === 'forget') { await engine.deleteKey(); out('The key of the current provider is forgotten.'); return 0; }
      fail('Usage: key set | key forget', 2);
    }
    case 'check': {
      const check = await engine.check();
      out(`Provider: ${engine.describe()}`);
      printCheck(check);
      await engine.idle();
      return check.ok ? 0 : 1;
    }
    case 'models':
      try {
        const models = await engine.listModels();
        out(models.length ? models.join('\n') : 'The provider lists no models.');
        return 0;
      } catch (e) { fail(asAiError(e).message); }
    case 'chat': {
      let text = pos.slice(1).join(' ');
      if (flags.resend === true) {
        if (!existsSync(unsentPath(home))) fail('There is no kept message to send again.');
        text = String(JSON.parse(readFileSync(unsentPath(home), 'utf8')).text ?? '');
      }
      if (!text.trim()) fail('Usage: chat "message"  or  chat --resend', 2);
      return chat(engine, home, text);
    }
    case 'json': {
      const text = pos.slice(1).join(' ');
      if (!text.trim()) fail('Usage: json "candidate and job text"', 2);
      return jsonTask(engine, text);
    }
    case 'publik': {
      const sub = pos[1] ?? 'status';
      if (sub === 'connect') {
        const conn = await engine.publik.status();
        if (conn.state === 'connected') { out('publik is already connected (one connection, one key).'); await printStatus(engine); return 0; }
        out('Before jobleft connects to publik:');
        for (const line of PUBLIK_DISCLOSURE) out(`  ${line}`);
        if (!(await confirm('Connect to publik?', flags))) { out('Not connected. Nothing was sent. (Add --yes to accept the text above without a prompt.)'); return 1; }
        try {
          const c = await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
          out('publik is connected. No key was typed, pasted or shown; it is in the secret store.');
          const w = c.wallet;
          out(`Balance: ${w ? formatDollars(w.balanceMicros) : 'unknown until the next refresh'}`);
          out(`Why it costs money: ${PUBLIK_JUSTIFICATION}`);
          if (w) out(`${w.claimState === 'anonymous' ? 'Link this computer & pick a plan' : 'Add a plan or pack'}: ${w.topUpUrl}`);
          out('To use it for AI requests: jobleft-ai use publik');
          return 0;
        } catch (e) { fail(`Not connected: ${asAiError(e).message}`); }
      }
      if (sub === 'status' || sub === 'refresh') { await printStatus(engine); return 0; }
      if (sub === 'disconnect') {
        await engine.publik.disconnect();
        out('publik is disconnected. The key was revoked at publik and deleted from this computer; nothing spends your balance now.');
        return 0;
      }
      fail('Usage: publik connect|status|disconnect', 2);
    }
    case 'metered': {
      const sub = pos[1] ?? 'status';
      if (sub === 'status') { out(`Paid page fetch and web search: ${engine.settings().meteredFetch.enabled ? 'on' : 'off'}. ${pricesText()}`); return 0; }
      if (sub === 'off') { engine.setMeteredFetch(false); out('Paid page fetch and web search: off. Nothing is spent on them.'); return 0; }
      if (sub === 'on') {
        out(pricesText());
        out('This is paid from your publik balance (or your own provider key), only when a free fetch cannot get the page.');
        if (!(await confirm('Turn paid page fetch and web search on?', flags))) { out('Still off.'); return 1; }
        engine.setMeteredFetch(true);
        out('Paid page fetch and web search: on.');
        return 0;
      }
      fail('Usage: metered status|on|off', 2);
    }
    case 'serve': {
      const srv = await startDevServer(engine, { port: flag(flags, 'port') ? Number(flag(flags, 'port')) : 0, token: process.env.JOBLEFT_LAUNCH_TOKEN || undefined });
      out(`Serving this lane's routes on ${srv.origin} (loopback only).`);
      out(`Launch token (send it as the x-jobleft-token header): ${srv.token}`);
      out('Press Ctrl-C to stop.');
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      await srv.close();
      return 0;
    }
    case 'secrets': {
      if (pos[1] !== 'forget-all') fail('Usage: secrets forget-all', 2);
      const n = await engine.forgetAllKeys();
      out(`Deleted the saved keys of this data folder (${n} found).`);
      return 0;
    }
    default:
      out(HELP);
      return 2;
  }
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`${asAiError(e).message}\n`);
  process.exit(1);
});
