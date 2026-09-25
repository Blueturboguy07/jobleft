// Structured answers (ai-engine O12, O13). The model is asked for JSON that fits a contract schema. The answer is
// read leniently (code fences, text around the object, trailing commas), then checked against the schema. When it
// is not JSON, the caller's line-based fallback may read it. When neither works, the answer is refused with
// AiError('bad_answer'): nothing is invented, no default is filled in, and a cut-off answer is never accepted.

import type { Infer, JsonSchema } from '@jobleft/contracts';
import { validate } from '@jobleft/contracts';
import { AiError } from './errors.ts';
import { stripThinking } from './thinking.ts';
import type { AiMessage } from './types.ts';

const RETRY_HINT = 'Try again, or choose a larger model.';

/** The instruction added to the system message of a structured request. */
export function jsonInstruction(schema: JsonSchema): string {
  return [
    'Answer with ONE JSON value only: no prose before or after it, no code fences, no comments.',
    'It must match this JSON Schema exactly (use null where the schema allows it and the input does not say):',
    JSON.stringify(stripMeta(schema)),
    'Never invent facts, numbers, dates, names or links that are not in the input.',
  ].join('\n');
}

/** Removes keys that only document a schema, to keep prompts short. */
function stripMeta(s: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === '$schema' || k === '$id' || k === 'examples' || k === 'title') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, JsonSchema>).map(([pk, pv]) => [pk, stripMeta(pv)]));
    } else if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') {
      out[k] = stripMeta(v as JsonSchema);
    } else if (k === 'anyOf' && Array.isArray(v)) {
      out[k] = v.map((b) => stripMeta(b as JsonSchema));
    } else out[k] = v;
  }
  return out as JsonSchema;
}

/** Adds the JSON instruction to the request messages (as, or in front of, the system message). */
export function withJsonInstruction(messages: AiMessage[], schema: JsonSchema): AiMessage[] {
  const instruction = jsonInstruction(schema);
  const first = messages[0];
  if (first && first.role === 'system') {
    return [{ role: 'system', content: `${first.content}\n\n${instruction}` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: instruction }, ...messages];
}

/** Finds the first complete JSON object or array in a text. null when there is none. */
export function extractJson(text: string): unknown | undefined {
  let t = stripThinking(text).trim();
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1]!.trim();
  const direct = tryParse(t);
  if (direct !== undefined) return direct;
  for (let start = 0; start < t.length; start++) {
    const c = t[start];
    if (c !== '{' && c !== '[') continue;
    const end = matchingEnd(t, start);
    if (end < 0) continue;
    const parsed = tryParse(t.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { /* try a repair */ }
  const repaired = s.replace(/,\s*([}\]])/g, '$1');
  if (repaired !== s) { try { return JSON.parse(repaired); } catch { /* no */ } }
  return undefined;
}

/** Index of the bracket that closes the one at `start`, respecting strings. -1 when it never closes. */
function matchingEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Reads a structured answer. Order: JSON that fits the schema; then the line fallback; else bad_answer.
 * `incomplete` answers are always refused (a cut-off list is never shown as complete).
 */
export function readStructured<S extends JsonSchema>(
  text: string,
  schema: S,
  opts: { incomplete: boolean; lineFallback?: (text: string) => Infer<S> | null },
): Infer<S> {
  if (opts.incomplete) {
    throw new AiError('bad_answer', `The AI answer was cut off before it ended, so jobleft cannot use it. ${RETRY_HINT}`);
  }
  const clean = stripThinking(text);
  if (!clean.trim()) {
    throw new AiError('bad_answer', `The AI sent an empty answer, so jobleft cannot use it. ${RETRY_HINT}`);
  }
  const parsed = extractJson(clean);
  let jsonProblem: string;
  if (parsed === undefined) {
    jsonProblem = 'The AI answer was not in the expected form';
  } else {
    const r = validate(schema, parsed);
    if (r.ok) return r.value;
    const first = r.issues[0]!;
    jsonProblem = /must be (<|>)=/.test(first.message)
      ? `The AI answer has a value out of range (${first.path || 'the answer'} ${first.message})`
      : `The AI answer does not have the expected fields (${first.path || 'the answer'} ${first.message})`;
  }
  if (opts.lineFallback) {
    let fromLines: Infer<S> | null = null;
    try { fromLines = opts.lineFallback(clean); } catch { fromLines = null; }
    if (fromLines !== null && fromLines !== undefined) {
      const r = validate(schema, fromLines);
      if (r.ok) return r.value;
      jsonProblem = 'The AI answer was not in the expected form, and its plain-text form has a value that is out of range or missing';
    }
  }
  throw new AiError('bad_answer', `${jsonProblem}, so jobleft cannot use it. ${RETRY_HINT}`);
}

