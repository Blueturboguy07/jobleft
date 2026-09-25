// Value types the parsers produce. Erasable TypeScript only (no enums), so Node 24 runs this file directly.

/** Fine-grained seniority read from a title or a description. `null` elsewhere means "unknown". */
export type Level =
  | 'intern' | 'entry' | 'mid' | 'senior' | 'staff' | 'principal' | 'lead'
  | 'manager' | 'director' | 'vp' | 'exec';

/** The period a pay figure is stated in. */
export type PayPeriod = 'hour' | 'day' | 'week' | 'month' | 'year';
