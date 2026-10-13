// The subagents' channels beside the main bars: each a small spectrum of its
// own voice, opening as its agent starts and closing once it is done.

import type { VizTheme } from '../../types'
import { GROUND, LEGEND_GRAY, legible, mix } from './color'
import type { Tone } from './color'
import { SPACE, write } from './cells'
import type { Ensemble, Voice } from './ensemble'
import { focusLead, voiceLabel } from './names'
import { Bars } from './bars'
import type { Layout } from './bars'

/** A channel's width: the gap before it, and its bars, one an instrument. */
export const CHANNEL = 17
const CHANNEL_GAP = 2
const CHANNEL_LAYOUT: Layout = { width: 1, gap: 1 }

/** How long a channel takes to open, fading in as it does, or to close once its voice has left. */
const OPEN = 400
/** How long a channel takes to grow into the room the main bars give up as its subagent comes into focus, or to shrink back. */
const GROW = 500

/** How many channels fit beside a main spectrum in `columns`: it keeps half of them, and at least 32. */
export const channelsFit = (columns: number): number => Math.max(0, Math.floor((columns - Math.max(32, Math.ceil(columns / 2))) / CHANNEL))

/** A channel's open share as its width shows it: easing in and out of the move. */
const smooth = (t: number) => t * t * (3 - 2 * t)

/**
 * A subagent's channel: its voice, its bars, how far open it is, how far
 * faded in, and how far grown into the room the main bars give up while it is
 * in focus. One whose voice has left closes.
 */
type Seat = { voice: Voice; bars: Bars; open: number; shown: number; grow: number; isLeaving: boolean }

/** Bars this wide or wider are two cells a bar, and name each tool over its band; narrower, a channel's label names who plays. */
export const WIDE = 30

/** A channel's bars laid out for `columns`: two cells a bar once it has grown wide. */
const channelLayout = (columns: number): Layout => (columns >= WIDE ? { width: 2, gap: 1 } : CHANNEL_LAYOUT)

/**
 * The subagents' channels, side by side, up to `capacity` of them and `rows`
 * high: each a small spectrum of its own voice, its name and what it is doing
 * over it. A channel opens as its agent starts, and once the agent has said
 * how it went, closes the way it opened, those after it sliding over. One
 * waiting for a channel opens at the end as the first to finish closes, so
 * the room they take holds; how many still wait shows at the right edge.
 * Those on stage when the channels are made (a reload, a resize) are open at once.
 *
 * The channel of the subagent in focus grows into the room the main bars give
 * up, its bars widening as they stand, its name leading the labels once it is
 * wide; it shrinks back the same way once the subagent is out of focus.
 */
export class Channels {
  private readonly seats: Seat[] = []
  private isFresh = true

  constructor(
    readonly capacity: number,
    readonly rows: number,
  ) {}

  /** The columns a channel takes now: as much of it as is open, and all it has grown by. */
  private widthOf(seat: Seat): number {
    return Math.round(CHANNEL * smooth(seat.open)) + seat.bars.columns + CHANNEL_GAP - CHANNEL
  }

  /** The columns the channels take now, as they open and close, and grow and shrink. */
  get width(): number {
    return this.seats.reduce((sum, seat) => sum + this.widthOf(seat), 0)
  }

  /** Whether `voice` has a channel here that is staying. */
  has(voice: Voice): boolean {
    return this.seats.some(seat => seat.voice === voice && !seat.isLeaving)
  }

  /** Voices gone leave their channels; those waiting open new ones at the end, while the channels staying leave room. */
  private seat(ensemble: Ensemble, focus?: Voice) {
    for (const seat of this.seats) if (!ensemble.voices.includes(seat.voice)) seat.isLeaving = true
    let staying = this.seats.filter(seat => !seat.isLeaving).length
    for (const voice of ensemble.voices) {
      if (this.seats.some(seat => seat.voice === voice)) continue
      if (staying >= this.capacity) break
      const open = this.isFresh ? 1 : 0
      // Made with the subagent in focus on stage, its channel has grown already.
      const grow = this.isFresh && voice === focus ? 1 : 0
      this.seats.push({ voice, bars: new Bars(CHANNEL - CHANNEL_GAP, this.rows, CHANNEL_LAYOUT), open, shown: open, grow, isLeaving: false })
      staying += 1
    }
    this.isFresh = false
  }

