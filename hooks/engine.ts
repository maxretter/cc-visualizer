// The visualizer's "audio": what Claude is doing, turned into a spectrum.
//
// Each kind of activity is an instrument with a place on the spectrum, low to
// high. Events feed energy into their instrument (a tool call is a drum hit,
// streamed text a sustained tone, a tool still running a held note), the
// energy decays every frame, and `Bars` turns the spectrum into bars with
// falling peak caps, packed as `Raster` cells. Pure: no `$`, so it tests alone.

import type { VizTheme } from '../types'

export const FRAME_MS = 33

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

/** Characters of a stream that make one full hit. */
const SCALE: Record<SourceId, number> = {
  think: 28, text: 18, read: 1, edit: 1, bash: 1, web: 1, agent: 1, args: 48,
}

const HIT = 3
const DECAY = 0.86
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

/** The idle show's swell at a point of the spectrum: a low wave rolling up it, breathing. */
function drift(x: number, f: number): number {
  const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.4 * x - f * 0.035)
  const ripple = 0.7 + 0.3 * Math.sin(2 * Math.PI * 2.6 * x + f * 0.022 + 1)
  const breath = 0.8 + 0.2 * Math.sin(f * 0.019)
  return 0.34 * swell * ripple * breath
}

/** A tool's name as drawn: an MCP tool without its server, printable, short. */
export function shortName(tool: string): string {
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 18)
}

/** One run of calls to the same tool: its name is drawn once, `×count`. */
export type Call = { name: string; source: SourceId; count: number; running: number; endedAt: number }

/** Frames a finished call's name stays at full strength, then fades over. */
const LINGER = 60
const FADE = 30
const DEMO_TOOLS = ['Grep', 'Read', 'Read', 'Edit', 'Bash', 'WebFetch', 'Agent', 'Write']
/** The idle show's scenes, in turn: a rolling swell, rain, a scanner sweeping back and forth. */
export const SCENES = ['swell', 'rain', 'scanner'] as const
/** Frames each scene plays (20 s), the last of them crossfading into the next. */
const SCENE = 600
const SCENE_FADE = 60
/** Frames of the scanner's sweep there and back. */
const SCAN = 240
/** Frames the demo thinks before the drums come in. */
const DEMO_THINK = 75

export class Spectrum {
  readonly level = new Float64Array(N)
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
  frame = 0
  /** A tool error's red flash, 1 fading to 0. */
  flash = 0
  /**
   * Whether to play the idle show once the music stops: set by the drawing,
   * which knows whether a band stays up while idle.
   */
  ambient = false
  /** How present the idle show is: fades in once all is quiet, out at the first sound. */
  idle = 0
  /** Frames since the music stopped: how long Claude has been idle. */
  quietFor = 0
  /** Frames the idle show has played, across rests: where it is in its scenes. */
  private show = 0
  /** How much each scene plays now, by `SCENES`. */
  private readonly scene = new Float64Array(SCENES.length)
  /** The rain's drops: where each fell, and how much of it is left. */
  private readonly drops: { x: number; energy: number }[] = []
  private readonly rand = random(0x1d1e)
  private crash = 0
  private sweep: number | undefined
  private sweepDirection = 1
  private demo = 0
  private demoLength = 0
  private isDemoThinking = false
  private demoCall: { call: Call; endAt: number } | undefined
  /** The latest tool calls, oldest first, while their names show. */
  readonly calls: Call[] = []

  /** A drum hit on an instrument. */
  hit(id: SourceId, strength = 1) {
    this.feed[INDEX[id]] = this.feed[INDEX[id]]! + HIT * strength
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
    const call = { name, source, count: 1, running: 1, endedAt: this.frame }
    this.calls.push(call)
    if (this.calls.length > 16) this.calls.shift()
    return call
  }

  endCall(call: Call) {
    this.release(call.source)
    call.running = Math.max(0, call.running - 1)
    if (call.running === 0) call.endedAt = this.frame
  }

  /** How strongly a call's name shows: 1 while it runs, fading to 0 once done. */
  strength(call: Call): number {
    if (call.running > 0) return 1
    const age = this.frame - call.endedAt
    return age <= LINGER ? 0.9 : Math.max(0, 0.9 * (1 - (age - LINGER) / FADE))
  }

  /** A sweep up the spectrum: a prompt was sent. */
  kick() {
    this.sweep = 0
    this.sweepDirection = 1
  }

