// The visualizer's "audio": what Claude is doing, turned into a spectrum.
//
// Each kind of activity is an instrument with a place on the spectrum, low to
// high. Events feed energy into their instrument (a tool call is a drum hit,
// streamed text a sustained tone, a tool still running a held note), the
// energy dies away, and `Bars` turns the spectrum into bars with falling peak
// caps, packed as `Raster` cells. Pure: no `$`, so it tests alone.
//
// It moves by time, not by frames: each step is told how long it has been, so
// the music plays the same at any frame rate, and every duration, half-life
// and period here is in milliseconds.

import type { VizTheme } from '../types'

/** How often a frame is drawn while something plays (30 fps): a step's length when none is given. */
export const FRAME_MS = 33
/** The longest the animation moves in one step: a longer gap (a stall, a sleep) moves the clocks, not the bars. */
const MAX_STEP = 250
/** How often a show wants a frame (the idle show, the vamp): half the full rate. */
const SHOW_MS = 2 * FRAME_MS
/** Once Claude has been idle this long, the idle show wants them slower still (8 fps): nobody watches it closely by then. */
const DROWSY = 5 * 60_000
const DROWSY_MS = 125

/** What is left of something that halves every `halfLife`, after `ms`. */
const fade = (halfLife: number, ms: number) => Math.pow(0.5, ms / halfLife)

/** A value easing toward `target`, closing half the distance every `halfLife`, after `ms`. */
const ease = (value: number, target: number, halfLife: number, ms: number) => target + (value - target) * fade(halfLife, ms)

/** A wave's phase in radians, `ms` into cycles `period` long. */
const cycle = (ms: number, period: number) => (2 * Math.PI * ms) / period

export type SourceId = 'think' | 'text' | 'read' | 'edit' | 'bash' | 'web' | 'agent' | 'args'

export type Source = { id: SourceId; label: string; at: number; color: number }

/** Low to high: where each kind of activity sits on the spectrum. */
export const SOURCES: readonly Source[] = [
  { id: 'think', label: 'think', at: 0.05, color: 0x8b5cf6 },
  { id: 'text', label: 'text', at: 0.18, color: 0xd97757 },
  { id: 'read', label: 'read', at: 0.32, color: 0x38bdf8 },
  { id: 'edit', label: 'edit', at: 0.45, color: 0x22c55e },
  { id: 'bash', label: 'bash', at: 0.58, color: 0xfacc15 },
  { id: 'web', label: 'web/mcp', at: 0.71, color: 0xf472b6 },
  { id: 'agent', label: 'agents', at: 0.84, color: 0x2dd4bf },
  { id: 'args', label: 'args', at: 0.95, color: 0xe5e7eb },
]

export const THEME_NAMES: readonly VizTheme[] = ['instrument', 'claude', 'synthwave', 'classic']

const N = SOURCES.length
const INDEX = Object.fromEntries(SOURCES.map((s, i) => [s.id, i])) as Record<SourceId, number>

/** Characters of a stream that make one full hit, coming in over `FRAME_MS`. */
const SCALE: Record<SourceId, number> = {
  think: 28, text: 18, read: 1, edit: 1, bash: 1, web: 1, agent: 1, args: 48,
}

const HIT = 3
/** How fast an instrument dies away: its energy halves every 150 ms. */
const DECAY = 150
const SIGMA = 0.055

const READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'LSP', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BASH = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor', 'TaskStop', 'PowerShell'])
const WEB = new Set(['WebFetch', 'WebSearch'])

/** Which instrument a tool plays. */
export function sourceOf(tool: string): SourceId {
  if (READ.has(tool)) return 'read'
  if (EDIT.has(tool)) return 'edit'
  if (BASH.has(tool)) return 'bash'
  if (WEB.has(tool) || tool.startsWith('mcp__')) return 'web'
  return 'agent'
}

const bump = (d: number, sigma: number) => Math.exp(-(d * d) / (2 * sigma * sigma))

/** A random value, -1 to 1, for a whole point of a plane: the same point, the same value. */
function lattice(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h ^= h >>> 13
  return ((h >>> 0) / 4294967296) * 2 - 1
}

/** Smooth random noise, -1 to 1, at any point of a plane: `lattice` eased between its whole points. */
function noise(x: number, y: number): number {
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

/** The idle show's swell at a point of the spectrum, `ms` into the show: a low wave rolling up it, breathing. */
function drift(x: number, ms: number): number {
  const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.4 * x - cycle(ms, 5_900))
  const ripple = 0.7 + 0.3 * Math.sin(2 * Math.PI * 2.6 * x + cycle(ms, 9_400) + 1)
  const breath = 0.8 + 0.2 * Math.sin(cycle(ms, 10_900))
  return 0.34 * swell * ripple * breath
}

/** Where a key plays: where it sits on the keyboard, the left hand low and the right high; any other character, scattered. */
export function placeOf(ch: string): number {
  const c = ch.toLowerCase()
  for (const [keys, shift] of KEYBOARD) {
    const column = keys.indexOf(c)
    if (column >= 0) return 0.06 + (0.88 * (column + shift)) / 9.5
  }
  return 0.06 + 0.88 * (((c.codePointAt(0) ?? 0) * 0.618034) % 1)
}

