// @jobleft/server: the local HTTP server. One process per data folder. It serves the LOCAL API (routes in
// @jobleft/contracts LOCAL_API) and the built UI, on 127.0.0.1 only, with the launch token, Host and Origin checks,
// no permissive CORS, JSON-only writes and one error shape. It wires every package together.
// Status: interface stubs (foundation), except resolveHome, homeLayout and newLaunchToken. The server lane builds
// the rest. Interface: docs/INTERFACES.md, section "@jobleft/server" and "Local API".

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PACKAGE_NAME = '@jobleft/server';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/server)`);
}

/**
 * The data folder: JOBLEFT_HOME when set, else the OS default
 * (macOS ~/Library/Application Support/jobleft, Windows %APPDATA%\jobleft, others ~/.local/share/jobleft).
 */
export function resolveHome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.JOBLEFT_HOME) return env.JOBLEFT_HOME;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jobleft');
}

/** Every path inside the data folder. Nothing personal is written outside it (server O6). */
export function homeLayout(home: string) {
  return {
    home,
    db: join(home, 'data', 'jobleft.db'),
    files: join(home, 'files'),
    resumes: join(home, 'files', 'resumes'),
    exports: join(home, 'files', 'exports'),
    datasets: join(home, 'datasets'),
    models: join(home, 'models'),
    backups: join(home, 'backups'),
    logs: join(home, 'logs'),
    tmp: join(home, 'tmp'),
    run: join(home, 'run'),
    runFile: join(home, 'run', 'server.json'),
    lockFile: join(home, 'run', 'server.lock'),
  } as const;
}

/** A fresh launch token: 32 random bytes, base64url (43 characters). New at every launch. */
export function newLaunchToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface ServerOptions {
  home: string;
  /** 0 or undefined = the first free port of DEFAULT_PORT .. DEFAULT_PORT + PORT_SPAN - 1. */
  port?: number;
  launchToken: string;
  /** The built UI (apps/ui/dist). null = API only. */
  uiDir?: string | null;
  /** JOBLEFT_DEV=1: enables POST /api/v1/dev/clock and pretty logs. */
  dev?: boolean;
  /** The shell's pid. The server exits within 10 s after that process is gone (server O11). */
  parentPid?: number | null;
  /** JOBLEFT_OFFLINE=1: no outbound request at all (crawl and AI answer "offline"). */
  offline?: boolean;
  env?: Record<string, string | undefined>;
}

export interface RunningServer {
  port: number;
  /** "http://127.0.0.1:<port>" */
  origin: string;
  /** origin + "/#token=<launch token>" (the token rides in the fragment, never sent to a server). */
  uiUrl: string;
  close(): Promise<void>;
}

/**
 * Starts the server: takes the single-instance lock ($home/run/server.lock), opens and migrates the database,
 * listens on 127.0.0.1, writes $home/run/server.json (mode 0600: pid, port, token, version, startedAt), then starts
 * the crawl scheduler without waiting for it. A second server on the same folder exits with a plain message.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> { return notImplemented('startServer'); }
