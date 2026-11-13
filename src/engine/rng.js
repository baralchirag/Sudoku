// Small, fast, seedable PRNG (sfc32) so that the same seed yields the same
// puzzle on every isolate, every runtime, forever. Math.random is never used
// for anything a player could need to reproduce.

/** sfc32 generator returning floats in [0, 1). */
export function sfc32(a, b, c, d) {
  return function next() {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** xmur3 string hash, producing a stream of 32-bit seeds. */
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function seed() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** PRNG seeded from an arbitrary string. */
export function rngFromString(str) {
  const s = xmur3(str);
  const rng = sfc32(s(), s(), s(), s());
  for (let i = 0; i < 12; i++) rng(); // warm up
  return rng;
}

/** PRNG seeded from at least 16 bytes (e.g. an HMAC digest). */
export function rngFromBytes(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rng = sfc32(v.getUint32(0), v.getUint32(4), v.getUint32(8), v.getUint32(12));
  for (let i = 0; i < 12; i++) rng();
  return rng;
}

export const randInt = (rng, n) => Math.floor(rng() * n);

/** In-place Fisher-Yates shuffle. */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
