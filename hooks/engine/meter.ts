// The context meter: how near auto-compact the context is, as the bars draw it
// beside them, rising quickly and draining slowly, a glint running up it now
// and then.

import { ease } from './math'

/** Between the meter's glints, and how long one takes to run up it. */
const GLINT_EVERY = 10_000
const GLINT_RUN = 800
/** How fast the meter as drawn rises to where it is heading (half the way every 140 ms), and drains. */
const RISE = 140
const DRAIN = 560

/** The context as last measured, and the meter that shows it. */
export class Meter {
  /** The context's share of the window, 0 to 100, as its label says it; undefined until measured. */
  percent: number | undefined
  /** How near auto-compact the context is, 0 to 1: where the meter is heading. */
  private fill = 0
  /** The meter as drawn: rises to `fill` quickly, drains slowly. */
  gauge = 0
  /** When the meter's latest glint started: every so often, and at each measure. */
  private glintAt = 0

  /**
   * The context window measured `now`: `percent` of it in use, and `limit`,
   * the share of it where auto-compact runs (1 when it is off), the top of the
   * meter. The meter moves there in a moment, or at once when `isInstant`;
   * with no `percent` (nothing reported yet), it empties, unlabeled.
   */
  measure(now: number, percent: number | undefined, limit: number, isInstant: boolean) {
    this.percent = percent === undefined ? undefined : Math.max(0, Math.min(100, percent))
    this.fill = percent === undefined ? 0 : Math.max(0, Math.min(1, percent / 100 / Math.max(0.05, Math.min(1, limit))))
    if (isInstant) this.gauge = this.fill
    this.glintAt = now
  }

  /** How far a glint has run up the meter `now`, 0 to 1; undefined between glints. */
  glint(now: number): number | undefined {
    const t = (now - this.glintAt) / GLINT_RUN
    return t < 1 ? t : undefined
  }

  /** Moves it on to `now`, its animation by `ms`: the meter as drawn toward where it is heading, and a glint when one is due. */
  step(now: number, ms: number) {
    const gauge = ease(this.gauge, this.fill, this.fill > this.gauge ? RISE : DRAIN, ms)
    this.gauge = Math.abs(this.fill - gauge) < 0.002 ? this.fill : gauge
    if (now - this.glintAt >= GLINT_EVERY) this.glintAt = now
  }

  /** The meter as drawn is where it is heading. */
  isCalm(): boolean {
    return this.gauge === this.fill
  }
}
