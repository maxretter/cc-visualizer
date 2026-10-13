// A whole drawing: the main spectrum's bars and, at their right, the
// subagents' channels, as many as fit.

import type { VizTheme } from '../../types'
import type { Tone } from './color'
import { blank, pack } from './cells'
import type { Canvas } from './cells'
import type { Spectrum } from './spectrum'
import { mainVoice } from './ensemble'
import type { Ensemble, Voice } from './ensemble'
import { focusLead, voiceLabel } from './names'
import { Bars } from './bars'
import type { Layout } from './bars'
import { CHANNEL, Channels, channelsFit, WIDE } from './channels'

/** The fewest columns the main bars narrow to while a subagent in focus grows into their room: a channel's. */
const MAIN_LEAST = CHANNEL

/**
 * A drawing's bars: the main spectrum's and, at their right, the subagents'
 * channels, as many as fit. The main bars narrow as a channel opens and widen
 * as one closes, standing as they stood, so the room moves smoothly.
 *
 * As a subagent comes into `focus` (its transcript is the one in view), its
 * channel grows to take the main bars' room while they narrow to a channel's
 * width, labeled `main`, the two together; out of focus, each goes back. The
 * context meter stays at the main bars' right edge. A subagent in focus with
 * no channel here to grow (beside a mini strip, on a band too narrow for
 * channels, or waiting for one) plays on the main bars instead, its name leading their labels.
 *
 * It paints every frame into the same cells, and its legend into the same row:
 * each is blanked and drawn again, the bars and channels straight into it, so
 * a frame leaves nothing behind but the cells it hands on.
 */
export class Board {
  /** The main spectrum's bars, as wide as the channels leave them. */
  bars: Bars
  channels: Channels
  private readonly layout: Layout
  /** The cells each frame paints, and the blank they start from; the same for the legend's row. */
  private readonly cells: Canvas
  private readonly blank: Uint32Array
  private readonly legendRow: Canvas
  private readonly blankRow: Uint32Array

  constructor(
    readonly columns: number,
    readonly rows: number,
    layout?: Layout,
  ) {
    this.layout = layout ?? { width: columns >= WIDE ? 2 : 1, gap: 1 }
    this.bars = new Bars(columns, rows, this.layout)
    this.channels = new Channels(channelsFit(columns), rows)
    this.blank = blank(columns * rows)
    this.cells = { words: this.blank.slice(), columns, left: 0, right: columns }
    this.blankRow = blank(columns)
    this.legendRow = { words: this.blankRow.slice(), columns, left: 0, right: columns }
  }

  /**
   * This board `columns` wide and `rows` high, laid out as `layout` says,
   * playing on as it stands: its bars at their heights, its channels as far
   * open and grown as they are, those that no longer fit waiting for room.
   */
  resize(columns: number, rows: number, layout?: Layout): Board {
    const board = new Board(columns, rows, layout)
    board.bars = this.bars.resize(columns, board.layout, rows)
    board.channels = this.channels.resize(board.channels.capacity, rows)
    return board
  }

  /** The subagent in focus when it has no channel here to grow into: it plays on the main bars. */
  private stray(focus?: Voice): Voice | undefined {
    return focus !== undefined && !this.channels.has(focus) ? focus : undefined
  }

  /**
   * Moves the bars toward the spectrum and each channel's toward its voice, the
   * main bars making room for the channels as they are now, the one in focus grown.
   */
  step(spectrum: Spectrum, ensemble: Ensemble, focus?: Voice) {
    this.channels.step(ensemble, spectrum.dt, this.columns - MAIN_LEAST, focus)
    const main = Math.max(Math.min(this.columns, MAIN_LEAST), this.columns - this.channels.width)
    if (main !== this.bars.columns) this.bars = this.bars.resize(main, { ...this.layout, width: main >= WIDE ? this.layout.width : 1 })
    this.bars.step(this.stray(focus)?.spectrum ?? spectrum)
  }

  /** The bars and channels all at rest: nothing moving, nothing opening, closing, growing or shrinking. */
  isSettled(): boolean {
    return this.bars.isSettled() && this.channels.isSettled()
  }

  /** The whole drawing as Raster cells: the main bars, then the channels. */
  paint(theme: VizTheme, spectrum: Spectrum, ensemble: Ensemble, labels = false, tone: Tone = 'dark', focus?: Voice): string {
    const { columns, cells } = this
    const { words } = cells
    words.set(this.blank)
    const stray = this.stray(focus)
    const look = stray === undefined ? {} : { meter: spectrum, lead: focusLead(stray) }
    // Narrowed for a subagent in focus, the main bars are labeled as a channel is: `main`, and what it is doing.
    const width = this.bars.columns
    const isNarrowed = width < WIDE && width < columns
    cells.right = width
    this.bars.draw(cells, theme, stray?.spectrum ?? spectrum, labels && !isNarrowed, tone, look)
    if (labels && isNarrowed) voiceLabel(words, columns, 0, this.bars.span, mainVoice(spectrum), 1, theme, tone)
    if (width < columns) this.channels.draw(words, columns, width, theme, ensemble, tone)
    return pack(words)
  }

  /** The legend under the main bars and under a channel grown wide, as wide as they are now; nothing under the other channels. */
  legend(theme: VizTheme, tone: Tone = 'dark'): string {
    const row = this.legendRow
    row.words.set(this.blankRow)
    row.right = this.bars.columns
    this.bars.drawLegend(row, theme, tone)
    this.channels.legend(row.words, this.columns, this.bars.columns, theme, tone)
    return pack(row.words)
  }
}
