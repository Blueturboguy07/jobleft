// What "Undo fill" puts back (JL-extension-7). A page can hold several fills ("Fill again" re-writes the values
// jobleft wrote before), so undoing only the last fill would put back jobleft's own first values. Undo takes every
// fill on the page instead: each control once, with the value it had before jobleft's FIRST write, and jobleft's
// LATEST write (compared before undoing, so a change the person made since is kept). Pure: no DOM here.

export function mergeUndo<W extends { prev: unknown; after: string }>(fills: readonly W[][], keyOf: (w: W) => unknown): W[] {
  const byKey = new Map<unknown, W>();
  for (const fill of fills) {
    for (const w of fill) {
      const k = keyOf(w);
      const first = byKey.get(k);
      byKey.set(k, first ? { ...w, prev: first.prev } : w);
    }
  }
  return [...byKey.values()];
}