  /**
   * Moves the channels on by `ms`: open and close them, grow the one of the
   * subagent in `focus` toward `room` (the columns the channels may take in
   * all) and shrink any other back, and move their bars toward their voices' spectra.
   */
  step(ensemble: Ensemble, ms: number, room: number, focus?: Voice) {
    this.seat(ensemble, focus)
    const by = ms / OPEN
    const grows = ms / GROW
    for (const seat of this.seats) {
      seat.open = seat.isLeaving ? Math.max(0, seat.open - by) : Math.min(1, seat.open + by)
      seat.shown = Math.min(1, seat.shown + by)
      seat.grow = seat.voice === focus && !seat.isLeaving ? Math.min(1, seat.grow + grows) : Math.max(0, seat.grow - grows)
    }
    for (let i = this.seats.length - 1; i >= 0; i--) {
      const seat = this.seats[i]!
      if (seat.isLeaving && seat.open === 0 && seat.grow === 0) this.seats.splice(i, 1)
    }
    // What the channels leave of the room, ungrown: the one in focus grows into it.
    const give = Math.max(0, room - this.seats.reduce((sum, seat) => sum + Math.round(CHANNEL * smooth(seat.open)), 0))
    for (const seat of this.seats) {
      const columns = CHANNEL - CHANNEL_GAP + Math.round(give * smooth(seat.grow))
      if (columns !== seat.bars.columns) seat.bars = seat.bars.resize(columns, channelLayout(columns))
      seat.bars.step(seat.voice.spectrum)
    }
  }

  /** Every channel open, grown or not, its bars on the floor; or none. */
  isSettled(): boolean {
    return this.seats.every(
      seat => !seat.isLeaving && seat.open === 1 && seat.shown === 1 && (seat.grow === 0 || seat.grow === 1) && seat.bars.isSettled(),
    )
  }

  /**
   * Draws the channels into `words`, a drawing `columns` wide, from column
   * `left`: each as much of it as is open, faded in as it opens; one closing
   * still shows how its agent's work went as it shrinks. One grown wide is
   * labeled as the main bars are, its name leading.
   */
  draw(words: Uint32Array, columns: number, left: number, theme: VizTheme, ensemble: Ensemble, tone: Tone) {
    const { rows } = this
    const waiting = ensemble.voices.filter(voice => !this.seats.some(seat => seat.voice === voice)).length
    const more = waiting > 0 ? `+${waiting}` : ''
    let at = left
    this.seats.forEach((seat, i) => {
      const shows = Math.min(this.widthOf(seat), columns - at)
      const alpha = seat.shown
      if (alpha > 0 && shows > 0) {
        // Straight into the drawing's cells, blank here, after the gap: as much of the channel as is open.
        const width = seat.bars.columns
        const isWide = width >= WIDE
        const into = { words, columns, left: at + CHANNEL_GAP, right: at + shows }
        seat.bars.draw(into, theme, seat.voice.spectrum, isWide, tone, isWide ? { lead: focusLead(seat.voice) } : {})
        if (alpha < 1) {
          for (let r = 0; r < rows; r++) {
            for (let c = into.left; c < into.right; c++) {
              const cell = (r * columns + c) * 3
              if (words[cell] !== SPACE) words[cell + 1] = mix(GROUND[tone], words[cell + 1]!, alpha)
            }
          }
        }
        if (!isWide) {
          const room = i === this.seats.length - 1 && more !== '' ? width - more.length - 1 : width
          voiceLabel(words, columns, into.left, room, seat.voice, alpha, theme, tone, into.right)
        }
      }
      at += shows
    })
    if (more !== '') write(words, columns, 0, columns - more.length, more, mix(GROUND[tone], legible(LEGEND_GRAY, tone), 0.85))
  }

  /** Under each channel grown wide, its bars' legend, into a row `columns` wide whose channels start at column `left`. */
  legend(words: Uint32Array, columns: number, left: number, theme: VizTheme, tone: Tone) {
    let at = left
    for (const seat of this.seats) {
      const shows = Math.min(this.widthOf(seat), columns - at)
      if (seat.bars.columns >= WIDE && shows > CHANNEL_GAP) {
        seat.bars.drawLegend({ words, columns, left: at + CHANNEL_GAP, right: at + shows }, theme, tone)
      }
      at += shows
    }
  }

  /**
   * These channels for a drawing resized: up to `capacity` of them and `rows`
   * high, each as far open, faded in and grown as it was, its bars standing as
   * they stood. Those closing close on; of the rest, those past the capacity
   * wait for room again.
   */
  resize(capacity: number, rows: number): Channels {
    const channels = new Channels(capacity, rows)
    let staying = 0
    for (const seat of this.seats) {
      if (!seat.isLeaving && staying++ >= capacity) continue
      const { columns } = seat.bars
      channels.seats.push({ ...seat, bars: rows === seat.bars.rows ? seat.bars : seat.bars.resize(columns, channelLayout(columns), rows) })
    }
    channels.isFresh = this.isFresh
    return channels
  }
}
