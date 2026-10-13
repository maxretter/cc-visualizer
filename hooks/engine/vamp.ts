// The asks put to the person, and the vamp while they wait: once an ask is
// past its grace, the band of each tool waiting on them pulses on the beat
// until they answer.

import { bump, ease } from './math'
import { INDEX, N, SIGMA, SOURCES } from './sources'
import type { SourceId } from './sources'
import type { Call } from './spectrum'

/** A tool call put to the person: its band, its call, when it was asked, and how long before the vamp. */
export type Ask = { source: SourceId; call?: Call; at: number; grace: number }

/**
 * How long an ask waits before the vamp: a hook may answer a permission
 * request on its own, and the vamp is for the ones the person answers.
 */
export const GRACE = 1_500
/** A beat of the vamp (100 bpm), how long it plays before its pulses shrink, and how long they take to. */
export const BEAT = 600
const BORED = 30_000
const BORED_FADE = 5_000
/** How fast the vamp comes in once an ask is past its grace (half the way every 275 ms), and goes once it is answered. */
const CUE_IN = 275
const CUE_OUT = 140

/** The asks put to the person on a spectrum, until they are answered, and the vamp they play. */
export class Vamp {
  /** Tool calls put to the person, until they are answered. */
  private readonly asks = new Set<Ask>()
  /** Asks past their grace, by instrument: the vamp pulses their bands. */
  private readonly cued = new Int32Array(N)
  /**
   * Of those, the ones for a call of this spectrum's, by instrument: as many of
   * its held notes rest while they wait. A subagent's ask, heard here too, has
   * its call on the subagent's own spectrum, and rests none of these.
   */
  readonly hushed = new Int32Array(N)
  /** How present the vamp is: rises once an ask is past its grace, falls once it is answered. */
  presence = 0
  /** How long the vamp has played: where it is in its bars, and whether it has thinned out. */
  private played = 0

  /** A tool call put to the person `now`: the vamp, once `grace` passes unanswered; `answer` when they do. */
  ask(now: number, source: SourceId, call: Call | undefined, grace: number): Ask {
    const ask = { source, call, at: now, grace }
    this.asks.add(ask)
    return ask
  }

  answer(ask: Ask) {
    this.asks.delete(ask)
  }

  /** Whether an ask is past its grace `now`: the person is being waited on. */
  private isCued(now: number, ask: Ask): boolean {
    return now - ask.at >= ask.grace
  }

  /** How long since the person was first asked, of the asks past their grace `now`; undefined while none is. */
  waitedFor(now: number): number | undefined {
    let first: number | undefined
    for (const ask of this.asks) if (this.isCued(now, ask) && (first === undefined || ask.at < first)) first = ask.at
    return first === undefined ? undefined : now - first
  }

  /** How many of a call's runs wait on the person `now`. */
  waitingOn(now: number, call: Call): number {
    let n = 0
    for (const ask of this.asks) if (ask.call === call && this.isCued(now, ask)) n += 1
    return n
  }

  /**
   * Moves it on to `now`, by `passed`, its animation by `ms`: which asks are
   * past their grace by then, and the vamp coming in for them or going.
   */
  step(now: number, passed: number, ms: number) {
    this.cued.fill(0)
    this.hushed.fill(0)
    for (const ask of this.asks) {
      if (!this.isCued(now, ask)) continue
      const i = INDEX[ask.source]
      this.cued[i] = this.cued[i]! + 1
      if (ask.call !== undefined) this.hushed[i] = this.hushed[i]! + 1
    }
    const cue = this.cued.some(n => n > 0) ? 1 : 0
    this.presence = ease(this.presence, cue, cue > this.presence ? CUE_IN : CUE_OUT, ms)
    if (cue === 0 && this.presence < 0.01) this.presence = 0
    if (cue === 1) this.played += passed
    else if (this.presence === 0) this.played = 0
  }

  /** Where the vamp is: the beat of its bar, and how far into that beat. */
  private beat(): { beat: number; into: number } {
    return { beat: Math.floor(this.played / BEAT) % 4, into: (this.played % BEAT) / BEAT }
  }

  /** How strong the metronome's tick is now: 1 on the beat, fading through it. */
  tick(): number {
    return this.presence > 0 ? Math.exp(-this.beat().into * 4) : 0
  }

  /**
   * The vamp's energy at a point of the spectrum, as present as it is: the
   * band of each tool that waits on the person pulses on every beat, the
   * bar's first beat the strongest, over a low hum between beats; once the
   * wait runs long, the pulses shrink and the hum goes.
   */
  at(x: number): number {
    if (this.presence === 0) return 0
    const { beat, into } = this.beat()
    const groove = 1 - Math.max(0, Math.min(1, (this.played - BORED) / BORED_FADE))
    const pulse = (0.25 + 0.45 * groove) * (beat === 0 ? 1 : 0.7) * Math.exp(-into * 4) + 0.12 * groove
    let energy = 0
    for (let i = 0; i < N; i++) if (this.cued[i]! > 0) energy += pulse * bump(x - SOURCES[i]!.at, SIGMA)
    return this.presence * energy
  }

  /** No ask waits on the person, and the vamp has gone. */
  isQuiet(): boolean {
    return this.asks.size === 0 && this.presence === 0
  }
}