/** A typed key's note on the spectrum: where it plays, from when, how loud, and how wide. */
type Note = { x: number; at: number; energy: number; sigma: number }

/** A tool's name as drawn: an MCP tool without its server, printable, short. */
export function shortName(tool: string): string {
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 18)
}

/** One run of calls to the same tool: its name is drawn once, `×count`; `endedAt`, when its last run ended. */
export type Call = { name: string; source: SourceId; count: number; running: number; endedAt: number }

/** A tool call put to the person: its band, its call, when it was asked, and how long before the vamp. */
export type Ask = { source: SourceId; call?: Call; at: number; grace: number }

/** How long a finished call's name stays at full strength, then how long it takes to fade. */
const LINGER = 2_000
const FADE = 1_000
const DEMO_TOOLS = ['Grep', 'Read', 'Read', 'Edit', 'Bash', 'WebFetch', 'Agent', 'Write']
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
/** The keyboard, row by row, with how far each row sits to the right, as a key's place on the spectrum. */
const KEYBOARD: readonly (readonly [string, number])[] = [
  ['1234567890', 0],
  ['qwertyuiop', 0.5],
  ['asdfghjkl', 0.75],
  ['zxcvbnm', 1.25],
]
/** While the model thinks, sparks of thought a second on its band: these when it is calm, up to as many more again as its text streams. */
const SPARKS = 1.5
/** How long a spark's spike takes to run the length of the brainwave. */
const SPIKE = 900
/** How long the demo plays, and how long it thinks before the drums come in. */
const DEMO = 11_400
const DEMO_THINK = 2_500
/** The demo's drum machine: a sixteenth note (113 bpm), and how long each tool it calls runs. */
const SIXTEENTH = 132
const DEMO_CALL = 230
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
  /** The demo: how long it has left, how long it is, and the next sixteenth its drums play. */
  private demo = 0
  private demoLength = 0
  private demoNext = 0
  private isDemoThinking = false
  private demoCall: { call: Call; endAt: number } | undefined
  /** The latest tool calls, oldest first, while their names show. */
  readonly calls: Call[] = []
  /** Tool calls put to the person, until they are answered. */
  private readonly asks = new Set<Ask>()
  /** Asks past their grace, by instrument: their held notes rest while they wait. */
  private readonly cued = new Int32Array(N)
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
    const chars = [...text]
    const count = Math.min(chars.length, RUN_NOTES)
    for (let n = 0; n < count; n++) {
      const i = Math.floor((n * chars.length) / count)
      const ch = chars[isErased ? chars.length - 1 - i : i]!
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

  playDemo(ms = DEMO) {
    this.demo = ms
    this.demoLength = ms
    this.demoNext = 0
    this.kick()
  }

  /** Moves the music on by `elapsed`: its clocks by all of it, the animation by up to `MAX_STEP`. */
  step(elapsed = FRAME_MS) {
    const passed = Math.max(0, elapsed)
    const ms = Math.min(passed, MAX_STEP)
    this.now += passed
    this.dt = ms
    if (this.demo > 0) this.sequence(ms)
    const t = this.now
    this.cued.fill(0)
    for (const ask of this.asks) if (this.isCued(ask)) this.cued[INDEX[ask.source]] = this.cued[INDEX[ask.source]]! + 1
    const decay = fade(DECAY, ms)
    // A stream is a rate: what came in over the step, as much as came in a frame.
    const frames = Math.max(ms, FRAME_MS / 4) / FRAME_MS
    for (let i = 0; i < N; i++) {
      const hit = 1 - Math.exp(-(this.hits[i]! + this.feed[i]! / frames))
      let next = Math.max(this.level[i]! * decay, hit)
      if (this.held[i]! > this.cued[i]!) next = Math.max(next, 0.22 + 0.08 * Math.sin(cycle(t, 830) + i * 1.7))
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
      this.held.every((h, i) => h <= this.cued[i]!) &&
      this.thinking === 0 &&
      this.mind === 0 &&
      this.sweep === undefined &&
      this.crash === 0 &&
      this.flash === 0 &&
      this.demo === 0 &&
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

  /**
   * The demo, `ms` on: a spell of thinking, then the drum machine: kick, snare,
   * hats, a melody, fills. Streams come in as a rate, so as much over `ms` as a
   * frame's worth for each frame it spans.
   */
  private sequence(ms: number) {
    this.demo = Math.max(0, this.demo - ms)
    const elapsed = this.demoLength - this.demo
    const frames = ms / FRAME_MS
    if (elapsed < DEMO_THINK && this.demo > 0) {
      if (!this.isDemoThinking) {
        this.isDemoThinking = true
        this.beginThinking()
      }
      this.stream('think', 12 * this.rand() * frames)
      return
    }
    if (this.isDemoThinking) {
      this.isDemoThinking = false
      this.endThinking()
    }
    const drums = elapsed - DEMO_THINK
    // The melody plays through the first ten sixteenths of each bar.
    if (drums >= 0 && drums % (16 * SIXTEENTH) < 10 * SIXTEENTH) this.stream('text', (6 + 6 * Math.sin(cycle(drums, 690))) * frames)
    if (this.demoCall !== undefined && (elapsed >= this.demoCall.endAt || this.demo === 0)) {
      this.endCall(this.demoCall.call)
      this.demoCall = undefined
    }
    // Each sixteenth the step reached: hats on every one, the kick on the beat,
    // the snare halfway through it, and a tool between.
    for (; this.demoNext * SIXTEENTH <= drums; this.demoNext++) {
      const n = this.demoNext
      this.hit('args', 0.21)
      if (n % 4 === 0) this.hit('think')
      if (n % 4 === 2) this.hit('bash', 0.8)
      if (n % 2 === 1 && this.demoCall === undefined && this.demo > 2 * SIXTEENTH) {
        const call = this.startCall(DEMO_TOOLS[Math.floor(n / 2) % DEMO_TOOLS.length]!)
        this.demoCall = { call, endAt: elapsed + DEMO_CALL }
      }
    }
    if (this.demo === 0) this.cymbal()
  }
}

/** A piece of a model's response as it streams, as much of it as the music needs. */
export type Chunk = { kind: string; text?: string; name?: string; json?: string }

/**
 * One model request as it streams. It thinks from the request until its
 * first text or tool call, and again whenever it thinks anew: the sub-bass
 * and the brainwave. Its text is the bass, a tool call it writes a hit on
 * that tool's band, the call's arguments hats. A subagent's plays softer.
 */
export class Step {
  private isThinking = true
  private readonly gain: number

  constructor(
    private readonly spectrum: Spectrum,
    isSubagent = false,
  ) {
    this.gain = isSubagent ? 0.6 : 1
    spectrum.beginThinking()
  }

  /** A chunk of the response came in. */
  hear(chunk: Chunk) {
    const { spectrum, gain } = this
    const isThought = chunk.kind === 'thinking'
    if (isThought !== this.isThinking && (isThought || chunk.kind === 'text' || chunk.kind === 'tool')) {
      this.isThinking = isThought
      if (isThought) spectrum.beginThinking()
      else spectrum.endThinking()
    }
    if (chunk.kind === 'text') spectrum.stream('text', chunk.text?.length ?? 0, gain)
    else if (chunk.kind === 'thinking') spectrum.stream('think', chunk.text?.length ?? 0, gain)
    else if (chunk.kind === 'tool') spectrum.hit(sourceOf(chunk.name ?? ''), 0.8 * gain)
    else if (chunk.kind === 'input') spectrum.stream('args', chunk.json?.length ?? 0, gain)
  }

  /** The stream is over, however it ended: the thinking stops with it. */
  end() {
    if (this.isThinking) this.spectrum.endThinking()
    this.isThinking = false
  }
}

// Colors -------------------------------------------------------------------

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255
  return (
    (clamp255(ar + (br - ar) * t) << 16) |
    (clamp255(ag + (bg - ag) * t) << 8) |
    clamp255(ab + (bb - ab) * t)
  )
}

export const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

type Palette = {
  bar: (y: number, tint: number) => number
  peak: (tint: number) => number
  floor: (tint: number) => number
}

function stops(points: readonly (readonly [number, number])[], peak: number, floor: number): Palette {
  const bar = (y: number) => {
    for (let i = 1; i < points.length; i++) {
      const [x1, c1] = points[i]!
      const [x0, c0] = points[i - 1]!
      if (y <= x1) return mix(c0, c1, (y - x0) / (x1 - x0))
    }
    return points[points.length - 1]![1]
  }
  return { bar, peak: () => peak, floor: () => floor }
}

export const THEMES: Record<VizTheme, Palette> = {
  instrument: {
    bar: (y, tint) => mix(0, tint, 0.45 + 0.55 * y),
    peak: tint => mix(tint, 0xffffff, 0.55),
    floor: tint => mix(0, tint, 0.3),
  },
  claude: stops([[0, 0x9a4126], [0.45, 0xd97757], [0.8, 0xeba57f], [1, 0xf7dcc0]], 0xfff3e6, 0x4a2a20),
  synthwave: stops([[0, 0x5b21b6], [0.4, 0xc026d3], [0.75, 0xf472b6], [1, 0x67e8f9]], 0xffffff, 0x2e1f47),
  classic: stops([[0, 0x16a34a], [0.55, 0x4ade80], [0.7, 0xfacc15], [0.86, 0xf97316], [1, 0xef4444]], 0xf5f5f5, 0x1f3a28),
}

/** How the terminal's background reads: what faded colors fade into, and what colors must stand out from. */
export type Tone = 'dark' | 'light'

/** The background each tone stands for. */
export const GROUND: Record<Tone, number> = { dark: 0x000000, light: 0xffffff }

const linear = (v: number) => (v <= 10 ? v / 3295 : ((v / 255 + 0.055) / 1.055) ** 2.4)

/** How bright a color looks, 0 to 1: its relative luminance. */
export const luminance = (c: number) => 0.2126 * linear((c >> 16) & 255) + 0.7152 * linear((c >> 8) & 255) + 0.0722 * linear(c & 255)

/** A color that stands out on the tone's background: on a light one, a pale color darkened until it does. */
export function legible(color: number, tone: Tone): number {
  let c = color
  if (tone === 'light') while (luminance(c) > 0.3) c = mix(c, 0, 0.1)
  return c
}

/**
 * Claude Code's theme as a tone: a light theme reads light, a dark one dark,
 * and `auto` (Claude Code reads the terminal itself) by `COLORFGBG`, which some
 * terminals set (`15;0`, white on black), else dark, as most terminals are.
 */
export function toneOf(theme: unknown, colorfgbg?: string): Tone {
  if (typeof theme === 'string' && theme.startsWith('light')) return 'light'
  if (typeof theme === 'string' && theme.startsWith('dark')) return 'dark'
  const background = Number(colorfgbg?.split(';').at(-1))
  return Number.isInteger(background) && (background === 7 || background >= 9) ? 'light' : 'dark'
}

/**
 * A theme's palette on a tone's background. On a light one its fades go to
 * white and its colors are darkened to stand out, its peak caps darker than
 * the bars rather than brighter.
 */
function paletteOf(theme: VizTheme, tone: Tone): Palette {
  const dark = THEMES[theme]
  if (tone === 'dark') return dark
  const white = GROUND.light
  if (theme === 'instrument') {
    return {
      bar: (y, tint) => mix(white, legible(tint, tone), 0.45 + 0.55 * y),
      peak: tint => mix(legible(tint, tone), 0, 0.45),
      floor: tint => mix(white, legible(tint, tone), 0.3),
    }
  }
  return {
    bar: (y, tint) => legible(dark.bar(y, tint), tone),
    peak: tint => mix(legible(dark.bar(1, tint), tone), 0, 0.4),
    floor: tint => mix(white, legible(dark.bar(0, tint), tone), 0.35),
  }
}

/** The instruments' colors blended across the spectrum: a bar's own color. */
function instrumentColor(x: number): number {
  let r = 0, g = 0, b = 0, total = 0
  for (const s of SOURCES) {
    const w = bump(x - s.at, 0.07)
    r += w * ((s.color >> 16) & 255)
    g += w * ((s.color >> 8) & 255)
    b += w * (s.color & 255)
    total += w
  }
  return (clamp255(r / total) << 16) | (clamp255(g / total) << 8) | clamp255(b / total)
}

// Cells --------------------------------------------------------------------

const DEFAULT = 0x01000000
const SPACE = 0x20
const FULL = 0x2588
const EIGHTHS = [SPACE, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, FULL]
/** Peak caps by where the peak sits in its cell: low, middle, high. */
const CAPS = [0x2581, 0x2500, 0x2594]
const FLOOR = 0x2581
const ERROR = 0xef4444
/** The vamp's amber: the color of waiting on the person, and of a meter getting full. */
const CUE = 0xf59e0b
const LEGEND_GRAY = 0x9ca3af
const SHADE = 0x2591
/** Where the meter turns amber and red, as a share of the way to auto-compact. */
const AMBER_AT = 0.7
const RED_AT = 0.9
const METER = [0x22c55e, CUE, ERROR]
const SPINNER = [0x280b, 0x2819, 0x2839, 0x2838, 0x283c, 0x2834, 0x2826, 0x2827, 0x2807, 0x280f]
/** How long the spinner shows each of its glyphs. */
const SPIN = 70
const BRAILLE = 0x2800
/** Braille dot bits by [column][row] within a cell's 2×4 dots. */
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]
const MIND = 0xa78bfa

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Bytes as standard padded base64, as `Raster` cells take them: the runtime's own encoder where it has one. */
export function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  return typeof native === 'function' ? native.call(bytes) : encodeBase64(bytes)
}

