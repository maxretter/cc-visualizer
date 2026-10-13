// The small math the music and its drawings share: fades and eases, waves,
// bumps, chance and noise.
//
// The engine moves by time, not by frames: each step is told how long it has
// been, so the music plays the same at any frame rate, and every duration,
// half-life and period in it is in milliseconds.

/** How often a frame is drawn while something plays (30 fps): a step's length when none is given. */
export const FRAME_MS = 33

/** What is left of something that halves every `halfLife`, after `ms`. */
export const fade = (halfLife: number, ms: number) => Math.pow(0.5, ms / halfLife)

/** A value easing toward `target`, closing half the distance every `halfLife`, after `ms`. */
export const ease = (value: number, target: number, halfLife: number, ms: number) => target + (value - target) * fade(halfLife, ms)

/** A wave's phase in radians, `ms` into cycles `period` long. */
export const cycle = (ms: number, period: number) => (2 * Math.PI * ms) / period

/** A bell curve, 1 at its middle and falling away `sigma` wide, `d` from it. */
export const bump = (d: number, sigma: number) => Math.exp(-(d * d) / (2 * sigma * sigma))

/** A random value, -1 to 1, for a whole point of a plane: the same point, the same value. */
function lattice(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h ^= h >>> 13
  return ((h >>> 0) / 4294967296) * 2 - 1
}

/** Smooth random noise, -1 to 1, at any point of a plane: `lattice` eased between its whole points. */
export function noise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi))
  const v = (y - yi) * (y - yi) * (3 - 2 * (y - yi))
  const a = lattice(xi, yi)
  const b = lattice(xi + 1, yi)
  const c = lattice(xi, yi + 1)
  const d = lattice(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** Chance as a sequence of numbers, 0 to 1, the same for the same `seed`. */
export function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
