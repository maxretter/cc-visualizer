// A drawing's bars: a spectrum as bars with falling peak caps, the context
// meter at their right edge, the brainwave over them while Claude thinks, and
// the names along their top row.

import type { VizTheme } from '../../types'
import { bump, fade, noise, random } from './math'
import { SOURCES } from './sources'
import { CUE, ERROR, GROUND, instrumentColor, LEGEND_GRAY, legible, meterColor, mix, paletteOf, THEMES } from './color'
import type { Tone } from './color'
import { canvas, FULL, pack, SPACE, write } from './cells'
import type { Canvas } from './cells'
import { SPIKE } from './spectrum'
import type { Spectrum } from './spectrum'
import { callName, contextName, fit, nameColor, nameColorOf, statusName, thinkingName } from './names'
import type { Named } from './names'

const EIGHTHS = [SPACE, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, FULL]
/** Peak caps by where the peak sits in its cell: low, middle, high. */
const CAPS = [0x2581, 0x2500, 0x2594]
const FLOOR = 0x2581

const SHADE = 0x2591

/** The meter's color while it has room, before it turns amber. */
const GREEN = 0x22c55e

const BRAILLE = 0x2800
/** Braille dot bits by [column][row] within a cell's 2×4 dots. */
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]
const MIND = 0xa78bfa

/**
 * How bars are cut from the columns: each bar's width and the gap between;
 * with `meter`, the context meter at the right edge, a bar wide.
 */
export type Layout = { width: number; gap: number; meter?: boolean }

/**
 * What bars show beside the music of the spectrum they draw: the context
 * meter of another (the main loop's, while a subagent plays on them), and
 * names leading their labels at the left.
 */
