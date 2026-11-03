// A seeded random number generator for the crash tests: the same seed gives
// the same numbers, so a run that failed can be run again with its seed.

/** Numbers in [0, 1) from `seed` (mulberry32: small, fast, and good enough for tests). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A seed: `ABORT_SEED` if set, or else a random one. */
export function seedFromEnv(): number {
  const set = process.env.ABORT_SEED;
  return set ? Number(set) >>> 0 : Math.floor(Math.random() * 2 ** 32);
}
