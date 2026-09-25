// A small JSON Schema validator for the keyword subset in schema.ts. No dependency.
// It is strict about what it knows and ignores keywords it does not know.

import type { Infer, JsonSchema } from './schema.ts';

export interface ValidationIssue {
  /** JSON Pointer to the bad value, "" for the root. */
  path: string;
  message: string;
}

export type ValidationResult<V> = { ok: true; value: V } | { ok: false; issues: ValidationIssue[] };

export class ContractError extends Error {
  readonly issues: ValidationIssue[];
  constructor(label: string, issues: ValidationIssue[]) {
    const first = issues.slice(0, 3).map((i) => `${i.path || '/'}: ${i.message}`).join('; ');
    super(`${label} does not match its contract: ${first}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ''}`);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkFormat(format: string, v: string): string | null {
  switch (format) {
    case 'date-time':
      return DATE_TIME.test(v) && Number.isFinite(Date.parse(v)) ? null : 'must be an RFC 3339 date-time';
    case 'date': {
      if (!DATE.test(v)) return 'must be a date (YYYY-MM-DD)';
      const t = Date.parse(v + 'T00:00:00Z');
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? null : 'must be a real calendar date';
    }
    case 'uri': {
      try { new URL(v); return null; } catch { return 'must be an absolute URL'; }
    }
    case 'email':
      return EMAIL.test(v) ? null : 'must be an email address';
    default:
      return null;
  }
}

function esc(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function check(s: JsonSchema, v: unknown, path: string, out: ValidationIssue[], max: number): void {
  if (out.length >= max) return;
  if (s.anyOf) {
    for (const branch of s.anyOf) {
      const trial: ValidationIssue[] = [];
      check(branch, v, path, trial, 1);
      if (trial.length === 0) return;
    }
    out.push({ path, message: `matches none of the ${s.anyOf.length} allowed shapes` });
    return;
  }
  if (s.const !== undefined && v !== s.const) {
    out.push({ path, message: `must be ${JSON.stringify(s.const)}` });
    return;
  }
  if (s.enum && !s.enum.includes(v as never)) {
    out.push({ path, message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}` });
    return;
  }
  if (s.type) {
    const t = typeOf(v);
    let ok: boolean;
    switch (s.type) {
      case 'integer': ok = t === 'number' && Number.isInteger(v); break;
      case 'number': ok = t === 'number' && Number.isFinite(v as number); break;
      default: ok = t === s.type;
    }
    if (!ok) { out.push({ path, message: `must be ${s.type === 'integer' ? 'an integer' : `of type ${s.type}`}` }); return; }
  }
  if (typeof v === 'string') {
    const len = [...v].length;
    if (s.minLength !== undefined && len < s.minLength) out.push({ path, message: `must have at least ${s.minLength} characters` });
    if (s.maxLength !== undefined && len > s.maxLength) out.push({ path, message: `must have at most ${s.maxLength} characters` });
    if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) out.push({ path, message: `must match ${s.pattern}` });
    if (s.format !== undefined) { const m = checkFormat(s.format, v); if (m) out.push({ path, message: m }); }
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push({ path, message: `must be >= ${s.minimum}` });
    if (s.maximum !== undefined && v > s.maximum) out.push({ path, message: `must be <= ${s.maximum}` });
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push({ path, message: `must have at least ${s.minItems} items` });
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push({ path, message: `must have at most ${s.maxItems} items` });
    if (s.uniqueItems) {
      const seen = new Set<string>();
      for (const item of v) {
        const k = JSON.stringify(item);
        if (seen.has(k)) { out.push({ path, message: 'must not repeat an item' }); break; }
        seen.add(k);
      }
    }
    if (s.items) for (let i = 0; i < v.length && out.length < max; i++) check(s.items, v[i], `${path}/${i}`, out, max);
  }
  if (typeOf(v) === 'object') {
    const o = v as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(o, key) || o[key] === undefined) out.push({ path: `${path}/${esc(key)}`, message: 'is required' });
    }
    const props = s.properties ?? {};
    for (const [key, value] of Object.entries(o)) {
      if (out.length >= max) return;
      if (value === undefined) continue;
      const ps = props[key];
      if (ps) { check(ps, value, `${path}/${esc(key)}`, out, max); continue; }
      if (s.additionalProperties === false) out.push({ path: `${path}/${esc(key)}`, message: 'is not allowed' });
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, value, `${path}/${esc(key)}`, out, max);
    }
  }
}

/** Validates a value against a schema. Stops after `maxIssues` problems (default 20). */
export function validate<S extends JsonSchema>(schema: S, value: unknown, maxIssues = 20): ValidationResult<Infer<S>> {
  const issues: ValidationIssue[] = [];
  check(schema, value, '', issues, maxIssues);
  return issues.length === 0 ? { ok: true, value: value as Infer<S> } : { ok: false, issues };
}

/** True when the value matches the schema. */
export function isValid<S extends JsonSchema>(schema: S, value: unknown): value is Infer<S> {
  return validate(schema, value, 1).ok;
}

/** Returns the value typed by its schema, or throws a ContractError that names the first problems. */
export function parse<S extends JsonSchema>(schema: S, value: unknown, label = schema.title ?? 'value'): Infer<S> {
  const r = validate(schema, value);
  if (!r.ok) throw new ContractError(label, r.issues);
  return r.value;
}
