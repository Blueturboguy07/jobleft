// A compact in-memory form of the place rows: coordinates, population and rank in typed arrays, country and region
// codes pooled, ids kept as numbers per source. About a third of the memory of the parsed rows (system perf O5).

import type { PlaceRow } from './build.ts';

const SOURCES = ['gnis', 'ne', 'geonames'] as const;

export class PlaceStore {
  readonly n: number;
  readonly #src: Uint8Array;
  readonly #num: Float64Array;
  readonly #names: string[];
  readonly #cc: Uint16Array;
  readonly #region: Uint32Array;
  readonly #pool: string[];
  readonly #lat: Float32Array;
  readonly #lon: Float32Array;
  readonly #pop: Uint32Array;
  readonly #rank: Uint8Array;
  /** Per source: row indexes sorted by numeric id (for id lookups without a string map). */
  #bySrc: Array<{ ids: Float64Array; rows: Uint32Array }> = [];

  readonly #poolIdx = new Map<string, number>([['', 0]]);
  readonly #perSrc: number[][] = SOURCES.map(() => []);

  /** Rows are added one at a time with add(); call finish() after the last one. */
  constructor(n: number) {
    this.n = n;
    this.#src = new Uint8Array(n);
    this.#num = new Float64Array(n);
    this.#names = new Array<string>(n);
    this.#cc = new Uint16Array(n);
    this.#region = new Uint32Array(n);
    this.#lat = new Float32Array(n);
    this.#lon = new Float32Array(n);
    this.#pop = new Uint32Array(n);
    this.#rank = new Uint8Array(n);
    this.#pool = [''];
  }

  #intern(s: string | null): number {
    if (!s) return 0;
    let i = this.#poolIdx.get(s);
    if (i === undefined) { i = this.#pool.length; this.#pool.push(s); this.#poolIdx.set(s, i); }
    return i;
  }

  add(i: number, r: PlaceRow): void {
    if (i < 0 || i >= this.n) throw new Error(`place row ${i} is outside the table`);
    const colon = r[0].indexOf(':');
    const src = SOURCES.indexOf(r[0].slice(0, colon) as (typeof SOURCES)[number]);
    if (src < 0) throw new Error(`unknown place id ${r[0]}`);
    this.#src[i] = src;
    this.#num[i] = Number(r[0].slice(colon + 1));
    this.#perSrc[src]!.push(i);
    this.#names[i] = r[1];
    this.#cc[i] = this.#intern(r[2]);
    this.#region[i] = this.#intern(r[3]);
    this.#lat[i] = r[4];
    this.#lon[i] = r[5];
    this.#pop[i] = r[6] && r[6] > 0 ? Math.min(r[6], 0xffffffff) : 0;
    this.#rank[i] = r[7];
  }

  finish(): this {
    this.#bySrc = this.#perSrc.map((list) => {
      list.sort((a, b) => this.#num[a]! - this.#num[b]!);
      return { ids: Float64Array.from(list, (i) => this.#num[i]!), rows: Uint32Array.from(list) };
    });
    for (const l of this.#perSrc) l.length = 0;
    this.#poolIdx.clear();
    return this;
  }

  id(i: number): string { return `${SOURCES[this.#src[i]!]}:${this.#num[i]}`; }
  name(i: number): string { return this.#names[i]!; }
  cc(i: number): string { return this.#pool[this.#cc[i]!]!; }
  region(i: number): string | null { return this.#pool[this.#region[i]!] || null; }
  lat(i: number): number { return Math.round(this.#lat[i]! * 1e5) / 1e5; }
  lon(i: number): number { return Math.round(this.#lon[i]! * 1e5) / 1e5; }
  pop(i: number): number | null { return this.#pop[i]! || null; }
  rank(i: number): number { return this.#rank[i]!; }

  /** Row index of a place id ("gnis:277593"), or undefined. */
  indexOf(placeId: string): number | undefined {
    const colon = placeId.indexOf(':');
    const src = SOURCES.indexOf(placeId.slice(0, colon) as (typeof SOURCES)[number]);
    if (src < 0) return undefined;
    const want = Number(placeId.slice(colon + 1));
    if (!Number.isFinite(want)) return undefined;
    const { ids, rows } = this.#bySrc[src]!;
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = ids[mid]!;
      if (v === want) return rows[mid];
      if (v < want) lo = mid + 1; else hi = mid - 1;
    }
    return undefined;
  }
}
