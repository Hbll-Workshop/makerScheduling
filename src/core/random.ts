/**
 * Small deterministic random source (an LCG), so a randomised search pass is reproducible from its
 * seed: the same seed always explores in the same order.
 */
export type Rng = () => number

export function makeRng(seed: number): Rng {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

