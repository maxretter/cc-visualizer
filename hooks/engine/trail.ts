// The trail beside the mini spectrum: the latest tools' names, newest at the
// right edge, with the subagents at work.

import { LEGEND_GRAY } from './color'
import type { Ink } from './color'
import { blank, pack, spinnerAt, write } from './cells'
import type { Spectrum } from './spectrum'
import { mainVoice } from './ensemble'
import type { Ensemble, Voice } from './ensemble'
import { callName, nameColorOf, statusName, thinkingName, voiceName } from './names'
import type { Named } from './names'

/**
 * The latest tools' names along the bottom row, newest at the right edge
 * (beside a mini spectrum), a spinner before each one still running; the
 * subagents of the `ensemble` next to the main loop's thinking, each in its
 * color; the rest in `ink`.
 *
 * With a subagent in `focus`, which the mini spectrum plays, the voices alone:
 * it first, at the right edge, then the main loop's, then the others.
 */
export function trail(spectrum: Spectrum, ink: Ink, columns: number, rows: number, ensemble?: Ensemble, focus?: Voice): string {
  const words = blank(columns * rows)
  const row = rows - 1
  const dot = ink.faded(LEGEND_GRAY, 0.6)
  const others = (ensemble?.voices ?? []).filter(voice => voice !== focus)
  const calls = spectrum.calls.map(call => callName(spectrum, call)).reverse()
  const names = (
    focus === undefined
      ? [statusName(spectrum), thinkingName(spectrum), ...others.map(voiceName), ...calls]
      : [focus, mainVoice(spectrum), ...others].map(voiceName)
  ).filter((name): name is Named => name !== undefined)
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
    write(words, columns, row, end - text.length, text, nameColorOf(ink, name, strength))
    end -= text.length
    if (spin > 0) {
      const cell = (row * columns + end - 2) * 3
      words[cell] = spinnerAt(spectrum.now)
      words[cell + 1] = nameColorOf(ink, name, 1)
      end -= spin
    }
    placed += 1
  }
  return pack(words)
}