/**
 * The line-based fallback for small models (the jobsync "SCORES:" header idea). Reads a line such as
 * "SCORES: experience=80, skills=70%, industry: 60" into { experience: 80, skills: 70, industry: 60 }.
 * Values are the numbers the model wrote, unchanged (range checks belong to the schema). null when absent.
 */
export function parseScoresHeader(text: string): Record<string, number> | null {
  const lines = stripThinking(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/^[\s*#>_`-]+/, '').replace(/[*_`]+/g, '');
    const m = /^scores?\s*[:=-]\s*(.+)$/i.exec(line.trim());
    if (!m) continue;
    const out: Record<string, number> = {};
    for (const part of m[1]!.split(/[,;|]/)) {
      const kv = /^\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*%?\s*(?:\/\s*100)?\s*$/.exec(part);
      if (!kv) continue;
      const key = kv[1]!.trim().toLowerCase().replace(/[\s-]+/g, '_');
      const value = Number(kv[2]);
      if (Number.isFinite(value)) out[key] = value;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return null;
}

/**
 * A generic line reader for flat schemas: "field: value" lines, and "- item" bullets under a "field:" line for
 * arrays of strings. Fields the text does not name are left out (never filled). Returns null when no field was found.
 */
export function readFieldLines(text: string, schema: JsonSchema): Record<string, unknown> | null {
  const props = schema.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) return null;
  const byLower = new Map(names.map((n) => [n.toLowerCase().replace(/[\s_-]+/g, ''), n]));
  const out: Record<string, unknown> = {};
  let currentArray: string | null = null;
  for (const raw of stripThinking(text).split(/\r?\n/)) {
    const line = raw.replace(/[*_`]+/g, '').trim();
    if (!line) continue;
    const bullet = /^[-•]\s+(.+)$/.exec(line);
    if (bullet && currentArray) {
      (out[currentArray] as string[]).push(bullet[1]!.trim());
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9 _-]{0,40})\s*:\s*(.*)$/.exec(line);
    if (!m) { currentArray = null; continue; }
    const name = byLower.get(m[1]!.toLowerCase().replace(/[\s_-]+/g, ''));
    if (!name) { currentArray = null; continue; }
    const ps = props[name]!;
    const value = m[2]!.trim();
    const type = ps.type ?? ps.anyOf?.find((b) => b.type && b.type !== 'null')?.type;
    currentArray = null;
    if (type === 'array') {
      out[name] = value ? value.split(/\s*[,;]\s*/).filter(Boolean) : [];
      if (!value) currentArray = name;
    } else if (type === 'integer' || type === 'number') {
      const n = /^-?\d+(?:\.\d+)?/.exec(value.replace(/,/g, ''));
      if (n) out[name] = type === 'integer' ? Math.round(Number(n[0])) : Number(n[0]);
    } else if (type === 'boolean') {
      if (/^(yes|true)\b/i.test(value)) out[name] = true;
      else if (/^(no|false)\b/i.test(value)) out[name] = false;
    } else if (value && !/^(n\/?a|none|unknown|null)$/i.test(value)) {
      out[name] = value;
    } else if (ps.anyOf?.some((b) => b.type === 'null')) {
      out[name] = null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
