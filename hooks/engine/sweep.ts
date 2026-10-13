// The sweeps across the spectrum: up it as a prompt is sent, down it as a
// turn is interrupted, and down it again and again while the context
// compacts, a tape rewinding.

import { bump } from './math'

/** How fast a sweep runs, in spectra a second, and a rewind's. */
const SWEEP = 1.5
const REWIND = 2.4

/** The sweep across a spectrum, one at a time, and the compactions that rewind it. */
export class Sweep {
  /** Where the sweep is, 0 (lowest) to 1 (highest), running a little past either end; none between sweeps. */
  private place: number | undefined
  /** Which way it runs, and how fast. */
  private direction = 1
  private speed = SWEEP
  /** Compactions running: the tape rewinds until they finish. */
  private rewinding = 0

  /** A sweep up the spectrum. */
  up() {
    this.place = 0
    this.direction = 1
    this.speed = SWEEP
  }

  /** A sweep down. */
  down() {
    this.place = 1
    this.direction = -1
    this.speed = SWEEP
  }

  /** A compaction starts: the tape rewinds until `endRewind`. */
  beginRewind() {
    this.rewinding += 1
  }

  endRewind() {
    this.rewinding = Math.max(0, this.rewinding - 1)
  }

  /** While compacting. */
  isRewinding(): boolean {
    return this.rewinding > 0
  }

  /** Moves it on by `ms`: the sweep runs on, off the end of the spectrum, and while compacting, another starts at the top. */
  step(ms: number) {
    if (this.place !== undefined) {
      this.place += (this.speed * this.direction * ms) / 1000
      if (this.place > 1.15 || this.place < -0.15) this.place = undefined
    }
    // Compacting: the tape rewinds, sweep after sweep down the spectrum.
    if (this.rewinding > 0 && this.place === undefined) {
      this.place = 1.15
      this.direction = -1
      this.speed = REWIND
    }
  }

  /** Its energy at a point of the spectrum. */
  at(x: number): number {
    return this.place === undefined ? 0 : 0.9 * bump(x - this.place, 0.045)
  }

  /** No sweep running, and none to come. */
  isCalm(): boolean {
    return this.place === undefined && this.rewinding === 0
  }
}