/** Standard padded base64, by hand: for a runtime without `toBase64`. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += b === undefined ? '=' : ALPHABET[(n >> 6) & 63]!
    out += c === undefined ? '=' : ALPHABET[n & 63]!
  }
  return out
}

function blank(cells: number): Uint32Array {
  const words = new Uint32Array(cells * 3)
  for (let i = 0; i < words.length; i += 3) {
    words[i] = SPACE
    words[i + 1] = DEFAULT
    words[i + 2] = DEFAULT
  }
  return words
}

/** Writes ASCII text into one row of cells. */
function write(words: Uint32Array, columns: number, row: number, start: number, text: string, color: number) {
  for (let k = 0; k < text.length; k++) {
    const i = (row * columns + start + k) * 3
    words[i] = text.charCodeAt(k)
    words[i + 1] = color
    words[i + 2] = DEFAULT
  }
}

/** A tool's name in the color of the theme, as strong as the call's name shows, faded into the background. */
function nameColor(theme: VizTheme, source: SourceId, strength: number, tone: Tone): number {
  const color = theme === 'instrument' ? legible(SOURCES[INDEX[source]]!.color, tone) : paletteOf(theme, tone).peak(0)
  return mix(GROUND[tone], color, strength)
}

const label = (call: Call) => (call.count > 1 ? `${call.name}\u00d7${call.count}` : call.name)

