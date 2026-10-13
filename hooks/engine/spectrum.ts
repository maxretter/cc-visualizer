// The visualizer's "audio": what Claude is doing, turned into a spectrum.
//
// Each kind of activity is an instrument with a place on the spectrum, low to
// high. Events feed energy into their instrument (a tool call is a drum hit,
// streamed text a sustained tone, a tool still running a held note), the
// energy dies away, and `Bars` turns the spectrum into bars with falling peak
// caps, packed as `Raster` cells. Over the instruments play parts of their
// own, each in a file of its own: the person's typing (`keys.ts`), the sweeps
// (`sweep.ts`), the vamp while the person is waited on (`vamp.ts`), the
// context meter (`meter.ts`) and the idle show (`idle.ts`). Like all of the
// engine, it is pure: no `$`, so it tests alone.

import { bump, cycle, ease, fade, FRAME_MS, random } from './math'
import { INDEX, N, shortName, SIGMA, sourceOf, SOURCES } from './sources'
import type { SourceId } from './sources'
import type { Demo } from './demo'
import { IdleShow } from './idle'
import type { Scene } from './idle'
import { Keys } from './keys'
import { Meter } from './meter'
import { Sweep } from './sweep'
import { GRACE, Vamp } from './vamp'
import type { Ask } from './vamp'

// The parts' times and types, for the spectrum's callers.
export { IDLE_DELAY } from './idle'
export { BEAT, GRACE } from './vamp'
export type { Ask } from './vamp'

/** The longest the animation moves in one step: a longer gap (a stall, a sleep) moves the clocks, not the bars. */
const MAX_STEP = 250
/** How often a show wants a frame (the idle show, the vamp): half the full rate. */
const SHOW_MS = 2 * FRAME_MS
/** Once Claude has been idle this long, the idle show wants them slower still (8 fps): nobody watches it closely by then. */
const DROWSY = 5 * 60_000
const DROWSY_MS = 125

/** Characters of a stream that make one full hit, coming in over `FRAME_MS`. */
const SCALE: Record<SourceId, number> = {
  think: 28, text: 18, read: 1, edit: 1, bash: 1, web: 1, agent: 1, args: 48,
}

const HIT = 3
/** How fast an instrument dies away: its energy halves every 150 ms. */
const DECAY = 150
/** How fast a cymbal dies away (it halves every 275 ms), and an error's red flash fades. */
const CRASH = 275
const FLASH = 220

/** One run of calls to the same tool: its name is drawn once, `×count`; `endedAt`, when its last run ended. */
export type Call = { name: string; source: SourceId; count: number; running: number; endedAt: number }

/** How long a finished call's name stays at full strength, then how long it takes to fade. */
const LINGER = 2_000
const FADE = 1_000
/** How many of the latest calls are kept, for their names to show. */
const CALLS = 16

/** While the model thinks, sparks of thought a second on its band: these when it is calm, up to as many more again as its text streams. */
const SPARKS = 1.5
/** How long a spark's spike takes to run the length of the brainwave. */
export const SPIKE = 900
/** How restless the thinking gets at most, as its text streams in. */
const RESTLESS = 0.45
/**
 * How fast the brainwave comes in as the model thinks (half the way every
 * 180 ms), and goes once it stops; how fast the thinking calms, its
 * restlessness halving; and how fast its band wanders to the level it heads for.
 */
const MIND_IN = 180
const MIND_OUT = 220
const CALMING = 320
const WANDER = 110

/**
 * Why a turn ended, as `turn.complete` says it: the model answered, the
 * person interrupted it, the model refused, or an error ended it.
 */
export type Ending = 'answer' | 'aborted' | 'refusal' | 'error'

