// Structural signatures of feed answers: the set of "path:type" pairs (array items merged under "[]").
// The lane keeps the signature of each real answer (recorded once, no data kept) next to its made-up fixture, and the
// tests check that every path of a fixture exists in the real answer with the same type (sources-other O15: the
// fixtures must not drift from the real shape of the source).

export function shapeOf(v: unknown, path = '$', out: Set<string> = new Set()): Set<string> {
  const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  out.add(`${path}:${type}`);
  if (Array.isArray(v)) for (const item of v) shapeOf(item, `${path}[]`, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) shapeOf(x, `${path}.${k}`, out);
  return out;
}

/** Paths of `fixture` that the real signature does not have (empty = the fixture fits the real shape). */
export function shapeDrift(fixture: unknown, real: Iterable<string>): string[] {
  const known = new Set(real);
  return [...shapeOf(fixture)].filter((p) => !known.has(p)).sort();
}

/** The header rows of the job tables in a markdown list (its structural signature). */
export function markdownHeaders(text: string): string[] {
  const out = new Set<string>();
  let inTable = false;
  let wantHeader = false;
  for (const line of text.split(/\r?\n/)) {
    if (/<!--\s*TABLE[A-Z_]*_START\s*-->/.test(line)) { inTable = true; wantHeader = true; continue; }
    if (/<!--\s*TABLE[A-Z_]*_END\s*-->/.test(line)) { inTable = false; continue; }
    if (inTable && wantHeader && line.trim().startsWith('|')) { out.add(line.trim().replace(/\s+/g, ' ')); wantHeader = false; }
  }
  return [...out].sort();
}