/** A name the trail or the labels draw: a tool call, the thinking, a wait, a compaction, or the idle. */
type Named = { text: string; source: SourceId; strength: number; isRunning: boolean; color?: number }

/** How long Claude has been idle, as its label says it: `idle`, `idle 4m`, `idle 1h 5m`. */
export function idleText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'idle'
  if (minutes < 60) return `idle ${minutes}m`
  return `idle ${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A stretch of time as a clock reads it: `0:42`, `12:05`, `1:02:03`. */
export function clockText(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const s = String(seconds % 60).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}:${s}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
}

/** While the person is waited on: how long, in amber, pulsing with the metronome. */
const waitingName = (spectrum: Spectrum): Named | undefined => {
  const waited = spectrum.waitedFor()
  return waited !== undefined && spectrum.cue > 0.05
    ? {
        text: `waiting on you \u00b7 ${clockText(waited)}`,
        source: 'think',
        strength: spectrum.cue * (0.65 + 0.35 * spectrum.tick()),
        isRunning: false,
        color: CUE,
      }
    : undefined
}

/** While the conversation is compacted. */
const compactingName = (spectrum: Spectrum): Named | undefined =>
  spectrum.isRewinding()
    ? { text: 'compacting', source: 'think', strength: 0.8 + 0.2 * Math.sin(cycle(spectrum.now, 2_070)), isRunning: true, color: LEGEND_GRAY }
    : undefined

/** The context's fill as its label says it, colored as the meter is at its top. */
const contextName = (spectrum: Spectrum): Named | undefined =>
  spectrum.contextPercent === undefined
    ? undefined
    : {
        text: `context ${Math.round(spectrum.contextPercent)}%`,
        source: 'think',
        strength: 0.85,
        isRunning: false,
        color: spectrum.gauge >= RED_AT ? ERROR : spectrum.gauge >= AMBER_AT ? CUE : LEGEND_GRAY,
      }

/** The label at the left: waiting on the person, else compacting, else idle. */
const statusName = (spectrum: Spectrum): Named | undefined =>
  waitingName(spectrum) ?? compactingName(spectrum) ?? idleName(spectrum)

/** While the idle show plays: its label, gray, breathing slowly. */
const idleName = (spectrum: Spectrum): Named | undefined =>
  spectrum.idle > 0.05
    ? {
        text: idleText(spectrum.quietFor),
        source: 'think',
        strength: spectrum.idle * (0.7 + 0.2 * Math.sin(cycle(spectrum.now, 5_180))),
        isRunning: false,
        color: LEGEND_GRAY,
      }
    : undefined

const nameColorOf = (theme: VizTheme, name: Named, strength: number, tone: Tone) =>
  name.color === undefined
    ? nameColor(theme, name.source, strength, tone)
    : mix(GROUND[tone], legible(name.color, tone), strength)

const thinkingName = (spectrum: Spectrum): Named | undefined =>
  spectrum.mind > 0.05 ? { text: 'thinking', source: 'think', strength: spectrum.mind, isRunning: spectrum.thinking > 0 } : undefined

const callName = (spectrum: Spectrum, call: Call): Named => ({
  text: label(call),
  source: call.source,
  strength: spectrum.strength(call),
  isRunning: spectrum.isRunning(call),
})

/**
 * The latest tools' names along the bottom row, newest at the right edge
 * (beside a mini spectrum), a spinner before each one still running.
 */
export function trail(spectrum: Spectrum, theme: VizTheme, columns: number, rows: number, tone: Tone = 'dark'): string {
  const words = blank(columns * rows)
  const row = rows - 1
  const dot = mix(GROUND[tone], legible(LEGEND_GRAY, tone), 0.6)
  const thinking = thinkingName(spectrum)
  const status = statusName(spectrum)
  const names = spectrum.calls.map(call => callName(spectrum, call)).reverse()
  if (thinking !== undefined) names.unshift(thinking)
  if (status !== undefined) names.unshift(status)
  let end = columns - 2
  let placed = 0
  for (const name of names) {
    const strength = name.strength * Math.max(0.45, 1 - 0.18 * placed)
    if (strength <= 0) continue
    const { text } = name
    const spin = name.isRunning ? 2 : 0
    const gap = placed > 0 ? 3 : 0
    if (end - gap - text.length - spin < 0) break
    if (gap > 0) {
      write(words, columns, row, end - gap, ' \u00b7 ', dot)
      end -= gap
    }
    write(words, columns, row, end - text.length, text, nameColorOf(theme, name, strength, tone))
    end -= text.length
    if (spin > 0) {
      const cell = (row * columns + end - 2) * 3
      words[cell] = SPINNER[Math.floor(spectrum.now / SPIN) % SPINNER.length]!
      words[cell + 1] = nameColorOf(theme, name, 1, tone)
      end -= spin
    }
    placed += 1
  }
  return base64(new Uint8Array(words.buffer))
}

/** The checks `/viz doctor` draws, a row each. */
export const DOCTOR_ROWS = ['ramp', 'colors', 'ground', 'fade', 'glyphs'] as const

/**
 * `/viz doctor`'s swatches, `columns` wide, for a background of `tone`, a row
 * for each check: the theme's colors as a ramp (smooth where the terminal
 * shows 24-bit color, banded where it does not); the instruments' colors; the
 * background the visualizer expects beside the terminal's own, which should
 * look the same; a fade into it, whose faint end should vanish; and the
 * glyphs the band draws with, which the font must have.
 */
export function swatches(theme: VizTheme, tone: Tone, columns: number): string {
  const words = blank(columns * DOCTOR_ROWS.length)
  const palette = paletteOf(theme, tone)
  const put = (row: number, column: number, glyph: number, fg: number, bg = DEFAULT) => {
    const i = (row * columns + column) * 3
    words[i] = glyph
    words[i + 1] = fg
    words[i + 2] = bg
  }
  const gray = legible(LEGEND_GRAY, tone)
  const half = Math.floor(columns / 2)
  const width = Math.floor(columns / SOURCES.length)
  for (let c = 0; c < columns; c++) {
    const x = c / Math.max(1, columns - 1)
    put(0, c, FULL, palette.bar(theme === 'instrument' ? 1 : x, instrumentColor(x)))
    put(3, c, FULL, mix(GROUND[tone], legible(CUE, tone), x))
  }
  SOURCES.forEach((source, s) => {
    const bg = legible(source.color, tone)
    const ink = luminance(bg) > 0.3 ? 0x000000 : 0xffffff
    for (let c = 0; c < width; c++) put(1, s * width + c, source.label.charCodeAt(c - 1) || SPACE, ink, bg)
  })
  for (let c = 0; c < columns; c++) put(2, c, SPACE, gray, c < half ? DEFAULT : GROUND[tone])
  write(words, columns, 2, 1, 'your terminal', gray)
  write(words, columns, 2, half + 1, 'what is expected', gray)
  write(words, columns, 4, 0, '▁▂▃▄▅▆▇█ ▔─▁ ⣿⡇⠿⠛⣀⠉ ░░ ⠋⠙⠹⠸⠼⠴ ×·', gray)
  return base64(new Uint8Array(words.buffer))
}

function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * How bars are cut from the columns: each bar's width and the gap between;
 * with `meter`, the context meter at the right edge, a bar wide.
 */
export type Layout = { width: number; gap: number; meter?: boolean }

/** How fast a bar rises toward its level: half the way every 19 ms, nearly at once. */
const RISE = 19
/**
 * How heavily a bar falls: its height over a point half a bar under the floor
 * halves every 450 ms, so it lands rather than hovering just above it.
 */
const SINK = 450
/** How long a peak cap hangs before it falls, and the pull it falls by, in bars a second each second. */
const HOLD = 330
const GRAVITY = 3.2

/** One drawing's bars: their heights and peaks, laid out for its size. */
export class Bars {
  readonly count: number
  readonly width: number
  readonly gap: number
  readonly offset: number
  /** The columns the bars take: all of them, less the meter's and its gap. */
  readonly span: number
  /** Whether the context meter is drawn at the right edge. */
  readonly meter: boolean
  private readonly height: Float64Array
  private readonly peak: Float64Array
  /** How fast each peak cap falls, in bars a second, and how long it hangs first. */
  private readonly fall: Float64Array
  private readonly hold: Float64Array
  /** Each bar's own shimmer: where its wave starts, and how fast it turns, in radians a second. */
  private readonly phase: Float64Array
  private readonly speed: Float64Array
  private readonly tint: Uint32Array
  private readonly rand: () => number
  /**
   * A theme's colors on a tone's background, worked out once each: the bars by
   * bar and row, each bar's peak cap and floor, and the amber and red they turn.
   */
  private colors?: { theme: VizTheme; tone: Tone; bar: Uint32Array; peak: Uint32Array; floor: Uint32Array; cue: number; error: number }

  constructor(
    readonly columns: number,
    readonly rows: number,
    layout: Layout = { width: columns >= 30 ? 2 : 1, gap: 1 },
  ) {
    this.width = layout.width
    this.gap = layout.gap
    this.meter = layout.meter === true && columns >= 16
    this.span = this.meter ? columns - this.width - this.gap - (this.width > 1 ? 1 : 0) : columns
    this.count = Math.max(1, Math.floor((this.span + this.gap) / (this.width + this.gap)))
    this.offset = Math.max(0, Math.floor((this.span - (this.count * (this.width + this.gap) - this.gap)) / 2))
    this.height = new Float64Array(this.count)
    this.peak = new Float64Array(this.count)
    this.fall = new Float64Array(this.count)
    this.hold = new Float64Array(this.count)
    this.phase = new Float64Array(this.count)
    this.speed = new Float64Array(this.count)
    this.tint = new Uint32Array(this.count)
    this.rand = random(columns * 131 + rows)
    for (let b = 0; b < this.count; b++) {
      this.phase[b] = this.rand() * Math.PI * 2
      this.speed[b] = 4.5 + this.rand() * 10.5
      this.tint[b] = instrumentColor((b + 0.5) / this.count)
    }
  }

  /** The column a point of the spectrum lands on. */
  columnAt(x: number): number {
    const b = x * this.count - 0.5
    return Math.round(this.offset + b * (this.width + this.gap) + (this.width - 1) / 2)
  }

  /** Moves the bars toward the spectrum, as far as its last step went: a fast rise, a heavy fall. */
  step(spectrum: Spectrum) {
    const { dt } = spectrum
    const seconds = spectrum.now / 1000
    const rise = fade(RISE, dt)
    const sink = fade(SINK, dt)
    // The shows move smoothly: the shimmer calms while the idle show or the vamp plays.
    const shimmer = 1 - 0.8 * Math.max(spectrum.idle, spectrum.cue)
    for (let b = 0; b < this.count; b++) {
      const x = (b + 0.5) / this.count
      const jitter = 0.22 * Math.sin(seconds * this.speed[b]! + this.phase[b]!) + 0.16 * (this.rand() - 0.5)
      const wobble = 0.8 + jitter * shimmer
      const target = 1 - Math.exp(-2.1 * spectrum.at(x) * wobble)
      let h = this.height[b]!
      h = target > h ? target + (h - target) * rise : Math.max(target, (h + 0.5) * sink - 0.5)
      this.height[b] = h < 0.002 ? 0 : h
      let p = this.peak[b]!
      if (h >= p) {
        p = h
        this.fall[b] = 0
        this.hold[b] = HOLD
      } else if (this.hold[b]! > 0) {
        this.hold[b] = this.hold[b]! - dt
      } else {
        const v = this.fall[b]! + (GRAVITY * dt) / 1000
        this.fall[b] = v
        p = Math.max(h, p - (v * dt) / 1000)
      }
      this.peak[b] = p < 0.002 ? 0 : p
    }
  }

  /** Every bar and peak back on the floor. */
  isSettled(): boolean {
    return this.height.every(h => h === 0) && this.peak.every(p => p === 0)
  }

  private colorsOf(theme: VizTheme, tone: Tone) {
    if (this.colors?.theme === theme && this.colors.tone === tone) return this.colors
    const { count, rows } = this
    const palette = paletteOf(theme, tone)
    const colors = {
      theme,
      tone,
      bar: new Uint32Array(count * rows),
      peak: new Uint32Array(count),
      floor: new Uint32Array(count),
      cue: legible(CUE, tone),
      error: legible(ERROR, tone),
    }
    for (let b = 0; b < count; b++) {
      const tint = this.tint[b]!
      for (let r = 0; r < rows; r++) colors.bar[b * rows + r] = palette.bar(r / Math.max(1, rows - 1), tint)
      colors.peak[b] = palette.peak(tint)
      colors.floor[b] = palette.floor(tint)
    }
    this.colors = colors
    return colors
  }

  /** The bars as Raster cells, for a background of `tone`; with `labels`, each tool's name over its band. */
  paint(theme: VizTheme, spectrum?: Spectrum, labels = false, tone: Tone = 'dark'): string {
    const { columns, rows } = this
    const words = blank(columns * rows)
    const colors = this.colorsOf(theme, tone)
    const red = (spectrum?.flash ?? 0) * 0.65
    const amber = (spectrum?.cue ?? 0) * 0.8
    // Amber while the person is waited on, red after an error, the floor too,
    // so either shows on bars that have fallen; most frames neither.
    const shade = (color: number) => (amber === 0 && red === 0 ? color : mix(mix(color, colors.cue, amber), colors.error, red))
    for (let b = 0; b < this.count; b++) {
      const h = this.height[b]! * rows
      const p = this.peak[b]! * rows
      const peakRow = this.peak[b]! > 0.03 ? Math.min(rows - 1, Math.floor(p)) : -1
      const left = this.offset + b * (this.width + this.gap)
      for (let r = 0; r < rows; r++) {
        const fill = h - r
        let glyph: number
        let color: number
        if (fill > 0) {
          glyph = fill >= 1 ? FULL : EIGHTHS[Math.max(1, Math.round(fill * 8))]!
          color = shade(colors.bar[b * rows + r]!)
        } else if (r === peakRow) {
          glyph = CAPS[Math.min(2, Math.floor((p - r) * 3))]!
          color = shade(colors.peak[b]!)
        } else if (r === 0) {
          glyph = FLOOR
          color = shade(colors.floor[b]!)
        } else {
          continue
        }
        const top = rows - 1 - r
        for (let c = 0; c < this.width && left + c < columns; c++) {
          const i = (top * columns + left + c) * 3
          words[i] = glyph
          words[i + 1] = color
        }
      }
    }
    if (this.meter && spectrum !== undefined) this.paintMeter(words, spectrum, tone)
    if (spectrum !== undefined && spectrum.mind > 0) this.brainwave(words, theme, spectrum, tone)
    if (labels && spectrum !== undefined) this.label(words, theme, spectrum, tone)
    return base64(new Uint8Array(words.buffer))
  }

  /**
   * The context meter at the right edge: it fills toward auto-compact at the
   * top, green, then amber, then red, its empty cells a dim track; now and
   * then a glint runs up it.
   */
  private paintMeter(words: Uint32Array, spectrum: Spectrum, tone: Tone) {
    const { columns, rows } = this
    const level = spectrum.gauge * rows
    const track = mix(GROUND[tone], LEGEND_GRAY, 0.22)
    const glint = spectrum.glint()
    for (let r = 0; r < rows; r++) {
      const fill = level - r
      const top = Math.min(level, r + 1) / rows
      const color = legible(METER[top >= RED_AT ? 2 : top >= AMBER_AT ? 1 : 0]!, tone)
      const glyph = fill >= 1 ? FULL : fill > 0 ? EIGHTHS[Math.max(1, Math.round(fill * 8))]! : SHADE
      for (let c = 0; c < this.width; c++) {
        let shine = 0
        if (glint !== undefined && fill > 0) {
          // A sheen runs up the filled part, from under its foot to over its
          // top, the left column a little ahead: light catching it.
          const at = -0.5 + glint * (level + 1) + 0.3 * (this.width - 1 - c)
          shine = 0.75 * bump(r + 0.5 - at, 0.45)
        }
        const i = ((rows - 1 - r) * columns + columns - this.width + c) * 3
        words[i] = glyph
        words[i + 1] = fill > 0 ? mix(color, 0xffffff, shine) : track
      }
    }
  }

  /**
   * While Claude thinks: a wave of braille dots wandering through the cells
   * above the bars, never the same twice, busier as thinking text streams in,
   * each spark of thought a spike running along it, and a glow drifting on it.
   */
  private brainwave(words: Uint32Array, theme: VizTheme, spectrum: Spectrum, tone: Tone) {
    const { columns, rows } = this
    const { mind, restless, now, sparks } = spectrum
    const t = now / 1000
    const dotColumns = this.span * 2
    // Above the floor row, so it never threads between the bars' feet.
    const dotRows = Math.max(1, rows - 1) * 4
    const masks = new Uint8Array(columns * rows)
    const middle = (dotRows - 1) * 0.5
    const reach = dotRows * 0.4 * (0.35 + 0.65 * mind)
    // Noise rolling along the wave while its shape turns, a finer ripple on it
    // as the thinking gets restless; centered on its own mean, as the noise
    // can lean one way for seconds.
    const waves = new Float64Array(dotColumns)
    let sum = 0
    for (let x = 0; x < dotColumns; x++) {
      const u = x / dotColumns
      waves[x] =
        1.4 * noise(u * 2.5 - t * 0.8, t * 0.3) +
        0.6 * noise(u * 6 + t * 1.1, 17 + t * 0.7) +
        (0.2 + restless) * noise(u * 17 - t * 2.6, 41 + t * 1.6)
      sum += waves[x]!
    }
    const mean = sum / dotColumns
    let previous: number | undefined
    for (let x = 0; x < dotColumns; x++) {
      const u = x / dotColumns
      let wave = waves[x]! - mean
      for (const { at, isFromRight } of sparks) {
        const run = (now - at) / SPIKE
        if (run >= 0 && run < 1) wave -= 1.6 * (1 - run) * bump(u - (isFromRight ? 1 - run : run), 0.018)
      }
      const y = Math.max(0, Math.min(dotRows - 1, Math.round(middle + reach * wave)))
      const from = previous ?? y
      for (let dot = Math.min(from, y); dot <= Math.max(from, y); dot++) {
        const cell = (dot >> 2) * columns + (x >> 1)
        masks[cell] = masks[cell]! | DOTS[x & 1]![dot & 3]!
      }
      previous = y
    }
    const base = legible(theme === 'instrument' ? MIND : THEMES[theme].bar(0.8, 0), tone)
    for (let cell = 0; cell < masks.length; cell++) {
      const i = cell * 3
      if (masks[cell] === 0 || words[i] !== SPACE) continue
      const pulse = 0.75 + 0.25 * noise(((cell % columns) / this.span) * 5 - t * 1.8, 7 + t * 0.4)
      words[i] = BRAILLE + masks[cell]!
      words[i + 1] = mix(GROUND[tone], base, (0.3 + 0.7 * mind) * pulse)
    }
  }

  /**
   * The top row: what is going on at the left (a wait, a compaction, the idle),
   * the context's fill at the right by the meter, and the newest call of each
   * tool band, its name over the band, between.
   */
  private label(words: Uint32Array, theme: VizTheme, spectrum: Spectrum, tone: Tone) {
    let free = 0
    let end = this.span
    const context = this.meter ? contextName(spectrum) : undefined
    if (context !== undefined && context.text.length < this.span) {
      write(words, this.columns, 0, end - context.text.length, context.text, nameColorOf(theme, context, context.strength, tone))
      end -= context.text.length + 1
    }
    const status = statusName(spectrum)
    if (status !== undefined && this.offset + status.text.length <= end) {
      write(words, this.columns, 0, this.offset, status.text, nameColorOf(theme, status, status.strength, tone))
      free = this.offset + status.text.length + 1
    }
    for (const source of SOURCES) {
      let name = source.id === 'think' ? thinkingName(spectrum) : undefined
      for (let i = spectrum.calls.length - 1; i >= 0 && name === undefined; i--) {
        const call = spectrum.calls[i]!
        if (call.source === source.id) name = callName(spectrum, call)
      }
      if (name === undefined) continue
      const { text } = name
      const start = Math.max(free, Math.min(end - text.length, this.columnAt(source.at) - Math.floor(text.length / 2)))
      if (start < 0 || start + text.length > end) continue
      write(words, this.columns, 0, start, text, nameColor(theme, source.id, name.strength, tone))
      free = start + text.length + 1
    }
  }

  /** One row naming the instruments under their place on the spectrum. */
  legend(theme: VizTheme, tone: Tone = 'dark'): string {
    const words = blank(this.columns)
    let free = 0
    for (const s of SOURCES) {
      const start = Math.max(free, Math.min(this.span - s.label.length, this.columnAt(s.at) - Math.floor(s.label.length / 2)))
      if (start < 0 || start + s.label.length > this.span) continue
      for (let k = 0; k < s.label.length; k++) {
        words[(start + k) * 3] = s.label.charCodeAt(k)
        words[(start + k) * 3 + 1] = legible(theme === 'instrument' ? s.color : LEGEND_GRAY, tone)
      }
      free = start + s.label.length + 1
    }
    return base64(new Uint8Array(words.buffer))
  }
}
