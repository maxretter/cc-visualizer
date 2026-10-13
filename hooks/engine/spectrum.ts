// The visualizer's "audio": what Claude is doing, turned into a spectrum.
//
// Each kind of activity is an instrument with a place on the spectrum, low to
// high. Events feed energy into their instrument (a tool call is a drum hit,
// streamed text a sustained tone, a tool still running a held note), the
// energy dies away, and `Bars` turns the spectrum into bars with falling peak
// caps, packed as `Raster` cells. Like all of the engine, it is pure: no `$`,
// so it tests alone.

import { bump, cycle, ease, fade, FRAME_MS, random } from './math'
import { INDEX, N, placeOf, shortName, sourceOf, SOURCES } from './sources'
import type { SourceId } from './sources'
import { DEMO, Demo } from './demo'
import type { Ensemble } from './ensemble'

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
const SIGMA = 0.055

/** The idle show's swell at a point of the spectrum, `ms` into the show: a low wave rolling up it, breathing. */
function drift(x: number, ms: number): number {
  const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.4 * x - cycle(ms, 5_900))
  const ripple = 0.7 + 0.3 * Math.sin(2 * Math.PI * 2.6 * x + cycle(ms, 9_400) + 1)
  const breath = 0.8 + 0.2 * Math.sin(cycle(ms, 10_900))
  return 0.34 * swell * ripple * breath
}

/** A typed key's note on the spectrum: where it plays, from when, how loud, and how wide. */
type Note = { x: number; at: number; energy: number; sigma: number }

/** One run of calls to the same tool: its name is drawn once, `×count`; `endedAt`, when its last run ended. */
export type Call = { name: string; source: SourceId; count: number; running: number; endedAt: number }

/** A tool call put to the person: its band, its call, when it was asked, and how long before the vamp. */
export type Ask = { source: SourceId; call?: Call; at: number; grace: number }

/** How long a finished call's name stays at full strength, then how long it takes to fade. */
const LINGER = 2_000
const FADE = 1_000

/** The idle show's scenes, in turn: a rolling swell, rain, a scanner sweeping back and forth. */
export const SCENES = ['swell', 'rain', 'scanner'] as const
/** How long each scene plays, the end of it crossfading into the next. */
const SCENE = 20_000
const SCENE_FADE = 2_000
/** The scanner's sweep there and back. */
const SCAN = 8_000
/** Drops a second at the height of the rain. */
const RAIN = 6
/** How long all must be quiet before the idle show starts: a pause in typing, or a reply being read, is not idle. */
export const IDLE_DELAY = 8_000
/** A typed key's note: how fast it fades (it halves every 120 ms), and the beat of a run of them (a paste, a burst of keys). */
const NOTE = 120
const RUN = 25
/** The most notes a run plays: a longer paste plays this many of its characters, spread over it. */
const RUN_NOTES = 32

const SURROGATE = /[\ud800-\udfff]/
/** Whether a pair of surrogates, one character beyond the BMP, starts at code unit `k` of `text`. */
const isPair = (text: string, k: number) => {
  const high = text.charCodeAt(k)
  if (high < 0xd800 || high > 0xdbff) return false
  const low = text.charCodeAt(k + 1)
  return low >= 0xdc00 && low <= 0xdfff
}

/** While the model thinks, sparks of thought a second on its band: these when it is calm, up to as many more again as its text streams. */
const SPARKS = 1.5
/** How long a spark's spike takes to run the length of the brainwave. */
export const SPIKE = 900

/**
 * How long an ask waits before the vamp: a hook may answer a permission
 * request on its own, and the vamp is for the ones the person answers.
 */
