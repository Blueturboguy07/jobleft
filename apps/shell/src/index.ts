// @jobleft/shell: the desktop shell. Tauri v2 (apps/shell/src-tauri, Rust) with the Node server as a sidecar;
// Electron is the fallback (plan section 2, spike S3). The shell owns the window, the tray (menu bar) item,
// single-instance, notifications and quit. This file holds the Node-side contract the shell follows.
// Status: skeleton (foundation). The shell lane creates src-tauri. Cargo builds use the one shared target dir
// <main checkout>/.cache/cargo-target (CARGO_TARGET_DIR, shared by every worktree). No signing, no notarizing in lanes.
// Interface: docs/INTERFACES.md, section "@jobleft/shell" and "Start the whole app".

export const PACKAGE_NAME = '@jobleft/shell';

/** The environment the shell gives the server sidecar at each launch. */
export function sidecarEnv(input: {
  home: string;
  launchToken: string;
  parentPid: number;
  uiDir: string | null;
  port?: number;
}): Record<string, string> {
  const env: Record<string, string> = {
    JOBLEFT_HOME: input.home,
    JOBLEFT_LAUNCH_TOKEN: input.launchToken,
    JOBLEFT_PARENT_PID: String(input.parentPid),
  };
  if (input.uiDir) env.JOBLEFT_UI_DIR = input.uiDir;
  if (input.port) env.JOBLEFT_PORT = String(input.port);
  return env;
}

/** How long the shell waits for GET /api/v1/health before it shows a plain error. */
export const READY_TIMEOUT_MS = 15_000;
/** How often the shell polls GET /api/v1/notifications while running (window closed or open). */
export const NOTIFICATION_POLL_MS = 60_000;
