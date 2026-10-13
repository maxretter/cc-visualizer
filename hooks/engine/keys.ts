// The person's typing, played on the spectrum: each key a note where it sits
// on the keyboard, a paste or a burst of keys a run of them, and the caret
// moving a faint tick.

import { bump, fade } from './math'
import { placeOf } from './sources'

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

/** A typed key's note on the spectrum: where it plays, from when, how loud, and how wide. */
type Note = { x: number; at: number; energy: number; sigma: number }

/** The notes the person's typing plays on a spectrum, still ringing or still to come in a run. */
export class Keys {
  private readonly notes: Note[] = []

  /**
   * The person typed `text` into the prompt `now`: each character a note where
   * its key sits, louder for a capital, a space a soft breath across the
   * middle, and a paste or a burst of keys a run of them. With `isErased`, the
   * text was deleted: quieter notes, the run going backward.
   */
  typed(now: number, text: string, isErased = false) {
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
      const at = now + n * RUN
      const loud = isErased ? 0.5 : 1
      if (ch.trim() === '') this.notes.push({ x: 0.5, at, energy: 0.3 * loud, sigma: 0.14 })
      else this.notes.push({ x: placeOf(ch), at, energy: (ch === ch.toLowerCase() ? 0.7 : 0.95) * loud, sigma: 0.03 })
    }
  }

  /**
   * The person edited the prompt's `text` `now`, putting `inputText` in for
   * the span from `start` to `end`: what went in plays, else what went out,
   * else the caret only moved.
   */
  edited(now: number, text: string, start: number, end: number, inputText: string) {
    const erased = text.slice(start, end)
    if (inputText !== '') this.typed(now, inputText)
    else if (erased !== '') this.typed(now, erased, true)
    else this.moved(now, text.length === 0 ? 0.5 : start / text.length)
  }

  /** The prompt's caret moved `now`, to `x` of the way through the text: a faint tick there. */
  private moved(now: number, x: number) {
    this.notes.push({ x: 0.06 + 0.88 * Math.max(0, Math.min(1, x)), at: now, energy: 0.25, sigma: 0.02 })
  }

  /** Moves them on to `now`, by `ms`: each rings from when it comes in, and dies away. */
  step(now: number, ms: number) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const note = this.notes[i]!
      if (note.at > now) continue
      note.energy *= fade(NOTE, Math.min(ms, now - note.at))
      if (note.energy < 0.01) this.notes.splice(i, 1)
    }
  }

  /** `energy` at a point of the spectrum `now`, with the energy of each note come in by then added to it in turn. */
  addAt(now: number, x: number, energy: number): number {
    for (const note of this.notes) if (note.at <= now) energy += note.energy * bump(x - note.x, note.sigma)
    return energy
  }

  /** None ringing, and none still to come. */
  isCalm(): boolean {
    return this.notes.length === 0
  }
}
