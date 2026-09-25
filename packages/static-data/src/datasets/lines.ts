// The shipped dataset file format: gzip of JSON lines. The first line is a header object; each next line is one row.
// A loader reads the rows one at a time from the uncompressed bytes, so it never builds one large string or object
// graph (lower peak memory than one big JSON document).

import { gunzipSync, gzipSync } from 'node:zlib';

export function encodeLines(header: unknown, rows: Iterable<unknown>): Buffer {
  const parts: string[] = [JSON.stringify(header)];
  for (const r of rows) parts.push(JSON.stringify(r));
  return gzipSync(Buffer.from(parts.join('\n') + '\n'), { level: 9 });
}

/** The uncompressed lines of a dataset file, as strings, one at a time. */
export function* lines(gz: Buffer): Generator<string> {
  const buf = gunzipSync(gz);
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    if (end > start) yield buf.toString('utf8', start, end);
    start = end + 1;
  }
}

/** Only the header line (cheap check of a release file). */
export function headerOf<T>(gz: Buffer): T {
  for (const l of lines(gz)) return JSON.parse(l) as T;
  throw new Error('the dataset file is empty');
}
