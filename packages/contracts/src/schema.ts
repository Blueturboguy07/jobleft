// A tiny JSON Schema builder with type inference. One definition gives three things:
//   1. a plain JSON Schema object (draft 2020-12 subset) that can be written to a .json file,
//   2. the TypeScript type, through `Infer<typeof X>`,
//   3. runtime validation, through `validate(X, value)` in validate.ts.
// No dependency. Erasable TypeScript only, so Node 24 runs it directly.

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';
export type JsonPrimitive = string | number | boolean | null;

/** The JSON Schema keywords this project uses. Anything else is not validated. */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: JsonType;
  enum?: readonly JsonPrimitive[];
  const?: JsonPrimitive;
  anyOf?: readonly JsonSchema[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  examples?: readonly unknown[];
}

declare const TYPE: unique symbol;

/** A JSON Schema that also carries (at type level only) the TypeScript type it describes. */
export type Schema<V> = JsonSchema & { readonly [TYPE]?: V };

/** The TypeScript type a schema describes. */
export type Infer<S> = S extends { readonly [TYPE]?: infer V } ? V : unknown;

type Props = Readonly<Record<string, Schema<unknown>>>;
type Simplify<X> = { [K in keyof X]: X[K] } & {};
type ObjectType<R extends Props, O extends Props> = Simplify<
  { -readonly [K in keyof R]: Infer<R[K]> } & { -readonly [K in keyof O]?: Infer<O[K]> }
>;

export interface Meta {
  title?: string;
  description?: string;
  examples?: readonly unknown[];
}

export interface StringOptions extends Meta {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** date-time (RFC 3339), date (YYYY-MM-DD), uri, email. Validated by validate.ts. */
  format?: 'date-time' | 'date' | 'uri' | 'email';
}

export interface NumberOptions extends Meta {
  minimum?: number;
  maximum?: number;
}

export interface ArrayOptions extends Meta {
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function str(o: StringOptions = {}): Schema<string> {
  return clean({ type: 'string' as const, ...o });
}

export function num(o: NumberOptions = {}): Schema<number> {
  return clean({ type: 'number' as const, ...o });
}

export function int(o: NumberOptions = {}): Schema<number> {
  return clean({ type: 'integer' as const, ...o });
}

export function bool(o: Meta = {}): Schema<boolean> {
  return clean({ type: 'boolean' as const, ...o });
}

/** A string that must be one of the given values. */
export function enm<const V extends readonly string[]>(values: V, o: Meta = {}): Schema<V[number]> {
  return clean({ type: 'string' as const, enum: values, ...o });
}

/** Exactly this value. */
export function lit<const V extends string | number | boolean>(value: V, o: Meta = {}): Schema<V> {
  return clean({ const: value, ...o });
}

export function arr<V>(items: Schema<V>, o: ArrayOptions = {}): Schema<V[]> {
  return clean({ type: 'array' as const, items, ...o });
}

/**
 * An object. `required` keys must be present; `optional` keys may be missing.
 * Unknown keys are allowed (so a newer writer never breaks an older reader): contracts change by addition only.
 */
export function obj<R extends Props, O extends Props = {}>(required: R, optional?: O, o: Meta = {}): Schema<ObjectType<R, O>> {
  const properties: Record<string, JsonSchema> = { ...required, ...(optional ?? {}) };
  return clean({ type: 'object' as const, properties, required: Object.keys(required), ...o });
}

/** An object with arbitrary string keys and values of one schema. */
export function rec<V>(values: Schema<V>, o: Meta = {}): Schema<Record<string, V>> {
  return clean({ type: 'object' as const, additionalProperties: values, ...o });
}

/** The value, or null. `null` means "unknown" or "not stated" throughout the contracts. */
export function nullable<V>(s: Schema<V>, o: Meta = {}): Schema<V | null> {
  return clean({ anyOf: [s, { type: 'null' as const }], ...o });
}

/** Any one of the schemas. */
export function union<const S extends readonly Schema<unknown>[]>(schemas: S, o: Meta = {}): Schema<Infer<S[number]>> {
  return clean({ anyOf: schemas, ...o });
}

/** Any JSON value. */
export function anyValue(o: Meta = {}): Schema<unknown> {
  return clean({ ...o });
}

/** Adds a title and a description to a schema, keeping its type. */
export function named<S extends JsonSchema>(schema: S, title: string, description?: string): S {
  return clean({ ...schema, title, description });
}