export const GRACE = 1_500
/** A beat of the vamp (100 bpm), how long it plays before its pulses shrink, and how long they take to. */
export const BEAT = 600
const BORED = 30_000
const BORED_FADE = 5_000
/** Between the meter's glints, and how long one takes to run up it. */
const GLINT_EVERY = 10_000
const GLINT_RUN = 800

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
  /** How busy the thinking is, from its streamed text: 0 to 0.45. */
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
   * Whether to play the idle show once the music stops: set by the drawing,
   * which knows whether a band stays up while idle.
   */
  ambient = false
  /** How present the idle show is: fades in once all is quiet, out at the first sound. */
  idle = 0
  /** How long since the music stopped: how long Claude has been idle. */
  quietFor = 0
  /** How long the idle show has played, across rests: where it is in its scenes. */
  private show = 0
  /** How much each scene plays now, by `SCENES`. */
  private readonly scene = new Float64Array(SCENES.length)
  /** The rain's drops: where each fell, and how much of it is left. */
  private readonly drops: { x: number; energy: number }[] = []
  /** The notes the person's typing plays, still ringing or still to come in a run. */
  private readonly notes: Note[] = []
  private readonly rand = random(0x1d1e)
  private crash = 0
  private sweep: number | undefined
  private sweepDirection = 1
  /** The demo, played on this spectrum, drawing on its chances. */
  private readonly demo = new Demo(this, this.rand)
  /** The latest tool calls, oldest first, while their names show. */
  readonly calls: Call[] = []
  /** Tool calls put to the person, until they are answered. */
  private readonly asks = new Set<Ask>()
  /** Asks past their grace, by instrument: the vamp pulses their bands. */
  private readonly cued = new Int32Array(N)
  /**
   * Of those, the ones for a call of this spectrum's, by instrument: as many of
   * its held notes rest while they wait. A subagent's ask, heard here too, has
   * its call on the subagent's own spectrum, and rests none of these.
   */
  private readonly hushed = new Int32Array(N)
  /** How present the vamp is: rises once an ask is past its grace, falls once it is answered. */
  cue = 0
  /** How long the vamp has played: where it is in its bars, and whether it has thinned out. */
  private vamp = 0
  /** Compactions running: the tape rewinds until they finish. */
  private rewinding = 0
  /** How fast the sweep runs, in spectra a second. */
  private sweepSpeed = 1.5
  /** The context's share of the window, 0 to 100, as its label says it; undefined until measured. */
  contextPercent: number | undefined
  /** How near auto-compact the context is, 0 to 1: where the meter is heading. */
  private fill = 0
  /** The meter as drawn: rises to `fill` quickly, drains slowly. */
  gauge = 0
  /** When the meter's latest glint started: every so often, and at each measure. */
  private glintAt = 0

  /** A drum hit on an instrument. */
  hit(id: SourceId, strength = 1) {
    this.hits[INDEX[id]] = this.hits[INDEX[id]]! + HIT * strength
  }

  /** Streamed characters, a sustained tone while they keep coming. */
  stream(id: SourceId, chars: number, gain = 1) {
    this.feed[INDEX[id]] = this.feed[INDEX[id]]! + (chars / SCALE[id]) * gain
    if (id === 'think') this.restless = Math.min(0.45, this.restless + (chars / 150) * gain)
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
    if (this.calls.length > 16) this.calls.shift()
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
   * key sits, louder for a capital, a space a soft breath across the middle,
   * and a paste or a burst of keys a run of them. With `isErased`, the text was
   * deleted: quieter notes, the run going backward.
   */
  typed(text: string, isErased = false) {
    // A paste may run to megabytes, and only a run of its characters plays:
    // they are read where they sit, the text never copied. Its length is in
    // characters, a pair of surrogates one; without any, nearly always, each
    // code unit is one, and is read straight from its place.
    let length = text.length
    if (SURROGATE.test(text)) {
      length = 0
      for (let k = 0; k < text.length; k += isPair(text, k) ? 2 : 1) length += 1
    }
    const count = Math.min(length, RUN_NOTES)
    const run: string[] = []
    // The run's characters, found in the order they sit in the text: character `c` starts at code unit `k`.
    for (let m = 0, c = 0, k = 0; m < count; m++) {
      const n = isErased ? count - 1 - m : m
      const i = Math.floor((n * length) / count)
      const place = isErased ? length - 1 - i : i
      if (length === text.length) k = place
      else for (; c < place; c++) k += isPair(text, k) ? 2 : 1
      run[n] = text.slice(k, isPair(text, k) ? k + 2 : k + 1)
    }
    for (let n = 0; n < count; n++) {
      const ch = run[n]!
      const at = this.now + n * RUN
      const loud = isErased ? 0.5 : 1
      if (ch.trim() === '') this.notes.push({ x: 0.5, at, energy: 0.3 * loud, sigma: 0.14 })
      else this.notes.push({ x: placeOf(ch), at, energy: (ch === ch.toLowerCase() ? 0.7 : 0.95) * loud, sigma: 0.03 })
    }
  }

  /**
   * The person edited the prompt's `text`, putting `inputText` in for the span
   * from `start` to `end`: what went in plays, else what went out, else the
   * caret only moved.
   */
  edited(text: string, start: number, end: number, inputText: string) {
    const erased = text.slice(start, end)
    if (inputText !== '') this.typed(inputText)
    else if (erased !== '') this.typed(erased, true)
    else this.moved(text.length === 0 ? 0.5 : start / text.length)
  }

  /** The prompt's caret moved, to `x` of the way through the text: a faint tick there. */
  moved(x: number) {
    this.notes.push({ x: 0.06 + 0.88 * Math.max(0, Math.min(1, x)), at: this.now, energy: 0.25, sigma: 0.02 })
  }

  /** A sweep up the spectrum: a prompt was sent. */
  kick() {
    this.sweep = 0
    this.sweepDirection = 1
    this.sweepSpeed = 1.5
  }

  /**
   * A turn ended, for `reason`: an answer crashes a cymbal (a subagent's
   * softer), an interrupt sweeps back down, anything else flashes red.
   */
  ended(reason: string, isSubagent = false) {
    if (reason === 'aborted') this.scratch()
    else if (reason === 'answer') this.cymbal(isSubagent ? 0.4 : 1)
    else this.error()
  }

  /** A sweep down: the turn was interrupted. */
  scratch() {
    this.sweep = 1
    this.sweepDirection = -1
    this.sweepSpeed = 1.5
  }

  /** A tool call put to the person: the vamp, once `grace` passes unanswered; `answer` when they do. */
  ask(source: SourceId, call?: Call, grace = GRACE): Ask {
    const ask = { source, call, at: this.now, grace }
    this.asks.add(ask)
    return ask
  }

  answer(ask: Ask) {
    this.asks.delete(ask)
  }

  /** Whether an ask is past its grace: the person is being waited on. */
  private isCued(ask: Ask): boolean {
    return this.now - ask.at >= ask.grace
  }

  /** How long since the person was first asked, of the asks past their grace; undefined while none is. */
  waitedFor(): number | undefined {
    let first: number | undefined
    for (const ask of this.asks) if (this.isCued(ask) && (first === undefined || ask.at < first)) first = ask.at
    return first === undefined ? undefined : this.now - first
  }

  /** How many of a call's runs wait on the person. */
  private waitingOn(call: Call): number {
    let n = 0
    for (const ask of this.asks) if (ask.call === call && this.isCued(ask)) n += 1
    return n
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

  /**
   * The context window measured: `percent` of it in use, and `limit`, the share
   * of it where auto-compact runs (1 when it is off), the top of the meter.
   * The meter moves there in a moment, or at once when `isInstant`; with no
   * `percent` (nothing reported yet), it empties, unlabeled.
   */
  measure(percent: number | undefined, limit = 1, isInstant = false) {
    this.contextPercent = percent === undefined ? undefined : Math.max(0, Math.min(100, percent))
    this.fill = percent === undefined ? 0 : Math.max(0, Math.min(1, percent / 100 / Math.max(0.05, Math.min(1, limit))))
    if (isInstant) this.gauge = this.fill
    this.glintAt = this.now
  }

  /** How far a glint has run up the meter, 0 to 1; undefined between glints. */
  glint(): number | undefined {
    const t = (this.now - this.glintAt) / GLINT_RUN
    return t < 1 ? t : undefined
  }

  /** A crash cymbal, heavier in the highs: the turn finished. */
  cymbal(strength = 1) {
    this.crash = Math.max(this.crash, 0.8 * strength)
  }

  error() {
    this.flash = 1
  }

  /** Plays the demo, `ms` long; with an `ensemble`, its subagents join it, each in a channel of its own. */
  playDemo(ensemble?: Ensemble, ms = DEMO) {
    this.demo.play(ensemble, ms)
    this.kick()
  }

  /**
   * The demo subagent whose transcript the demo has opened, by its voice's id,
   * which the drawings put in focus as they do the one the person opens; none
   * for the main conversation's.
   */
  get demoView(): string | undefined {
    return this.demo.view
  }

  /** Moves the music on by `elapsed`: its clocks by all of it, the animation by up to `MAX_STEP`. */
  step(elapsed = FRAME_MS) {
    const passed = Math.max(0, elapsed)
    const ms = Math.min(passed, MAX_STEP)
    this.now += passed
    this.dt = ms
    if (this.demo.isPlaying) this.demo.step(ms)
    const t = this.now
    this.cued.fill(0)
    this.hushed.fill(0)
    for (const ask of this.asks) {
      if (!this.isCued(ask)) continue
      const i = INDEX[ask.source]
      this.cued[i] = this.cued[i]! + 1
      if (ask.call !== undefined) this.hushed[i] = this.hushed[i]! + 1
    }
    const decay = fade(DECAY, ms)
    // A stream is a rate: what came in over the step, as much as came in a frame.
    const frames = Math.max(ms, FRAME_MS / 4) / FRAME_MS
    for (let i = 0; i < N; i++) {
      const hit = 1 - Math.exp(-(this.hits[i]! + this.feed[i]! / frames))
      let next = Math.max(this.level[i]! * decay, hit)
      if (this.held[i]! > this.hushed[i]!) next = Math.max(next, 0.22 + 0.08 * Math.sin(cycle(t, 830) + i * 1.7))
      this.level[i] = next < 0.004 ? 0 : next
      this.hits[i] = 0
      this.feed[i] = 0
    }
    if (this.thinking > 0) this.wander(ms)
    else this.thought.level = 0
    // Each eases toward where it is heading, or dies away, by its half-life.
    const mind = this.thinking > 0 ? Math.min(1, 0.6 + this.restless) : 0
    this.mind = ease(this.mind, mind, mind > this.mind ? 180 : 220, ms)
    if (mind === 0 && this.mind < 0.02) this.mind = 0
    this.restless = this.restless < 0.005 ? 0 : this.restless * fade(320, ms)
    if (this.sweep !== undefined) {
      this.sweep += (this.sweepSpeed * this.sweepDirection * ms) / 1000
      if (this.sweep > 1.15 || this.sweep < -0.15) this.sweep = undefined
    }
    // Compacting: the tape rewinds, sweep after sweep down the spectrum.
    if (this.rewinding > 0 && this.sweep === undefined) {
      this.sweep = 1.15
      this.sweepDirection = -1
      this.sweepSpeed = 2.4
    }
    const cue = this.cued.some(n => n > 0) ? 1 : 0
    this.cue = ease(this.cue, cue, cue > this.cue ? 275 : 140, ms)
    if (cue === 0 && this.cue < 0.01) this.cue = 0
    if (cue === 1) this.vamp += passed
    else if (this.cue === 0) this.vamp = 0
    const gauge = ease(this.gauge, this.fill, this.fill > this.gauge ? 140 : 560, ms)
    this.gauge = Math.abs(this.fill - gauge) < 0.002 ? this.fill : gauge
    if (t - this.glintAt >= GLINT_EVERY) this.glintAt = t
    this.crash = this.crash < 0.004 ? 0 : this.crash * fade(275, ms)
    this.flash = this.flash < 0.01 ? 0 : this.flash * fade(220, ms)
    while (this.sparks.length > 0 && t - this.sparks[0]!.at >= SPIKE) this.sparks.shift()
    // The typed notes ring from when they come in.
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const note = this.notes[i]!
      if (note.at > t) continue
      note.energy *= fade(NOTE, Math.min(ms, t - note.at))
      if (note.energy < 0.01) this.notes.splice(i, 1)
    }
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.strength(this.calls[i]!) === 0) this.calls.splice(i, 1)
    }
    const isResting = this.isResting()
    this.quietFor = isResting ? this.quietFor + passed : 0
    const idle = this.ambient && isResting && this.quietFor >= IDLE_DELAY ? 1 : 0
    this.idle = ease(this.idle, idle, idle > this.idle ? 900 : 140, ms)
    if (idle === 0 && this.idle < 0.01) this.idle = 0
    if (this.idle > 0) this.play(ms)
    else this.drops.length = 0
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
    thought.level = ease(thought.level, thought.target, 110, ms)
    const sparks = SPARKS * (1 + this.restless / 0.45)
    if (this.rand() < 1 - Math.exp((-sparks * ms) / 1000)) this.spark(0.15 + 0.3 * this.rand(), this.rand() < 0.5)
    const i = INDEX.think
    this.level[i] = Math.max(this.level[i]!, thought.level)
  }

  /** A thought sparks: a flick on the thinking's band, and a spike running along the brainwave, in from the left or the right. */
  spark(strength = 0.3, isFromRight = false) {
    this.hit('think', strength)
    this.sparks.push({ at: this.now, isFromRight })
  }

  /** The idle show moves on by `ms`: its scenes, and the rain while it falls. */
  private play(ms: number) {
    this.show += ms
    const t = this.show % (SCENE * SCENES.length)
    const now = Math.floor(t / SCENE)
    const crossfade = Math.max(0, (t % SCENE) - (SCENE - SCENE_FADE)) / SCENE_FADE
    this.scene.fill(0)
    this.scene[now] = 1 - crossfade
    this.scene[(now + 1) % SCENES.length] = crossfade
    const left = fade(100, ms)
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i]!
      drop.energy *= left
      if (drop.energy < 0.01) this.drops.splice(i, 1)
    }
    const falls = 1 - Math.exp((-RAIN * this.scene[1]! * ms) / 1000)
    if (this.rand() < falls) this.drops.push({ x: this.rand(), energy: 0.4 + 0.45 * this.rand() })
  }

  /** The scene the idle show plays most now. */
  sceneNow(): (typeof SCENES)[number] {
    return SCENES[this.scene.indexOf(Math.max(...this.scene))]!
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
    if (this.sweep !== undefined) energy += 0.9 * bump(x - this.sweep, 0.045)
    energy += this.crash * (0.15 + 0.6 * x)
    for (const note of this.notes) if (note.at <= this.now) energy += note.energy * bump(x - note.x, note.sigma)
    if (this.idle > 0) energy += this.idle * this.idleAt(x)
    if (this.cue > 0) energy += this.cue * this.vampAt(x)
    return energy
  }

  /** Where the vamp is: the beat of its bar, and how far into that beat. */
  private beat(): { beat: number; into: number } {
    return { beat: Math.floor(this.vamp / BEAT) % 4, into: (this.vamp % BEAT) / BEAT }
  }

  /** How strong the metronome's tick is now: 1 on the beat, fading through it. */
  tick(): number {
    return this.cue > 0 ? Math.exp(-this.beat().into * 4) : 0
  }

  /**
   * The vamp's energy at a point of the spectrum: the band of each tool that
   * waits on the person pulses on every beat, the bar's first beat the
   * strongest, over a low hum between beats; once the wait runs long, the
   * pulses shrink and the hum goes.
   */
  private vampAt(x: number): number {
    const { beat, into } = this.beat()
    const groove = 1 - Math.max(0, Math.min(1, (this.vamp - BORED) / BORED_FADE))
    const pulse = (0.25 + 0.45 * groove) * (beat === 0 ? 1 : 0.7) * Math.exp(-into * 4) + 0.12 * groove
    let energy = 0
    for (let i = 0; i < N; i++) if (this.cued[i]! > 0) energy += pulse * bump(x - SOURCES[i]!.at, SIGMA)
    return energy
  }

  /** The idle show's energy at a point of the spectrum: its scenes, crossfading. */
  private idleAt(x: number): number {
    const [swell, rain, scanner] = this.scene
    let energy = 0
    if (swell! > 0) energy += swell! * drift(x, this.show)
    if (rain! > 0) energy += 0.15 * rain! * drift(x, this.show)
    for (const drop of this.drops) energy += drop.energy * bump(x - drop.x, 0.022)
    if (scanner! > 0) energy += 0.5 * scanner! * bump(x - (0.5 - 0.5 * Math.cos(cycle(this.show, SCAN))), 0.035)
    return energy
  }

  /** How often the shows want a frame while the music rests. */
  showMs(): number {
    return this.isResting() && this.quietFor >= DROWSY ? DROWSY_MS : SHOW_MS
  }

  /** Nothing playing and nothing left to fade. */
  isQuiet(): boolean {
    return this.isResting() && this.idle === 0
  }

  /** Nothing playing and nothing left to fade but the idle show. */
  isResting(): boolean {
    return this.isCalm() && this.asks.size === 0 && this.cue === 0
  }

  /**
   * Nothing moving but the shows, which can go on for a long time and draw at
   * a slower rate: the idle show, and the vamp while the person is waited on.
   */
  isCalm(): boolean {
    return (
      this.level.every(l => l === 0) &&
      this.held.every((h, i) => h <= this.hushed[i]!) &&
      this.thinking === 0 &&
      this.mind === 0 &&
      this.sweep === undefined &&
      this.crash === 0 &&
      this.flash === 0 &&
      !this.demo.isPlaying &&
      this.notes.length === 0 &&
      this.rewinding === 0 &&
      this.gauge === this.fill &&
      this.calls.every(call => call.running > 0 && call.running <= this.waitingOn(call))
    )
  }

  /** Whether a call is still running, not waiting on the person. */
  isRunning(call: Call): boolean {
    return call.running > this.waitingOn(call)
  }
}