  /** A sweep down: the turn was interrupted. */
  scratch() {
    this.sweep = 1
    this.sweepDirection = -1
  }

  /** A crash cymbal, heavier in the highs: the turn finished. */
  cymbal(strength = 1) {
    this.crash = Math.max(this.crash, 0.8 * strength)
  }

  error() {
    this.flash = 1
  }

  playDemo(frames = 345) {
    this.demo = frames
    this.demoLength = frames
    this.kick()
  }

  /** Moves one frame on. */
  step() {
    this.frame += 1
    if (this.demo > 0) this.sequence()
    const f = this.frame
    for (let i = 0; i < N; i++) {
      const hit = 1 - Math.exp(-this.feed[i]!)
      let next = Math.max(this.level[i]! * DECAY, hit)
      if (this.held[i]! > 0) next = Math.max(next, 0.22 + 0.08 * Math.sin(f * 0.25 + i * 1.7))
      this.level[i] = next < 0.004 ? 0 : next
      this.feed[i] = 0
    }
    if (this.thinking > 0) {
      const i = INDEX.think
      this.level[i] = Math.max(this.level[i]!, 0.16 + 0.1 * Math.sin(f * 0.12))
    }
    const mind = this.thinking > 0 ? Math.min(1, 0.6 + this.restless) : 0
    this.mind += (mind - this.mind) * (mind > this.mind ? 0.12 : 0.1)
    if (mind === 0 && this.mind < 0.02) this.mind = 0
    this.restless = this.restless < 0.005 ? 0 : this.restless * 0.93
    if (this.sweep !== undefined) {
      this.sweep += 0.05 * this.sweepDirection
      if (this.sweep > 1.15 || this.sweep < -0.15) this.sweep = undefined
    }
    this.crash = this.crash < 0.004 ? 0 : this.crash * 0.92
    this.flash = this.flash < 0.01 ? 0 : this.flash * 0.9
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.strength(this.calls[i]!) === 0) this.calls.splice(i, 1)
    }
    const isResting = this.isResting()
    this.quietFor = isResting ? this.quietFor + 1 : 0
    const idle = this.ambient && isResting ? 1 : 0
    this.idle += (idle - this.idle) * (idle > this.idle ? 0.025 : 0.15)
    if (idle === 0 && this.idle < 0.01) this.idle = 0
    if (this.idle > 0) this.play()
    else this.drops.length = 0
  }

  /** The idle show moves on: its scenes, and the rain while it falls. */
  private play() {
    this.show += 1
    const t = this.show % (SCENE * SCENES.length)
    const now = Math.floor(t / SCENE)
    const fade = Math.max(0, (t % SCENE) - (SCENE - SCENE_FADE)) / SCENE_FADE
    this.scene.fill(0)
    this.scene[now] = 1 - fade
    this.scene[(now + 1) % SCENES.length] = fade
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i]!
      drop.energy *= 0.8
      if (drop.energy < 0.01) this.drops.splice(i, 1)
    }
    if (this.rand() < 0.18 * this.scene[1]!) this.drops.push({ x: this.rand(), energy: 0.4 + 0.45 * this.rand() })
  }

  /** The scene the idle show plays most now. */
  get sceneNow(): (typeof SCENES)[number] {
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
    if (this.idle > 0) energy += this.idle * this.idleAt(x)
    return energy
  }

  /** The idle show's energy at a point of the spectrum: its scenes, crossfading. */
  private idleAt(x: number): number {
    const [swell, rain, scanner] = this.scene
    let energy = 0
    if (swell! > 0) energy += swell! * drift(x, this.show)
    if (rain! > 0) energy += 0.15 * rain! * drift(x, this.show)
    for (const drop of this.drops) energy += drop.energy * bump(x - drop.x, 0.022)
    if (scanner! > 0) energy += 0.5 * scanner! * bump(x - (0.5 - 0.5 * Math.cos((2 * Math.PI * this.show) / SCAN)), 0.035)
    return energy
  }

  /** Nothing playing and nothing left to fade. */
  isQuiet(): boolean {
    return this.isResting() && this.idle === 0
  }

  /** Nothing playing and nothing left to fade but the idle show. */
  isResting(): boolean {
    return (
      this.level.every(l => l === 0) &&
      this.held.every(h => h === 0) &&
      this.thinking === 0 &&
      this.mind === 0 &&
      this.sweep === undefined &&
      this.crash === 0 &&
      this.flash === 0 &&
      this.demo === 0 &&
      this.calls.length === 0
    )
  }

  /** The demo: a spell of thinking, then the drum machine: kick, snare, hats, a melody, fills. */
  private sequence() {
    this.demo -= 1
    const elapsed = this.demoLength - this.demo
    if (elapsed < DEMO_THINK && this.demo > 0) {
      if (!this.isDemoThinking) {
        this.isDemoThinking = true
        this.beginThinking()
      }
      this.stream('think', 6 + 6 * Math.sin(elapsed * 0.2))
      return
    }
    if (this.isDemoThinking) {
      this.isDemoThinking = false
      this.endThinking()
    }
    const f = this.frame
    const beat = f % 16
    if (beat === 0) this.hit('think')
    if (beat === 8) this.hit('bash', 0.8)
    if (f % 4 === 0) this.stream('args', 30)
    if (f % 64 < 40) this.stream('text', 6 + 6 * Math.sin(f * 0.3))
    if (this.demoCall !== undefined && (f >= this.demoCall.endAt || this.demo === 0)) {
      this.endCall(this.demoCall.call)
      this.demoCall = undefined
    }
    if ((beat === 4 || beat === 12) && this.demoCall === undefined && this.demo > 8) {
      const call = this.startCall(DEMO_TOOLS[Math.floor(f / 8) % DEMO_TOOLS.length]!)
      this.demoCall = { call, endAt: f + 7 }
    }
    if (this.demo === 0) this.cymbal()
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
const LEGEND_GRAY = 0x9ca3af
const SPINNER = [0x280b, 0x2819, 0x2839, 0x2838, 0x283c, 0x2834, 0x2826, 0x2827, 0x2807, 0x280f]
const BRAILLE = 0x2800
/** Braille dot bits by [column][row] within a cell's 2×4 dots. */
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]
const MIND = 0xa78bfa

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
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

