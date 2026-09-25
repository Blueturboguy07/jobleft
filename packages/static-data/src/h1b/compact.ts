// A compact in-memory form of the H-1B filer rows: numbers in typed arrays, repeated strings pooled. The parsed JSON
// rows are dropped after this is built, so the index holds tens of MB instead of about 100 MB (system perf O5).

import type { EntityRow } from './build.ts';

export class EntityStore {
  readonly n: number;
  readonly files: number;
  readonly quarters: number;
  readonly #names: string[];
  readonly #fein: Uint32Array;
  readonly #city: Uint32Array;
  readonly #state: Uint32Array;
  readonly #pool: string[];
  readonly #naics: Uint32Array;
  readonly #certified: Uint32Array;
  readonly #perFile: Uint32Array;
  readonly #perQuarter: Uint32Array;
  readonly #newHire: Uint32Array;
  readonly #clientSite: Uint32Array;
  readonly #socStart: Uint32Array;
  #socMajor: Uint8Array = new Uint8Array(0);
  #socCount: Uint32Array = new Uint32Array(0);

  readonly #socMajorList: number[] = [];
  readonly #socCountList: number[] = [];
  readonly #poolIdx = new Map<string, number>([['', 0]]);

  /** Rows are added one at a time with add(); call finish() after the last one. */
  constructor(n: number, files: number, quarters: number) {
    this.n = n;
    this.files = files;
    this.quarters = quarters;
    this.#names = new Array<string>(n);
    this.#fein = new Uint32Array(n);
    this.#city = new Uint32Array(n);
    this.#state = new Uint32Array(n);
    this.#naics = new Uint32Array(n);
    this.#certified = new Uint32Array(n);
    this.#perFile = new Uint32Array(n * files);
    this.#perQuarter = new Uint32Array(n * quarters);
    this.#newHire = new Uint32Array(n);
    this.#clientSite = new Uint32Array(n);
    this.#socStart = new Uint32Array(n + 1);
    this.#pool = [''];
  }

  #intern(s: string | null): number {
    if (!s) return 0;
    let i = this.#poolIdx.get(s);
    if (i === undefined) { i = this.#pool.length; this.#pool.push(s); this.#poolIdx.set(s, i); }
    return i;
  }

  add(i: number, r: EntityRow): void {
    if (i < 0 || i >= this.n) throw new Error(`entity row ${i} is outside the table`);
    this.#names[i] = r[0];
    const digits = r[1] ? Number(r[1].replace(/\D/g, '')) : 0;
    this.#fein[i] = Number.isFinite(digits) ? digits : 0;
    this.#city[i] = this.#intern(r[2]);
    this.#state[i] = this.#intern(r[3]);
    this.#naics[i] = r[4] && /^\d{1,9}$/.test(r[4]) ? Number(r[4]) : 0;
    this.#certified[i] = r[5];
    for (let f = 0; f < this.files; f++) this.#perFile[i * this.files + f] = r[6][f] ?? 0;
    for (let q = 0; q < this.quarters; q++) this.#perQuarter[i * this.quarters + q] = r[7][q] ?? 0;
    this.#newHire[i] = r[8];
    this.#clientSite[i] = r[9];
    this.#socStart[i] = this.#socMajorList.length;
    for (const [major, count] of Object.entries(r[11])) { this.#socMajorList.push(Number(major)); this.#socCountList.push(count); }
  }

  finish(): this {
    this.#socStart[this.n] = this.#socMajorList.length;
    this.#socMajor = Uint8Array.from(this.#socMajorList);
    this.#socCount = Uint32Array.from(this.#socCountList);
    this.#socMajorList.length = 0;
    this.#socCountList.length = 0;
    this.#poolIdx.clear();
    return this;
  }

  name(i: number): string { return this.#names[i]!; }
  fein(i: number): string | null {
    const d = this.#fein[i]!;
    if (!d) return null;
    const s = String(d).padStart(9, '0');
    return `${s.slice(0, 2)}-${s.slice(2)}`;
  }
  city(i: number): string | null { return this.#pool[this.#city[i]!] || null; }
  state(i: number): string | null { return this.#pool[this.#state[i]!] || null; }
  naics(i: number): string | null { const v = this.#naics[i]!; return v ? String(v) : null; }
  certified(i: number): number { return this.#certified[i]!; }
  perFile(i: number, f: number): number { return this.#perFile[i * this.files + f]!; }
  perQuarter(i: number, q: number): number { return this.#perQuarter[i * this.quarters + q]!; }
  newHire(i: number): number { return this.#newHire[i]!; }
  clientSite(i: number): number { return this.#clientSite[i]!; }
  soc(i: number): Array<[major: string, count: number]> {
    const out: Array<[string, number]> = [];
    for (let k = this.#socStart[i]!; k < this.#socStart[i + 1]!; k++) out.push([String(this.#socMajor[k]).padStart(2, '0'), this.#socCount[k]!]);
    return out;
  }
}
