// Turns a failed HTTP answer of an AI server into the real problem, in plain words (ai-engine O3).
// Upstream text is read to decide the problem, but it is never copied into the message: servers often echo the key.

import { AiError } from './errors.ts';
import { looksLikeHtml, tryJson } from './transport.ts';

export interface ClassifyContext {
  /** "the AI server at http://127.0.0.1:1234", "OpenAI", "publik" ... */
  label: string;
  model: string | null;
  keySet: boolean;
  /** Where the person fixes a refused key. */
  keyHint?: string;
}

function upstreamText(body: unknown, raw: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      return [e.type, e.code, e.message].filter((x) => typeof x === 'string').join(' ');
    }
    if (typeof b.message === 'string') return b.message;
    if (typeof b.detail === 'string') return b.detail;
  }
  return raw.slice(0, 500);
}

const MODEL_MISSING = /(model[^.]{0,80}(not[ _]found|does not exist|doesn't exist|not exist|unknown|not available|no such|is not loaded|not loaded|invalid model)|unknown[_ ]model|model_not_found|no such model|try pulling it)/i;
const QUOTA = /(insufficient[_ ]quota|exceeded your current quota|billing|credit balance|insufficient[_ ]funds|payment required)/i;
const BAD_KEY_400 = /(API_KEY_INVALID|API key not valid|API key expired|invalid[_ ]api[_ ]key)/i;
const KEY_WORDS = /(api[_ -]?key|unauthori[sz]ed|authentication|invalid[_ ]key|incorrect key|forbidden|permission)/i;

/** The model name as the person chose it, cut to a safe length for a message. */
function modelName(model: string | null): string {
  return model ? `"${model.slice(0, 80)}"` : 'the chosen model';
}

export function classifyHttpFailure(status: number, contentType: string | undefined, raw: string, ctx: ClassifyContext): AiError {
  const err = classify(status, contentType, raw, ctx);
  err.httpStatus = status;
  return err;
}

function classify(status: number, contentType: string | undefined, raw: string, ctx: ClassifyContext): AiError {
  if (looksLikeHtml(contentType, raw) && status === 404) {
    return new AiError('not_ai_server', `${cap(ctx.label)} has no AI endpoint at this address (it answered with a "not found" web page). Check the address (many servers need "/v1" at the end).`);
  }
  if (looksLikeHtml(contentType, raw)) {
    return new AiError('not_ai_server', `${cap(ctx.label)} answered with a web page, not an AI answer. This address is not an AI server; check the address (many servers need "/v1" at the end).`);
  }
  const body = tryJson(raw);
  const text = upstreamText(body, raw);
  if (status === 401 || (status === 403 && KEY_WORDS.test(text))) {
    return ctx.keySet
      ? new AiError('key_refused', `${cap(ctx.label)} refused the saved key. Check the key and save it again${ctx.keyHint ? ` (${ctx.keyHint})` : ''}.`)
      : new AiError('key_refused', `${cap(ctx.label)} needs a key. Save the key for this provider, then try again.`);
  }
  // Google answers a wrong key with 400 API_KEY_INVALID ("API key not valid"), not 401 (JL-settings-11).
  if (status === 400 && BAD_KEY_400.test(text)) {
    return ctx.keySet
      ? new AiError('key_refused', `${cap(ctx.label)} refused the saved key. Check the key and save it again${ctx.keyHint ? ` (${ctx.keyHint})` : ''}.`)
      : new AiError('key_refused', `${cap(ctx.label)} needs a key. Save the key for this provider, then try again.`);
  }
  if (status === 404 && MODEL_MISSING.test(text)) {
    return new AiError('model_not_found', `The model ${modelName(ctx.model)} does not exist on ${ctx.label}. Choose one of the models it lists.`);
  }
  if ((status === 400 || status === 422) && MODEL_MISSING.test(text)) {
    return new AiError('model_not_found', `The model ${modelName(ctx.model)} does not exist on ${ctx.label}. Choose one of the models it lists.`);
  }
  if (status === 404) {
    return new AiError('not_ai_server', `${cap(ctx.label)} has no AI chat endpoint at this address. Check the address (many servers need "/v1" at the end).`);
  }
  if (status === 402 || (status === 429 && QUOTA.test(text))) {
    return new AiError('provider_error', `${cap(ctx.label)} says the account behind this key has no money or quota left. Add money with that provider, or choose another provider.`);
  }
  if (status === 429) {
    return new AiError('provider_error', `${cap(ctx.label)} is limiting requests right now. Wait a minute, then try again.`);
  }
  if (status === 403) {
    return new AiError('key_refused', `${cap(ctx.label)} refused this request (access denied). Check the key and the account permissions.`);
  }
  if (status === 413) {
    return new AiError('provider_error', `The request is too large for ${ctx.label}. Try a shorter text.`);
  }
  if (status === 400 && /context|too long|maximum.*tokens|token limit|num_ctx/i.test(text)) {
    return new AiError('provider_error', `The text is too long for the model ${modelName(ctx.model)}. Try a shorter text or a model with a larger context.`);
  }
  if (status >= 500) {
    return new AiError('provider_error', `${cap(ctx.label)} had an internal error (HTTP ${status}). Nothing was changed. Try again later.`);
  }
  if (body === undefined && raw.trim()) {
    return new AiError('not_ai_server', `${cap(ctx.label)} answered in a form that is not an AI answer (HTTP ${status}). Check the address.`);
  }
  return new AiError('provider_error', `${cap(ctx.label)} refused the request (HTTP ${status}).`);
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
