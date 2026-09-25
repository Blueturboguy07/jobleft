// Extension pairing (docs/INTERFACES.md section 7, server O3).
//   * Only the person starts pairing: the UI asks for a 6-digit code with the LAUNCH token (a web page cannot).
//   * The code lives 5 minutes, works once, and five wrong guesses void it. All pair attempts share a rate limit.
//   * The extension proves its Origin (chrome-extension://<id>) and gets a 32-byte token. Only its sha256 is kept.
//   * Unpairing deletes the row: the token stops working on the next request.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EXTENSION_PROTOCOL_VERSION, nowIso, nowMs, type PairingCode, type PairingInfo, type PairRequest, type PairResponse } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { tx } from '../db/util.ts';
import { sha256 } from '../http/gate.ts';

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_WRONG = 5;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;

interface ActiveCode { code: string; expiresAt: number; wrong: number }

interface Row { extension_id: string; token_hash: string; browser: string; extension_version: string; paired_at: string; last_seen_at: string | null }

export class PairingService {
  private readonly db: DatabaseSync;
  private active: ActiveCode | null = null;
  private attempts: number[] = [];
  private seenWrites = new Map<string, number>();

  constructor(db: DatabaseSync) { this.db = db; }

  newCode(): PairingCode {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Real time: the code's life is a safety limit, not a fact about jobs, so the test clock does not stretch it.
    const expiresAt = Date.now() + CODE_TTL_MS;
    this.active = { code, expiresAt, wrong: 0 };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Pairs the extension whose Origin id is `originId`. Throws ApiFailure on every refusal. */
  pair(req: PairRequest, originId: string, appVersion: string): PairResponse {
    if (req.extensionId !== originId) {
      throw new ApiFailure('forbidden_origin', 'The extension id does not match the extension that sent the request.');
    }
    const t = Date.now();
    this.attempts = this.attempts.filter((a) => t - a < ATTEMPT_WINDOW_MS);
    if (this.attempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
      const wait = Math.ceil((ATTEMPT_WINDOW_MS - (t - this.attempts[0]!)) / 1000);
      throw new ApiFailure('rate_limited', 'Too many pairing attempts. Wait a minute, then start pairing again in jobleft.', { retryAfterSeconds: Math.max(1, wait) });
    }
    this.attempts.push(t);
    const a = this.active;
    if (!a || a.expiresAt <= t) {
      this.active = null;
      throw new ApiFailure('unauthorized', 'No pairing code is waiting. In jobleft, click "Pair a browser extension" to get a new code.');
    }
    const given = Buffer.from(req.code.padEnd(6, ' ').slice(0, 6));
    const want = Buffer.from(a.code);
    if (!timingSafeEqual(given, want)) {
      a.wrong++;
      if (a.wrong >= MAX_WRONG) {
        this.active = null;
        throw new ApiFailure('unauthorized', 'The pairing code was wrong five times, so it no longer works. Get a new code in jobleft.');
      }
      throw new ApiFailure('unauthorized', 'The pairing code is wrong. Check the code that jobleft shows.');
    }
    this.active = null; // one use
    const token = randomBytes(32).toString('base64url');
    const now = nowIso();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO pairings (extension_id, token_hash, browser, extension_version, paired_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(extension_id) DO UPDATE SET token_hash = excluded.token_hash, browser = excluded.browser,
          extension_version = excluded.extension_version, paired_at = excluded.paired_at, last_seen_at = NULL`)
        .run(req.extensionId, sha256(token).toString('hex'), req.browser.slice(0, 80), req.extensionVersion.slice(0, 40), now);
    });
    return { pairingToken: token, appVersion, protocolVersion: EXTENSION_PROTOCOL_VERSION };
  }

  isPaired(extensionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM pairings WHERE extension_id = ?').get(extensionId) !== undefined;
  }

  /** Constant-time check of a pairing token for one extension. */
  verify(extensionId: string, token: string | undefined): boolean {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return false;
    const r = this.db.prepare('SELECT token_hash FROM pairings WHERE extension_id = ?').get(extensionId) as { token_hash: string } | undefined;
    const want = r ? Buffer.from(r.token_hash, 'hex') : sha256('no pairing: compare anyway');
    const ok = timingSafeEqual(sha256(token), want.length === 32 ? want : sha256('bad hash'));
    return ok && r !== undefined;
  }

  /** Records that a paired extension called (at most one write a minute per extension). */
  touch(extensionId: string): void {
    const t = Date.now();
    if (t - (this.seenWrites.get(extensionId) ?? 0) < 60_000) return;
    this.seenWrites.set(extensionId, t);
    try {
      tx(this.db, () => { this.db.prepare('UPDATE pairings SET last_seen_at = ? WHERE extension_id = ?').run(new Date(nowMs()).toISOString(), extensionId); });
    } catch { /* a read-only moment must not fail the extension's call */ }
  }

  list(): PairingInfo[] {
    const rows = this.db.prepare('SELECT * FROM pairings ORDER BY paired_at, extension_id').all() as unknown as Row[];
    return rows.map((r) => ({ extensionId: r.extension_id, browser: r.browser, extensionVersion: r.extension_version, pairedAt: r.paired_at, lastSeenAt: r.last_seen_at }));
  }

  remove(extensionId: string): boolean {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM pairings WHERE extension_id = ?').run(extensionId).changes) > 0);
  }
}