type Look = { meter?: Spectrum; lead?: readonly Named[] }

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
  /** The brainwave's workings, kept from frame to frame: its dots by cell, and its wave by column of dots. */
  private masks?: Uint8Array
  private waves?: Float64Array

  constructor(
    readonly columns: number,
    readonly rows: number,
    private readonly layout: Layout = { width: columns >= 30 ? 2 : 1, gap: 1 },
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

  /**
   * These bars `columns` wide and `rows` high, laid out as they are or as
   * `layout` says, and standing as they stand: each bar takes the height, peak
   * and shimmer of the bar nearest its place on the spectrum, so a drawing that
   * narrows or widens moves on smoothly. As many bars, as high, keep the
   * colors worked out for them.
   */
  resize(columns: number, layout: Layout = this.layout, rows = this.rows): Bars {
    const bars = new Bars(columns, rows, layout)
    // A bar's color is its place among them, so the same number of bars has the same colors.
    if (bars.count === this.count && bars.rows === this.rows) bars.colors = this.colors
    for (let b = 0; b < bars.count; b++) {
      const from = Math.min(this.count - 1, Math.floor(((b + 0.5) / bars.count) * this.count))
      bars.height[b] = this.height[from]!
      bars.peak[b] = this.peak[from]!
      bars.fall[b] = this.fall[from]!
      bars.hold[b] = this.hold[from]!
      bars.phase[b] = this.phase[from]!
      bars.speed[b] = this.speed[from]!
    }
    return bars
  }

  /** The column a point of the spectrum lands on. */
  columnAt(x: number): number {
    const b = x * this.count - 0.5
    return Math.round(this.offset + b * (this.width + this.gap) + (this.width - 1) / 2)
  }

  /**
   * Where a name `length` long starts, centered over the point `at` of the
   * spectrum as far as it can be: not before column `free`, nor ending past
   * column `end`. None where it does not fit.
   */
  private placeCentered(at: number, length: number, free: number, end: number): number | undefined {
    const start = Math.max(free, Math.min(end - length, this.columnAt(at) - Math.floor(length / 2)))
    return start < 0 || start + length > end ? undefined : start
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
    const into = canvas(this.columns, this.rows)
    this.draw(into, theme, spectrum, labels, tone)
    return pack(into.words)
  }

  /**
   * Draws the cells `paint` packs (three words each: glyph, foreground,
   * background) into a canvas whose cells are blank where they go. With a
   * `look`, the meter shows another spectrum's context, and names lead the labels.
   */
  draw(into: Canvas, theme: VizTheme, spectrum?: Spectrum, labels = false, tone: Tone = 'dark', look: Look = {}) {
    const { rows } = this
    const { words, columns, left: x0 } = into
    // How many of the bars' columns show, from their left.
    const shows = Math.min(this.columns, into.right - x0)
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
        for (let c = 0; c < this.width && left + c < shows; c++) {
          const i = (top * columns + x0 + left + c) * 3
          words[i] = glyph
          words[i + 1] = color
        }
      }
    }
    if (this.meter && spectrum !== undefined) this.paintMeter(into, shows, look.meter ?? spectrum, tone)
    if (spectrum !== undefined && spectrum.mind > 0) this.brainwave(into, shows, theme, spectrum, tone)
    if (labels && spectrum !== undefined) this.label(into, shows, theme, spectrum, tone, look)
  }

  /**
   * The context meter at the right edge: it fills toward auto-compact at the
   * top, green, then amber, then red, its empty cells a dim track; now and
   * then a glint runs up it. As much of it as `shows`.
   */
  private paintMeter(into: Canvas, shows: number, spectrum: Spectrum, tone: Tone) {
    const { rows } = this
    const { words, columns, left: x0 } = into
    const level = spectrum.gauge * rows
    const track = mix(GROUND[tone], LEGEND_GRAY, 0.22)
    const glint = spectrum.glint()
    for (let r = 0; r < rows; r++) {
      const fill = level - r
      const top = Math.min(level, r + 1) / rows
      const color = legible(meterColor(top, GREEN), tone)
      const glyph = fill >= 1 ? FULL : fill > 0 ? EIGHTHS[Math.max(1, Math.round(fill * 8))]! : SHADE
      for (let c = 0; c < this.width; c++) {
        const x = this.columns - this.width + c
        if (x >= shows) break
        let shine = 0
        if (glint !== undefined && fill > 0) {
          // A sheen runs up the filled part, from under its foot to over its
          // top, the left column a little ahead: light catching it.
          const at = -0.5 + glint * (level + 1) + 0.3 * (this.width - 1 - c)
          shine = 0.75 * bump(r + 0.5 - at, 0.45)
        }
        const i = ((rows - 1 - r) * columns + x0 + x) * 3
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
  private brainwave(into: Canvas, shows: number, theme: VizTheme, spectrum: Spectrum, tone: Tone) {
    const { columns, rows } = this
    const { words, columns: stride, left: x0 } = into
    const { mind, restless, now, sparks } = spectrum
    const t = now / 1000
    const dotColumns = this.span * 2
    // Above the floor row, so it never threads between the bars' feet.
    const dotRows = Math.max(1, rows - 1) * 4
    this.masks ??= new Uint8Array(columns * rows)
    const masks = this.masks.fill(0)
    const middle = (dotRows - 1) * 0.5
    const reach = dotRows * 0.4 * (0.35 + 0.65 * mind)
    // Noise rolling along the wave while its shape turns, a finer ripple on it
    // as the thinking gets restless; centered on its own mean, as the noise
    // can lean one way for seconds.
    this.waves ??= new Float64Array(dotColumns)
    const waves = this.waves
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
      const x = cell % columns
      if (masks[cell] === 0 || x >= shows) continue
      const i = (Math.floor(cell / columns) * stride + x0 + x) * 3
      if (words[i] !== SPACE) continue
      const pulse = 0.75 + 0.25 * noise((x / this.span) * 5 - t * 1.8, 7 + t * 0.4)
      words[i] = BRAILLE + masks[cell]!
      words[i + 1] = mix(GROUND[tone], base, (0.3 + 0.7 * mind) * pulse)
    }
  }

  /**
   * The top row: the look's names and what is going on at the left (a wait, a
   * compaction, the idle), the context's fill at the right by the meter, and
   * the newest call of each tool band, its name over the band, between.
   */
  private label(into: Canvas, shows: number, theme: VizTheme, spectrum: Spectrum, tone: Tone, look: Look) {
    const put = (start: number, text: string, color: number) => write(into.words, into.columns, 0, into.left + start, text, color, into.left + shows)
    let free = 0
    let end = this.span
    const context = this.meter ? contextName(look.meter ?? spectrum) : undefined
    if (context !== undefined && context.text.length < this.span) {
      put(end - context.text.length, context.text, nameColorOf(theme, context, context.strength, tone))
      end -= context.text.length + 1
    }
    let at = this.offset
    for (const lead of look.lead ?? []) {
      const text = fit(lead.text, Math.max(8, Math.floor((end - this.offset) / 3)))
      if (at + text.length > end) break
      put(at, text, nameColorOf(theme, lead, lead.strength, tone))
      at += text.length + 1
      free = at
    }
    const status = statusName(spectrum)
    if (status !== undefined && at + status.text.length <= end) {
      put(at, status.text, nameColorOf(theme, status, status.strength, tone))
      free = at + status.text.length + 1
    }
    for (const source of SOURCES) {
      let name = source.id === 'think' ? thinkingName(spectrum) : undefined
      for (let i = spectrum.calls.length - 1; i >= 0 && name === undefined; i--) {
        const call = spectrum.calls[i]!
        if (call.source === source.id) name = callName(spectrum, call)
      }
      if (name === undefined) continue
      const { text } = name
      const start = this.placeCentered(source.at, text.length, free, end)
      if (start === undefined) continue
      put(start, text, nameColor(theme, source.id, name.strength, tone))
      free = start + text.length + 1
    }
  }

  /** One row naming the instruments under their place on the spectrum. */
  legend(theme: VizTheme, tone: Tone = 'dark'): string {
    const into = canvas(this.columns, 1)
    this.drawLegend(into, theme, tone)
    return pack(into.words)
  }

  /** Draws the cells `legend` packs into the top row of a canvas whose cells are blank where they go. */
  drawLegend(into: Canvas, theme: VizTheme, tone: Tone = 'dark') {
    const shows = Math.min(this.columns, into.right - into.left)
    let free = 0
    for (const s of SOURCES) {
      const start = this.placeCentered(s.at, s.label.length, free, this.span)
      if (start === undefined) continue
      for (let k = 0; k < s.label.length && start + k < shows; k++) {
        const i = (into.left + start + k) * 3
        into.words[i] = s.label.charCodeAt(k)
        into.words[i + 1] = legible(theme === 'instrument' ? s.color : LEGEND_GRAY, tone)
      }
      free = start + s.label.length + 1
    }
  }
}
