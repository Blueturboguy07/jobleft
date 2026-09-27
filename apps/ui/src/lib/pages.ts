// A paged list read whole (JL-settings-1): the API answers at most 100 items a page, and a screen that shows one
// table of every item (Settings > Job sources: "Boards you follow") follows the cursor to the end, so the count it
// shows equals the rows it can page through.

export interface Page<T> { items: T[]; total: number; nextCursor: string | null }

/** Reads every page by following nextCursor (at most maxPages pages; a cursor that repeats ends the loop). */
export async function readAllPages<T>(page: (cursor: string | undefined) => Promise<Page<T>>, maxPages = 200): Promise<Page<T>> {
  const items: T[] = [];
  let total = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < maxPages; i++) {
    const r = await page(cursor);
    items.push(...r.items);
    total = r.total;
    if (!r.nextCursor || seen.has(r.nextCursor)) break;
    seen.add(r.nextCursor);
    cursor = r.nextCursor;
  }
  return { items, total, nextCursor: null };
}