export class Spectrum {
  readonly level = new Float64Array(N)
  /** Drum hits since the last step, and streamed characters, a rate over it. */
  private readonly hits = new Float64Array(N)
  private readonly feed = new Float64Array(N)
  private readonly held = new Int32Array(N)
  /**
   * Model requests in their thinking phase: sent, and no reply text or tool
   * call yet (thinking text streams there when the session shows it).
   */
  thinking = 0
  /** How present the brainwave is: rises while thinking, fades after. */
  mind = 0
  /** How busy the thinking is, from its streamed text: 0 to `RESTLESS`. */
  restless = 0
  /** Where the thinking's band wanders: its level, the level it heads for, and when it turns for another. */
  private readonly thought = { level: 0, target: 0, turnAt: 0 }
  /** The thinking's latest sparks, oldest first: when each fired, and from which side its spike runs along the brainwave. */
  readonly sparks: { at: number; isFromRight: boolean }[] = []
  /** The music's clock: how long it has played, which stands still while the frames stop. */
  now = 0
  /** How far the animation moved at the last step: its length, up to `MAX_STEP`. */
  dt = 0
  /** A tool error's red flash, 1 fading to 0. */
  flash = 0
  /**
   * Whether to play the idle show once the music stops: set by the stage at
   * each frame, which knows whether a band stays up while idle.
   */
  ambient = false
  /** Its chances, which its thinking, its idle show and a demo played on it draw on. */
  readonly rand = random(0x1d1e)
  private crash = 0
  /** The latest tool calls, oldest first, while their names show. */
  readonly calls: Call[] = []
  /** The parts that play over the instruments. */
  private readonly keys = new Keys()
  private readonly sweep = new Sweep()
  private readonly vamp = new Vamp()
  private readonly meter = new Meter()
  private readonly idleShow = new IdleShow(this.rand)

  /** How present the idle show is: fades in once all is quiet, out at the first sound. */
  get idle(): number {
    return this.idleShow.presence
  }

  /** How long since the music stopped: how long Claude has been idle. */
  get quietFor(): number {
    return this.idleShow.quietFor
  }

  /** How present the vamp is: rises once an ask is past its grace, falls once it is answered. */
  get cue(): number {
    return this.vamp.presence
  }

  /** The context's share of the window, 0 to 100, as its label says it; undefined until measured. */
  get contextPercent(): number | undefined {
    return this.meter.percent
  }

  /** The context meter as drawn, 0 to 1: rises quickly to how near auto-compact the context is, drains slowly. */
  get gauge(): number {
    return this.meter.gauge
  }

  /** A drum hit on an instrument. */
  hit(id: SourceId, strength = 1) {
    this.hits[INDEX[id]] = this.hits[INDEX[id]]! + HIT * strength
  }

  /** Streamed characters, a sustained tone while they keep coming. */
  stream(id: SourceId, chars: number, gain = 1) {
    this.feed[INDEX[id]] = this.feed[INDEX[id]]! + (chars / SCALE[id]) * gain
    if (id === 'think') this.restless = Math.min(RESTLESS, this.restless + (chars / 150) * gain)
  }

  /** A model request starts thinking; `endThinking` once its reply or a tool call comes. */
  beginThinking() {
    this.thinking += 1
  }

  endThinking() {
    this.thinking = Math.max(0, this.thinking - 1)
  }

  /** A held note while a tool runs; `release` when it ends. */
  hold(id: SourceId) {
    this.held[INDEX[id]] = this.held[INDEX[id]]! + 1
  }

  release(id: SourceId) {
    this.held[INDEX[id]] = Math.max(0, this.held[INDEX[id]]! - 1)
  }

  /** A tool starts: a hit, a held note, and its name shown; `endCall` when it returns. */
  startCall(tool: string): Call {
    const name = shortName(tool)
    const source = sourceOf(tool)
    this.hit(source)
    this.hold(source)
    const last = this.calls[this.calls.length - 1]
    if (last?.name === name && this.strength(last) > 0) {
      last.count += 1
      last.running += 1
      return last
    }
    const call = { name, source, count: 1, running: 1, endedAt: this.now }
    this.calls.push(call)
    if (this.calls.length > CALLS) this.calls.shift()
    return call
  }

  endCall(call: Call) {
    this.release(call.source)
    call.running = Math.max(0, call.running - 1)
    if (call.running === 0) call.endedAt = this.now
  }

  /** How strongly a call's name shows: 1 while it runs, fading to 0 once done. */
  strength(call: Call): number {
    if (call.running > 0) return 1
    const age = this.now - call.endedAt
    return age <= LINGER ? 0.9 : Math.max(0, 0.9 * (1 - (age - LINGER) / FADE))
  }

