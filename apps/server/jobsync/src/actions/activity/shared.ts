import { APP_CONSTANTS } from "@/lib/constants";

// Not a "use server" module: it exports selects and sync helpers, so it stays
// internal to src/actions/activity/ and is never imported by a client component.

// Re-exported so the existing "./shared" import in each activity module keeps
// working now that requireUser is shared with the other action directories.
export { requireUser } from "../shared";

// One shape for every action that returns the running activity, so the client
// can never receive a copy missing its break state.
export const RUNNING_ACTIVITY_SELECT = {
  id: true,
  activityName: true,
  startTime: true,
  endTime: true,
  description: true,
  createdAt: true,
  activityType: true,
  breakMinutes: true,
  breakStartedAt: true,
  breakPlannedMins: true,
};

export const clampBreakMinutes = (minutes: number) =>
  Math.min(
    Math.max(minutes, APP_CONSTANTS.ACTIVITY_BREAK_MIN_MINUTES),
    APP_CONSTANTS.ACTIVITY_BREAK_MAX_MINUTES,
  );

// Rounded, not floored: repeated short breaks would otherwise be lost entirely.
export const breakMinutesSince = (start: Date, now: Date = new Date()) =>
  Math.max(0, Math.round((now.getTime() - start.getTime()) / 60000));
