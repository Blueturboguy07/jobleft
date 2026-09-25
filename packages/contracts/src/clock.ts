// The app clock, with a documented time-skip for tests (crawler O3, O14, O15; sources-other O3; static-data O12).
//   JOBLEFT_NOW=2026-10-01T00:00:00Z   the clock is frozen at this instant
//   JOBLEFT_CLOCK_OFFSET=72h           the clock runs this far ahead of real time (also "-30m", "3d", "90s", "1500ms")
// Server code reads time through nowMs(), never Date.now() directly, for anything stored or compared with stored
// times. Pacing and timeouts use real time. Browser code (the UI, the extension) has no process.env and gets real time.

type Env = Record<string, string | undefined>;

function processEnv(): Env | undefined {
  const p = (globalThis as { process?: { env?: Env } }).process;
  return p?.env;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses "72h", "-30m", "3d", "90s", "1500ms". Throws on anything else. */
export function parseDuration(text: string): number {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(text);
  if (!m) throw new Error(`not a duration: "${text}" (use e.g. 72h, -30m, 3d, 90s, 1500ms)`);
  return Math.round(Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]!);
}

/** Current time in ms since the epoch, honouring JOBLEFT_NOW and JOBLEFT_CLOCK_OFFSET. */
export function nowMs(env: Env | undefined = processEnv()): number {
  const fixed = env?.JOBLEFT_NOW;
  if (fixed) {
    const t = Date.parse(fixed);
    if (!Number.isFinite(t)) throw new Error(`JOBLEFT_NOW is not a date: "${fixed}"`);
    return t;
  }
  const offset = env?.JOBLEFT_CLOCK_OFFSET;
  return Date.now() + (offset ? parseDuration(offset) : 0);
}

/** nowMs() as an ISO string. */
export function nowIso(env?: Env): string {
  return new Date(nowMs(env)).toISOString();
}
