// Errors the resume lane throws. Each code maps to a local API error code (docs/INTERFACES.md section 6.2), and each
// message is one plain sentence with no resume text, key or path in it.

export type ResumeErrorCode =
  | 'bad_request' | 'not_found' | 'conflict' | 'needs_profile' | 'needs_provider' | 'provider_error' | 'provider_timeout'
  | 'insufficient_balance' | 'payload_too_large' | 'unsupported_media_type' | 'internal';

export class ResumeError extends Error {
  readonly code: ResumeErrorCode;
  /** Extra facts for the screen (for example the failed import report, or what a delete would remove). */
  readonly details: unknown;
  /** Only for insufficient_balance: the one top-up link. */
  readonly link: string | null;
  constructor(code: ResumeErrorCode, message: string, details: unknown = null, link: string | null = null) {
    super(message);
    this.name = 'ResumeError';
    this.code = code;
    this.details = details;
    this.link = link;
  }
}
