// `/viz doctor`'s swatches: what the band draws with, to hold up against the
// terminal.

import { SOURCES } from './sources'
import { CUE, LEGEND_GRAY, legible, luminance } from './color'
import type { Ink } from './color'
import { blank, DEFAULT, FULL, pack, SPACE, write } from './cells'

/** The checks `/viz doctor` draws, a row each. */
export const DOCTOR_ROWS = ['ramp', 'colors', 'ground', 'fade', 'glyphs'] as const

/**
 * `/viz doctor`'s swatches, `columns` wide, in `ink`, a row for each check:
 * the theme's colors as a ramp (smooth where the terminal shows 24-bit color,
 * banded where it does not); the instruments' colors; the background the
 * visualizer expects beside the terminal's own, which should look the same; a
 * fade into it, whose faint end should vanish; and the glyphs the band draws
 * with, which the font must have.
 */
export function swatches(ink: Ink, columns: number): string {
  const words = blank(columns * DOCTOR_ROWS.length)
  const put = (row: number, column: number, glyph: number, fg: number, bg = DEFAULT) => {
    const i = (row * columns + column) * 3
    words[i] = glyph
    words[i + 1] = fg
    words[i + 2] = bg
  }
  const gray = legible(LEGEND_GRAY, ink.tone)
  const half = Math.floor(columns / 2)
  const width = Math.floor(columns / SOURCES.length)
  for (let c = 0; c < columns; c++) {
    const x = c / Math.max(1, columns - 1)
    put(0, c, FULL, ink.ramp(x))
    put(3, c, FULL, ink.faded(CUE, x))
  }
  SOURCES.forEach((source, s) => {
    const bg = legible(source.color, ink.tone)
    const fg = luminance(bg) > 0.3 ? 0x000000 : 0xffffff
    for (let c = 0; c < width; c++) put(1, s * width + c, source.label.charCodeAt(c - 1) || SPACE, fg, bg)
  })
  for (let c = 0; c < columns; c++) put(2, c, SPACE, gray, c < half ? DEFAULT : ink.ground)
  write(words, columns, 2, 1, 'your terminal', gray)
  write(words, columns, 2, half + 1, 'what is expected', gray)
  write(words, columns, 4, 0, '▁▂▃▄▅▆▇█ ▔─▁ ⣿⡇⠿⠛⣀⠉ ░░ ⠋⠙⠹⠸⠼⠴ ×·', gray)
  return pack(words)
}
