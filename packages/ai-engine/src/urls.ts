// Addresses: normalising what a person types, the loopback rule for "local", vendor addresses for own keys,
// and the stand-in host map for tests (JOBLEFT_AI_HOST_MAP, loopback targets only).

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { LocalServerKind, OwnKeyVendor } from '@jobleft/contracts';
import { AiError } from './errors.ts';

/** The fixed API roots of the own-key vendors. A key saved for a vendor goes only here. */
export const VENDOR_BASE_URLS: Readonly<Record<OwnKeyVendor, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

/** Default addresses of local model servers (all loopback). */
export const LOCAL_DEFAULT_URLS: Readonly<Record<LocalServerKind, string | null>> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234/v1',
  llamacpp: 'http://127.0.0.1:8080/v1',
  mlx: 'http://127.0.0.1:8080/v1',
  openai_compatible: null,
};

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}

/**
 * Parses an address a person typed. Accepts "127.0.0.1:1234", "http://host:port", with or without "/v1" and a
 * trailing slash. Refuses anything that is not http or https, and addresses with a user name or password in them.
 */
export function parseBaseUrl(input: string): URL {
  let text = input.trim();
  if (!text) throw new AiError('bad_request', 'Type the address of the AI server, for example http://127.0.0.1:1234.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new AiError('bad_request', 'This is not a web address. Type it like http://127.0.0.1:1234.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AiError('bad_request', 'The address must start with http:// or https://.');
  }
  if (u.username || u.password) {
    throw new AiError('bad_request', 'Do not put a user name, password or key in the address. Save the key in the key field.');
  }
  if (u.search || u.hash) {
    throw new AiError('bad_request', 'The address must not have a "?" or "#" part. Save a key in the key field, never in the address.');
  }
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u;
}

/** The address as it is saved: no trailing slash. */
export function normalizeBaseUrl(input: string): string {
  const u = parseBaseUrl(input);
  return `${u.origin}${u.pathname}`;
}

/** Candidate API roots of an OpenAI-compatible server: ".../v1" first when the address has no "/v1". */
export function openAiRootCandidates(base: string): string[] {
  const u = parseBaseUrl(base);
  const path = u.pathname;
  if (/\/v\d+(beta)?(\/openai)?$/.test(path) || /\/openai$/.test(path) || /\/api\/v1$/.test(path)) return [`${u.origin}${path}`];
  return [`${u.origin}${path}/v1`, `${u.origin}${path}`];
}

/** The origin a key is bound to: a key saved for one origin is never sent to another. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Stand-in map for tests: JOBLEFT_AI_HOST_MAP='{"api.openai.com":"http://127.0.0.1:4030"}'.
 * Targets must be loopback. Only the own-key vendor hosts can be mapped. Anything else is refused.
 */
export function aiHostMapFromEnv(env: Record<string, string | undefined> = process.env): Map<string, string> {
  const raw = env.JOBLEFT_AI_HOST_MAP;
  const out = new Map<string, string>();
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AiError('bad_request', 'JOBLEFT_AI_HOST_MAP is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AiError('bad_request', 'JOBLEFT_AI_HOST_MAP must be a JSON object.');
  const vendorHosts = new Set(Object.values(VENDOR_BASE_URLS).map((u) => new URL(u).host));
  for (const [host, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (!vendorHosts.has(host)) throw new AiError('bad_request', `JOBLEFT_AI_HOST_MAP can only map the own-key vendor hosts, not ${host}.`);
    if (typeof target !== 'string') throw new AiError('bad_request', 'JOBLEFT_AI_HOST_MAP targets must be strings.');
    const t = parseBaseUrl(target);
    if (!isLoopbackHost(t.hostname)) throw new AiError('bad_request', 'JOBLEFT_AI_HOST_MAP targets must be loopback (127.0.0.1 or localhost).');
    out.set(host, t.origin);
  }
  return out;
}

/** Applies the stand-in map to a vendor URL (same path, loopback origin). */
export function mapVendorUrl(url: string, map: Map<string, string>): string {
  const u = new URL(url);
  const target = map.get(u.host);
  if (!target) return url;
  return `${target}${u.pathname}`;
}
