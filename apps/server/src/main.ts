// Entry point: `node apps/server/src/main.ts`. Reads the environment (docs/INTERFACES.md section 4), starts the
// server, and prints the address and the launch token for headless use. SIGTERM, SIGINT and SIGHUP stop it cleanly
// within 5 seconds (server O11).
//
// Exit codes: 0 stopped cleanly; 1 could not start; 2 the data folder was refused (newer, read-only, full, not
// jobleft) and left untouched; 3 another jobleft server already uses this data folder.

import { join } from 'node:path';
import { newLaunchToken, resolveHome } from './home.ts';
import { DataFolderError } from './db/open.ts';
import { AlreadyRunningError, startServer } from './server.ts';
import { APP_VERSION } from './version.ts';

// Every file the server makes is readable by this user only (server O1 step 6).
process.umask(0o077);

const env = process.env;
const home = resolveHome(env);
// Any temporary file (Node's or SQLite's) goes inside the data folder, never to the system temp folder (server O6).
process.env.TMPDIR = join(home, 'tmp');
process.env.SQLITE_TMPDIR = join(home, 'tmp');
const token = env.JOBLEFT_LAUNCH_TOKEN || newLaunchToken();
// The token must not stay in the environment: child processes (the Keychain helper) would inherit it.
delete process.env.JOBLEFT_LAUNCH_TOKEN;
const quiet = env.JOBLEFT_QUIET === '1';
const portText = env.JOBLEFT_PORT;
const port = portText && /^\d{1,5}$/.test(portText) ? Number(portText) : undefined;
const parent = env.JOBLEFT_PARENT_PID && /^\d+$/.test(env.JOBLEFT_PARENT_PID) ? Number(env.JOBLEFT_PARENT_PID) : null;

process.on('unhandledRejection', (e) => {
  process.stderr.write(`jobleft: an internal task failed (${e instanceof Error ? e.name : 'error'}); the server keeps running.\n`);
});

// A bug that escapes every handler stops the server cleanly (fail-stop): one plain line on stderr (never a stack
// trace, a path or personal text), the run file and the lock removed, exit code 1. Every confirmed save is on disk.
let running: { close(): Promise<void> } | null = null;
let crashed = false;
process.on('uncaughtException', (e) => {
  if (crashed) return;
  crashed = true;
  process.stderr.write(`jobleft: an internal error stopped the server (${e instanceof Error ? e.name : 'error'}). Your saved data is safe; start jobleft again.\n`);
  const force = setTimeout(() => process.exit(1), 4000);
  force.unref();
  (running ? running.close() : Promise.resolve()).then(() => process.exit(1), () => process.exit(1));
});

try {
  const s = await startServer({
    home,
    port,
    launchToken: token,
    uiDir: env.JOBLEFT_UI_DIR || null,
    dev: env.JOBLEFT_DEV === '1',
    offline: env.JOBLEFT_OFFLINE === '1',
    parentPid: parent,
    env,
    onStop: () => process.exit(0),
  });
  running = s;
  if (!quiet) {
    process.stdout.write([
      `jobleft server ${APP_VERSION}`,
      `Data folder: ${home}`,
      `Listening on ${s.origin} (127.0.0.1 only)`,
      `Open in a browser: ${s.uiUrl}`,
      `Launch token (send it as the x-jobleft-token header): ${token}`,
      'Stop with Ctrl+C (or SIGTERM).',
      '',
    ].join('\n'));
  }
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(0), 4500);
    force.unref();
    s.close().then(() => process.exit(0), () => process.exit(0));
    void signal;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGHUP', () => stop('SIGHUP'));
} catch (e) {
  if (e instanceof AlreadyRunningError) {
    const where = e.run ? ` at http://127.0.0.1:${e.run.port}/` : '';
    process.stderr.write(`jobleft is already running for this data folder${where} (process ${e.holder?.pid ?? 'unknown'}). This second copy did not start.\n`);
    process.exit(3);
  }
  if (e instanceof DataFolderError) {
    process.stderr.write(`jobleft did not start: ${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`jobleft did not start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
