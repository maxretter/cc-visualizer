// The colors: each theme's palette, the background a tone stands for, how
// a color is made to stand out on it, light or dark, and the ink the drawings
// take from a theme on a background.

import type { VizTheme } from '../../types'
import { bump } from './math'
import { INDEX, SOURCES } from './sources'
import type { SourceId } from './sources'

export const THEME_NAMES: readonly VizTheme[] = ['instrument', 'claude', 'synthwave', 'classic']

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

const THEMES: Record<VizTheme, Palette> = {
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

/**
 * The colors darkened for a light background, each worked out once: the bars'
 * colors on light are worked out again each time their drawing is laid out
 * anew, every frame while a channel opens, closes or grows. Keyed by the color
 * alone, the same color always comes out the same; cleared once it holds more
 * than any band draws with.
 */
const darkened = new Map<number, number>()
const DARKENED_MOST = 4096

/** A color that stands out on the tone's background: on a light one, a pale color darkened until it does. */
export function legible(color: number, tone: Tone): number {
  if (tone === 'dark') return color
  const known = darkened.get(color)
  if (known !== undefined) return known
  let c = color
  while (luminance(c) > 0.3) c = mix(c, 0, 0.1)
  if (darkened.size >= DARKENED_MOST) darkened.clear()
  darkened.set(color, c)
  return c
}

/**
 * Claude Code's theme as a tone: a light theme reads light, a dark one dark,
 * and `auto` (Claude Code reads the terminal itself) by `COLORFGBG`, which some
 * terminals set (`15;0`, white on black), else dark, as most terminals are.
 * Its last field that is set is the background, read when it is one of the 16
 * colors: 7 and 9 to 15 light, the rest dark. Anything else (`default`, a color
 * of 256, `0x0f`) is no reading.
 */
export function toneOf(theme: unknown, colorfgbg?: string): Tone {
  if (typeof theme === 'string' && theme.startsWith('light')) return 'light'
  if (typeof theme === 'string' && theme.startsWith('dark')) return 'dark'
  const background = backgroundOf(colorfgbg)
  return background === 7 || (background !== undefined && background >= 9) ? 'light' : 'dark'
}

/** `COLORFGBG`'s background, when its last field that is set is one of the 16 colors; else none. */
export function backgroundOf(colorfgbg?: string): number | undefined {
  const field = colorfgbg?.split(';').findLast(f => f !== '')
  const background = field !== undefined && /^\d+$/.test(field) ? Number(field) : undefined
  return background !== undefined && background <= 15 ? background : undefined
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
export function instrumentColor(x: number): number {
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

export const ERROR = 0xef4444
/** The vamp's amber: the color of waiting on the person, and of a meter getting full. */
export const CUE = 0xf59e0b
export const LEGEND_GRAY = 0x9ca3af

/** Where the meter turns amber and red, as a share of the way to auto-compact. */
const AMBER_AT = 0.7
const RED_AT = 0.9

/** The meter's color at `share` of the way to auto-compact: `below` until it turns amber, then amber, then red. */
export const meterColor = (share: number, below: number): number => (share >= RED_AT ? ERROR : share >= AMBER_AT ? CUE : below)

/** The brainwave's violet, on the instrument theme; the others draw it in their own colors. */
const MIND = 0xa78bfa

/**
 * A theme's ink on a tone's background: every color the drawings take from
 * the theme, each made to stand out on the background. `inkOf` works it out
 * once for each theme and tone.
 */
export type Ink = {
  readonly tone: Tone
  /** The background, which colors fade into. */
  readonly ground: number
  /** A bar's color at height `y`, 0 to 1, for a bar of its own color `tint`; its peak cap's; its floor's. */
  bar(y: number, tint: number): number
  peak(tint: number): number
  floor(tint: number): number
  /** The theme's colors along a swatch, at `x`, 0 to 1: up the bars, or the instrument theme's across its instruments. */
  ramp(x: number): number
  /** A tool's name over its instrument's band, as strong as `strength`, faded into the background. */
  name(source: SourceId, strength: number): number
  /** An instrument's name in the legend. */
  legend(source: SourceId): number
  /** The brainwave's color. */
  readonly mind: number
  /** The amber the bars turn while the person is waited on, and the red after an error. */
  readonly cue: number
  readonly error: number
  /** `color` made to stand out on the background, faded into it but for `s`. */
  faded(color: number, s: number): number
}

/** The inks worked out so far, by tone and theme: a theme's ink is the same each time. */
const inks: Record<Tone, Map<VizTheme, Ink>> = { dark: new Map(), light: new Map() }

/**
 * A theme's ink on a tone's background. The instrument theme colors each
 * tool's name, and the legend, in its instrument's color, and the brainwave
 * violet; the others color the names as their peak caps, the legend gray, and
 * the brainwave high on their bars.
 */
export function inkOf(theme: VizTheme, tone: Tone): Ink {
  const known = inks[tone].get(theme)
  if (known !== undefined) return known
  const palette = paletteOf(theme, tone)
  const ground = GROUND[tone]
  const isInstrument = theme === 'instrument'
  const names = SOURCES.map(s => (isInstrument ? legible(s.color, tone) : palette.peak(0)))
  const legends = SOURCES.map(s => legible(isInstrument ? s.color : LEGEND_GRAY, tone))
  const ink: Ink = {
    tone,
    ground,
    bar: palette.bar,
    peak: palette.peak,
    floor: palette.floor,
    ramp: x => palette.bar(isInstrument ? 1 : x, instrumentColor(x)),
    name: (source, strength) => mix(ground, names[INDEX[source]]!, strength),
    legend: source => legends[INDEX[source]]!,
    mind: isInstrument ? legible(MIND, tone) : palette.bar(0.8, 0),
    cue: legible(CUE, tone),
    error: legible(ERROR, tone),
    faded: (color, s) => mix(ground, legible(color, tone), s),
  }
  inks[tone].set(theme, ink)
  return ink
}
