// A desktop notification for due follow-ups (macOS: Notification Center through `osascript`; Linux: `notify-send`). The text holds a
// count only, never a name: Notification Center keeps its own copy outside the jobleft data folder, and a delete in
// jobleft could not remove it. In the packaged app the shell shows these (GET /api/v1/notifications).

import { execFile, execFileSync } from 'node:child_process';

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Why no notification was shown, or 'shown'. The due list is the reminder either way. */
export type NotifyResult = 'shown' | 'off' | 'unsupported';

/** Shows one notification (macOS, Linux). 'off' when JOBLEFT_NO_OS_NOTIFY=1; 'unsupported' on other systems. */
export function showDesktopNotification(title: string, body: string, opts: { wait?: boolean } = {}): NotifyResult {
  if (process.env.JOBLEFT_NO_OS_NOTIFY === '1') return 'off';
  let cmd: string, args: string[];
  if (process.platform === 'darwin') {
    cmd = '/usr/bin/osascript';
    args = ['-e', `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`];
  } else if (process.platform === 'linux') {
    // Arguments, not a shell: nothing in the text is interpreted. '--' keeps a leading '-' from reading as a flag.
    cmd = 'notify-send';
    args = ['--app-name=jobleft', '--', title, body];
  } else return 'unsupported';
  if (opts.wait) {
    // The CLI waits, so the notification is posted before the command exits.
    try { execFileSync(cmd, args, { timeout: 10_000, stdio: 'ignore' }); return 'shown'; } catch { return 'unsupported'; }
  }
  try {
    const child = execFile(cmd, args, { timeout: 10_000 }, () => { /* errors are not fatal */ });
    child.unref();
    return 'shown';
  } catch {
    return 'unsupported';
  }
}
