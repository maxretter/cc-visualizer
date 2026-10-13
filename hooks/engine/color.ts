// The colors: each theme's palette, the background a tone stands for, and how
// a color is made to stand out on it, light or dark.

import type { VizTheme } from '../../types'
import { bump } from './math'
import { SOURCES } from './sources'

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
export function paletteOf(theme: VizTheme, tone: Tone): Palette {
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
export const AMBER_AT = 0.7
export const RED_AT = 0.9
