// @jobleft/server: the local HTTP server. One process per data folder. It serves the LOCAL API (routes in
// @jobleft/contracts LOCAL_API) and the built UI, on 127.0.0.1 only, with the launch token, Host and Origin checks,
// no permissive CORS, JSON-only writes and one error shape. It wires every package together.
// Interface: docs/INTERFACES.md, sections "@jobleft/server" and "Local API". How to run it: apps/server/README.md.

export const PACKAGE_NAME = '@jobleft/server';

export { homeLayout, newLaunchToken, resolveHome } from './home.ts';
export type { HomeLayout } from './home.ts';
export { AlreadyRunningError, startServer } from './server.ts';
export type { RunningServer, ServerOptions } from './server.ts';
export { DataFolderError } from './db/open.ts';
export { SERVER_SCHEMA_VERSION } from './db/schema.ts';
export { readRunFile } from './runfile.ts';
export type { RunInfo } from './runfile.ts';
export { memorySecrets } from './services/secrets.ts';
export { APP_VERSION } from './version.ts';
