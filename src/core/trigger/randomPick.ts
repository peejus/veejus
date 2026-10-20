/**
 * Pick a random candidate, never the same as `last` when there is any alternative.
 * `rand` returns [0, 1).
 */
export function pickRandom(
  candidates: readonly string[],
  last: string | null,
  rand: () => number = Math.random,
): string | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!
  const pool =
    last !== null && candidates.includes(last) ? candidates.filter((c) => c !== last) : candidates
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!
}