/** A tool's name in the color of the theme, as strong as the call's name shows. */
function nameColor(theme: VizTheme, source: SourceId, strength: number): number {
  const color = theme === 'instrument' ? SOURCES[INDEX[source]]!.color : THEMES[theme].peak(0)
  return mix(0, color, strength)
}

const label = (call: Call) => (call.count > 1 ? `${call.name}\u00d7${call.count}` : call.name)

/** A name the trail or the labels draw: a tool call, the thinking, or the idle. */
type Named = { text: string; source: SourceId; strength: number; isRunning: boolean; color?: number }

/** How long Claude has been idle, as its label says it: `idle`, `idle 4m`, `idle 1h 5m`. */
export function idleText(frames: number): string {
  const minutes = Math.floor((frames * FRAME_MS) / 60000)
  if (minutes < 1) return 'idle'
  if (minutes < 60) return `idle ${minutes}m`
  return `idle ${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** While the idle show plays: its label, gray, breathing slowly. */
const idleName = (spectrum: Spectrum): Named | undefined =>
  spectrum.idle > 0.05
    ? {
        text: idleText(spectrum.quietFor),
        source: 'think',
        strength: spectrum.idle * (0.7 + 0.2 * Math.sin(spectrum.frame * 0.04)),
        isRunning: false,
        color: LEGEND_GRAY,
      }
    : undefined

const nameColorOf = (theme: VizTheme, name: Named, strength: number) =>
  name.color === undefined ? nameColor(theme, name.source, strength) : mix(0, name.color, strength)

const thinkingName = (spectrum: Spectrum): Named | undefined =>
  spectrum.mind > 0.05 ? { text: 'thinking', source: 'think', strength: spectrum.mind, isRunning: spectrum.thinking > 0 } : undefined

const callName = (spectrum: Spectrum, call: Call): Named => ({
  text: label(call),
  source: call.source,
  strength: spectrum.strength(call),
  isRunning: call.running > 0,
})

/**
 * The latest tools' names along the bottom row, newest at the right edge
 * (beside a mini spectrum), a spinner before each one still running.
 */
export function trail(spectrum: Spectrum, theme: VizTheme, columns: number, rows: number): string {
  const words = blank(columns * rows)
  const row = rows - 1
  const dot = mix(0, LEGEND_GRAY, 0.6)
  const thinking = thinkingName(spectrum)
  const idle = idleName(spectrum)
  const names = spectrum.calls.map(call => callName(spectrum, call)).reverse()
  if (thinking !== undefined) names.unshift(thinking)
  if (idle !== undefined) names.unshift(idle)
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
    write(words, columns, row, end - text.length, text, nameColorOf(theme, name, strength))
    end -= text.length
    if (spin > 0) {
      const cell = (row * columns + end - 2) * 3
      words[cell] = SPINNER[Math.floor(spectrum.frame / 2) % SPINNER.length]!
      words[cell + 1] = nameColor(theme, name.source, 1)
      end -= spin
    }
    placed += 1
  }
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

/** How bars are cut from the columns: each bar's width and the gap between. */
export type Layout = { width: number; gap: number }

/** One drawing's bars: their heights and peaks, laid out for its size. */
export class Bars {
  readonly count: number
  readonly width: number
  readonly gap: number
  readonly offset: number
  private readonly height: Float64Array
  private readonly peak: Float64Array
  private readonly fall: Float64Array
  private readonly hold: Int32Array
  private readonly phase: Float64Array
  private readonly speed: Float64Array
  private readonly tint: Uint32Array
  private readonly rand: () => number

  constructor(
    readonly columns: number,
    readonly rows: number,
    layout: Layout = { width: columns >= 30 ? 2 : 1, gap: 1 },
  ) {
    this.width = layout.width
    this.gap = layout.gap
    this.count = Math.max(1, Math.floor((columns + this.gap) / (this.width + this.gap)))
    this.offset = Math.max(0, Math.floor((columns - (this.count * (this.width + this.gap) - this.gap)) / 2))
    this.height = new Float64Array(this.count)
    this.peak = new Float64Array(this.count)
    this.fall = new Float64Array(this.count)
    this.hold = new Int32Array(this.count)
    this.phase = new Float64Array(this.count)
    this.speed = new Float64Array(this.count)
    this.tint = new Uint32Array(this.count)
    this.rand = random(columns * 131 + rows)
    for (let b = 0; b < this.count; b++) {
      this.phase[b] = this.rand() * Math.PI * 2
      this.speed[b] = 0.15 + this.rand() * 0.35
      this.tint[b] = instrumentColor((b + 0.5) / this.count)
    }
  }

  /** The column a point of the spectrum lands on. */
  columnAt(x: number): number {
    const b = x * this.count - 0.5
    return Math.round(this.offset + b * (this.width + this.gap) + (this.width - 1) / 2)
  }

  /** Moves the bars toward the spectrum: a fast rise, a heavy fall. */
  step(spectrum: Spectrum) {
    const f = spectrum.frame
    // The idle show moves smoothly: the shimmer calms while it plays.
    const shimmer = 1 - 0.8 * spectrum.idle
    for (let b = 0; b < this.count; b++) {
      const x = (b + 0.5) / this.count
      const jitter = 0.22 * Math.sin(f * this.speed[b]! + this.phase[b]!) + 0.16 * (this.rand() - 0.5)
      const wobble = 0.8 + jitter * shimmer
      const target = 1 - Math.exp(-2.1 * spectrum.at(x) * wobble)
      let h = this.height[b]!
      h = target > h ? h + (target - h) * 0.7 : Math.max(target, h - 0.025 - h * 0.05)
      this.height[b] = h < 0.002 ? 0 : h
      let p = this.peak[b]!
      if (h >= p) {
        p = h
        this.fall[b] = 0
        this.hold[b] = 10
      } else if (this.hold[b]! > 0) {
        this.hold[b] = this.hold[b]! - 1
      } else {
        const v = this.fall[b]! + 0.0035
        this.fall[b] = v
        p = Math.max(h, p - v)
      }
      this.peak[b] = p < 0.002 ? 0 : p
    }
  }

  /** Every bar and peak back on the floor. */
  isSettled(): boolean {
    return this.height.every(h => h === 0) && this.peak.every(p => p === 0)
  }

  /** The bars as Raster cells; with `labels`, each tool's name over its band. */
  paint(theme: VizTheme, spectrum?: Spectrum, labels = false): string {
    const { columns, rows } = this
    const words = blank(columns * rows)
    const palette = THEMES[theme]
    const red = (spectrum?.flash ?? 0) * 0.65
    for (let b = 0; b < this.count; b++) {
      const tint = this.tint[b]!
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
          color = mix(palette.bar(r / Math.max(1, rows - 1), tint), ERROR, red)
        } else if (r === peakRow) {
          glyph = CAPS[Math.min(2, Math.floor((p - r) * 3))]!
          color = mix(palette.peak(tint), ERROR, red)
        } else if (r === 0) {
          glyph = FLOOR
          color = palette.floor(tint)
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
    if (spectrum !== undefined && spectrum.mind > 0) this.brainwave(words, theme, spectrum)
    if (labels && spectrum !== undefined) this.label(words, theme, spectrum)
    return base64(new Uint8Array(words.buffer))
  }

  /**
   * While Claude thinks: a slow wave of braille dots rolling through the cells
   * above the bars, busier as thinking text streams in, a pulse running along it.
   */
  private brainwave(words: Uint32Array, theme: VizTheme, spectrum: Spectrum) {
    const { columns, rows } = this
    const { mind, restless, frame: f } = spectrum
    const dotColumns = columns * 2
    // Above the floor row, so it never threads between the bars' feet.
    const dotRows = Math.max(1, rows - 1) * 4
    const masks = new Uint8Array(columns * rows)
    const middle = (dotRows - 1) * 0.5
    const reach = dotRows * 0.4 * (0.35 + 0.65 * mind)
    let previous: number | undefined
    for (let x = 0; x < dotColumns; x++) {
      const u = x / dotColumns
      const wave =
        0.55 * Math.sin(2 * Math.PI * 1.3 * u + f * 0.19) +
        0.3 * Math.sin(2 * Math.PI * 3.1 * u - f * 0.11 + 1.3) +
        (0.12 + restless) * Math.sin(2 * Math.PI * 8.3 * u + f * 0.53)
      const y = Math.max(0, Math.min(dotRows - 1, Math.round(middle + reach * wave)))
      const from = previous ?? y
      for (let dot = Math.min(from, y); dot <= Math.max(from, y); dot++) {
        const cell = (dot >> 2) * columns + (x >> 1)
        masks[cell] = masks[cell]! | DOTS[x & 1]![dot & 3]!
      }
      previous = y
    }
    const base = theme === 'instrument' ? MIND : THEMES[theme].bar(0.8, 0)
    for (let cell = 0; cell < masks.length; cell++) {
      const i = cell * 3
      if (masks[cell] === 0 || words[i] !== SPACE) continue
      const pulse = 0.75 + 0.25 * Math.sin(((cell % columns) / columns) * 14 - f * 0.3)
      words[i] = BRAILLE + masks[cell]!
      words[i + 1] = mix(0, base, (0.3 + 0.7 * mind) * pulse)
    }
  }

  /** The newest call of each tool band, its name in the top row over the band. */
  private label(words: Uint32Array, theme: VizTheme, spectrum: Spectrum) {
    let free = 0
    const idle = idleName(spectrum)
    if (idle !== undefined && this.offset + idle.text.length <= this.columns) {
      write(words, this.columns, 0, this.offset, idle.text, nameColorOf(theme, idle, idle.strength))
      free = this.offset + idle.text.length + 1
    }
    for (const source of SOURCES) {
      let name = source.id === 'think' ? thinkingName(spectrum) : undefined
      for (let i = spectrum.calls.length - 1; i >= 0 && name === undefined; i--) {
        const call = spectrum.calls[i]!
        if (call.source === source.id) name = callName(spectrum, call)
      }
      if (name === undefined) continue
      const { text } = name
      const start = Math.max(free, Math.min(this.columns - text.length, this.columnAt(source.at) - Math.floor(text.length / 2)))
      if (start < 0 || start + text.length > this.columns) continue
      write(words, this.columns, 0, start, text, nameColor(theme, source.id, name.strength))
      free = start + text.length + 1
    }
  }

  /** One row naming the instruments under their place on the spectrum. */
  legend(theme: VizTheme): string {
    const words = blank(this.columns)
    let free = 0
    for (const s of SOURCES) {
      const start = Math.max(free, Math.min(this.columns - s.label.length, this.columnAt(s.at) - Math.floor(s.label.length / 2)))
      if (start < 0 || start + s.label.length > this.columns) continue
      for (let k = 0; k < s.label.length; k++) {
        words[(start + k) * 3] = s.label.charCodeAt(k)
        words[(start + k) * 3 + 1] = theme === 'instrument' ? s.color : LEGEND_GRAY
      }
      free = start + s.label.length + 1
    }
    return base64(new Uint8Array(words.buffer))
  }
}