  /**
   * The person typed `text` into the prompt: each character a note where its
   * key sits, a paste or a burst of keys a run of them. With `isErased`, the
   * text was deleted: quieter notes, the run going backward.
   */
  typed(text: string, isErased = false) {
    this.keys.typed(this.now, text, isErased)
  }

  /**
   * The person edited the prompt's `text`, putting `inputText` in for the span
   * from `start` to `end`: what went in plays, else what went out, else the
   * caret only moved.
   */
  edited(text: string, start: number, end: number, inputText: string) {
    this.keys.edited(this.now, text, start, end, inputText)
  }

  /** A sweep up the spectrum: a prompt was sent. */
  kick() {
    this.sweep.up()
  }

  /**
   * A turn ended, for `reason`: an answer crashes a cymbal (a subagent's
   * softer), an interrupt sweeps back down, anything else flashes red.
   */
  ended(reason: Ending, isSubagent = false) {
    if (reason === 'aborted') this.scratch()
    else if (reason === 'answer') this.cymbal(isSubagent ? 0.4 : 1)
    else this.error()
  }

  /** A sweep down: the turn was interrupted. */
  scratch() {
    this.sweep.down()
  }

  /** A tool call put to the person: the vamp, once `grace` passes unanswered; `answer` when they do. */
  ask(source: SourceId, call?: Call, grace = GRACE): Ask {
    return this.vamp.ask(this.now, source, call, grace)
  }

  answer(ask: Ask) {
    this.vamp.answer(ask)
  }

  /** How long since the person was first asked, of the asks past their grace; undefined while none is. */
  waitedFor(): number | undefined {
    return this.vamp.waitedFor(this.now)
  }

  /** A compaction starts: the tape rewinds until `endRewind`. */
  beginRewind() {
    this.sweep.beginRewind()
  }

  endRewind() {
    this.sweep.endRewind()
  }

  /** While compacting. */
  isRewinding(): boolean {
    return this.sweep.isRewinding()
  }

  /**
   * The context window measured: `percent` of it in use, and `limit`, the share
   * of it where auto-compact runs (1 when it is off), the top of the meter.
   * The meter moves there in a moment, or at once when `isInstant`; with no
   * `percent` (nothing reported yet), it empties, unlabeled.
   */
  measure(percent: number | undefined, limit = 1, isInstant = false) {
    this.meter.measure(this.now, percent, limit, isInstant)
  }

  /** How far a glint has run up the meter, 0 to 1; undefined between glints. */
  glint(): number | undefined {
    return this.meter.glint(this.now)
  }

  /** A crash cymbal, heavier in the highs: the turn finished. */
  cymbal(strength = 1) {
    this.crash = Math.max(this.crash, 0.8 * strength)
  }

  error() {
    this.flash = 1
  }

