// Every provider failure as one plain sentence, and the mapping to the local API error body.
// Rules: a message never holds a key, a token, a stack trace, raw upstream text or prompt text.

import type { ApiError, ErrorCode } from '@jobleft/contracts';
import { ERROR_STATUS } from '@jobleft/contracts';

export type AiErrorCode =
  | 'no_provider' | 'unreachable' | 'timeout' | 'key_refused' | 'model_not_found' | 'not_ai_server'
  | 'insufficient_balance' | 'provider_error' | 'bad_answer' | 'cancelled'
  // Added by the ai-engine lane (additive):
  | 'needs_claim' | 'offline' | 'bad_request' | 'not_ready';

/** Every provider failure, in plain words. `topUpUrl` is set only for insufficient_balance (and needs_claim). */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly topUpUrl: string | null;
  /** The HTTP status of the provider answer behind this error, when there was one (additive). */
  httpStatus: number | null = null;
  constructor(code: AiErrorCode, message: string, topUpUrl: string | null = null) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.topUpUrl = topUpUrl;
  }
}

export function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}

/** Wraps anything thrown into an AiError without leaking its text (unknown errors get a generic plain sentence). */
export function asAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  return new AiError('provider_error', 'The AI request failed for an unknown reason. Nothing was changed. Try again.');
}

const API_CODE: Record<AiErrorCode, ErrorCode> = {
  no_provider: 'needs_provider',
  unreachable: 'provider_error',
  timeout: 'provider_timeout',
  key_refused: 'provider_error',
  model_not_found: 'provider_error',
  not_ai_server: 'provider_error',
  insufficient_balance: 'insufficient_balance',
  provider_error: 'provider_error',
  bad_answer: 'provider_error',
  cancelled: 'provider_error',
  needs_claim: 'insufficient_balance',
  offline: 'offline',
  bad_request: 'bad_request',
  not_ready: 'not_ready',
};

/** The local API error body for an AI failure (docs/INTERFACES.md section 6.2). At most one link. */
export function toApiError(e: unknown): { status: number; body: ApiError } {
  const err = asAiError(e);
  const code = API_CODE[err.code] ?? 'internal';
  const body: ApiError = { error: { code, message: err.message, details: { aiCode: err.code } } };
  if (err.topUpUrl && (err.code === 'insufficient_balance' || err.code === 'needs_claim')) {
    body.error.link = { label: err.code === 'needs_claim' ? 'Link this computer' : 'Add money', url: err.topUpUrl };
  }
  return { status: ERROR_STATUS[code] ?? 500, body };
}
