// float16 <-> float32 for stored vectors (spike S2: float16 on disk halves float32 with recall 0.998 at 10).

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE 754 half precision bits of a number, round to nearest even. */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf or nan
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow to inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow to zero
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return sign | half;
}

let TABLE: Float32Array | null = null;

function table(): Float32Array {
  if (TABLE) return TABLE;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    let v: number;
    if (exp === 0) v = mant * 2 ** -24;
    else if (exp === 0x1f) v = mant ? NaN : Infinity;
    else v = (1 + mant / 1024) * 2 ** (exp - 15);
    t[h] = sign * v;
  }
  TABLE = t;
  return t;
}

/** Packs a float32 vector as little-endian float16 bytes. */
export function packHalf(vec: Float32Array): Uint8Array {
  const out = new Uint8Array(vec.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < vec.length; i++) view.setUint16(i * 2, toHalf(vec[i]!), true);
  return out;
}

/** Expands little-endian float16 bytes into `dst` at `offset`. Returns false when the byte length is wrong. */
export function unpackHalfInto(bytes: Uint8Array, dst: Float32Array, offset: number, dims: number): boolean {
  if (bytes.byteLength !== dims * 2) return false;
  const t = table();
  for (let i = 0; i < dims; i++) dst[offset + i] = t[bytes[i * 2]! | (bytes[i * 2 + 1]! << 8)]!;
  return true;
}

/** Expands float16 bytes to a new float32 vector. */
export function unpackHalf(bytes: Uint8Array): Float32Array {
  const dims = bytes.byteLength >>> 1;
  const out = new Float32Array(dims);
  unpackHalfInto(bytes, out, 0, dims);
  return out;
}
