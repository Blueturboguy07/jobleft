// A desktop notification for due follow-ups (macOS: Notification Center through `osascript`). The text holds a
// count only, never a name: Notification Center keeps its own copy outside the jobleft data folder, and a delete in
// jobleft could not remove it. In the packaged app the shell shows these (GET /api/v1/notifications).

import { execFile } from 'node:child_process';

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Shows one notification. Returns false when this system has no supported way (then the due list is the reminder). */
export function showDesktopNotification(title: string, body: string): boolean {
  if (process.platform !== 'darwin' || process.env.JOBLEFT_NO_OS_NOTIFY === '1') return false;
  const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
  try {
    const child = execFile('/usr/bin/osascript', ['-e', script], { timeout: 10_000 }, () => { /* errors are not fatal */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