  /**
   * Moves the music on by `elapsed`: its clocks by all of it, the animation by
   * up to `MAX_STEP`. A `demo` playing on it plays its part first, on the
   * clock moved on.
   */
  step(elapsed = FRAME_MS, demo?: Demo) {
    const passed = Math.max(0, elapsed)
    const ms = Math.min(passed, MAX_STEP)
    this.now += passed
    this.dt = ms
    if (demo?.isPlaying) demo.step(ms)
    const t = this.now
    this.vamp.step(t, passed, ms)
    const { hushed } = this.vamp
    const decay = fade(DECAY, ms)
    // A stream is a rate: what came in over the step, as much as came in a frame.
    const frames = Math.max(ms, FRAME_MS / 4) / FRAME_MS
    for (let i = 0; i < N; i++) {
      const hit = 1 - Math.exp(-(this.hits[i]! + this.feed[i]! / frames))
      let next = Math.max(this.level[i]! * decay, hit)
      if (this.held[i]! > hushed[i]!) next = Math.max(next, 0.22 + 0.08 * Math.sin(cycle(t, 830) + i * 1.7))
      this.level[i] = next < 0.004 ? 0 : next
      this.hits[i] = 0
      this.feed[i] = 0
    }
    if (this.thinking > 0) this.wander(ms)
    else this.thought.level = 0
    // Each eases toward where it is heading, or dies away, by its half-life.
    const mind = this.thinking > 0 ? Math.min(1, 0.6 + this.restless) : 0
    this.mind = ease(this.mind, mind, mind > this.mind ? MIND_IN : MIND_OUT, ms)
    if (mind === 0 && this.mind < 0.02) this.mind = 0
    this.restless = this.restless < 0.005 ? 0 : this.restless * fade(CALMING, ms)
    this.sweep.step(ms)
    this.meter.step(t, ms)
    this.crash = this.crash < 0.004 ? 0 : this.crash * fade(CRASH, ms)
    this.flash = this.flash < 0.01 ? 0 : this.flash * fade(FLASH, ms)
    while (this.sparks.length > 0 && t - this.sparks[0]!.at >= SPIKE) this.sparks.shift()
    this.keys.step(t, ms)
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.strength(this.calls[i]!) === 0) this.calls.splice(i, 1)
    }
    this.idleShow.step(passed, ms, this.isResting(), this.ambient)
  }

  /**
   * While the model thinks, its band wanders, `ms` on: it drifts toward a level
   * picked at random, turning for another every so often, and now and then a
   * thought sparks, more often and sooner as thinking text streams in.
   */
  private wander(ms: number) {
    const thought = this.thought
    if (this.now >= thought.turnAt) {
      thought.target = 0.08 + 0.3 * this.rand()
      thought.turnAt = this.now + (150 + 500 * this.rand()) * (1 - this.restless)
    }
    thought.level = ease(thought.level, thought.target, WANDER, ms)
    const sparks = SPARKS * (1 + this.restless / RESTLESS)
    if (this.rand() < 1 - Math.exp((-sparks * ms) / 1000)) this.spark(0.15 + 0.3 * this.rand(), this.rand() < 0.5)
    const i = INDEX.think
    this.level[i] = Math.max(this.level[i]!, thought.level)
  }

  /** A thought sparks: a flick on the thinking's band, and a spike running along the brainwave, in from the left or the right. */
  spark(strength = 0.3, isFromRight = false) {
    this.hit('think', strength)
    this.sparks.push({ at: this.now, isFromRight })
  }

  /** The scene the idle show plays most now. */
  sceneNow(): Scene {
    return this.idleShow.sceneNow()
  }

  /** The energy at a point of the spectrum, 0 (lowest) to 1 (highest). */
  at(x: number): number {
    let energy = 0
    let sum = 0
    for (let i = 0; i < N; i++) {
      const l = this.level[i]!
      sum += l
      if (l > 0) energy += l * bump(x - SOURCES[i]!.at, SIGMA)
    }
    energy += 0.12 * (sum / N)
    energy += this.sweep.at(x)
    energy += this.crash * (0.15 + 0.6 * x)
    energy = this.keys.addAt(this.now, x, energy)
    energy += this.idleShow.at(x)
    energy += this.vamp.at(x)
    return energy
  }

  /** How strong the vamp's metronome tick is now: 1 on the beat, fading through it. */
  tick(): number {
    return this.vamp.tick()
  }

  /** How often the shows want a frame while the music rests. */
  showMs(): number {
    return this.isResting() && this.idleShow.quietFor >= DROWSY ? DROWSY_MS : SHOW_MS
  }

  /** Nothing playing and nothing left to fade. */
  isQuiet(): boolean {
    return this.isResting() && this.idleShow.isQuiet()
  }

  /** Nothing playing and nothing left to fade but the idle show. */
  isResting(): boolean {
    return this.isCalm() && this.vamp.isQuiet()
  }

  /**
   * Nothing moving but the shows, which can go on for a long time and draw at
   * a slower rate: the idle show, and the vamp while the person is waited on.
   * A demo playing on it is for whoever plays it to ask after.
   */
  isCalm(): boolean {
    return (
      this.level.every(l => l === 0) &&
      this.held.every((h, i) => h <= this.vamp.hushed[i]!) &&
      this.thinking === 0 &&
      this.mind === 0 &&
      this.crash === 0 &&
      this.flash === 0 &&
      this.calls.every(call => call.running > 0 && call.running <= this.vamp.waitingOn(this.now, call)) &&
      this.keys.isCalm() &&
      this.sweep.isCalm() &&
      this.meter.isCalm()
    )
  }

  /** Whether a call is still running, not waiting on the person. */
  isRunning(call: Call): boolean {
    return call.running > this.vamp.waitingOn(this.now, call)
  }
}
