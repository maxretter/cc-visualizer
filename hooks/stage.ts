// The session the hooks share: the music, the drawings its frames repaint,
// and what the person has set. No `$`: register.tsx reads the world into it
// and runs the frames, and music.ts plays on it.

import type { Layout } from './engine/bars'
import { Board } from './engine/board'
import type { Tone } from './engine/color'
import { Ensemble } from './engine/ensemble'
import { Spectrum } from './engine/spectrum'
import { trail } from './engine/trail'
import { DEFAULTS, isAmbient, pace, percentOf, toneFor } from './viz'
import type { Backdrop, Measured, Pace, Prefs } from './viz'

/**
 * A drawing the frames repaint: its board (the bars, and the subagents'
 * channels where they fit), the raster of tool names beside a mini one, and
 * the legend under the pane's, which follows the bars as channels come and go.
 */
export type Site = {
  requestId: string
  key: string
  board: Board
  labels: boolean
  names?: { key: string; columns: number; rows: number }
  legend?: string
  /** While the engine refuses its frames (a dialog took its place): when to try again, on the music's clock. */
  retryAt?: number
  /** The cells last sent, by key: a frame the same as them changes nothing on screen, and is not sent. */
  sent: Map<string, string>
}

type Mount = { layout?: Layout; labels?: boolean; names?: Site['names']; legend?: string }

export class Stage {
  // The animation is the module's own: a reload starts it from silence. The
  // main loop plays on the spectrum, each subagent on its own voice.
  readonly spectrum = new Spectrum()
  readonly ensemble = new Ensemble()
  readonly sites = new Map<string, Site>()
  // The context window's size, and where auto-compact runs in it (1 when it is off).
  windowSize: number | undefined
  limit = 1
  // What the person has set with /viz: the one copy, which the atoms publish
  // for the drawings and the store keeps across sessions.
  prefs: Prefs = DEFAULTS
  // What the terminal's background is read from, and the tone every drawing paints for.
  backdrop: Backdrop = {}
  tone: Tone = 'dark'
  // Whether Claude is working, as the prompt's band and hint line are told.
  isWorking = false
  // The prompt's column less the band's five, as the band above is told it:
  // narrower beside a docked pane. The hint line is told only the screen's.
  bodyColumns: number | undefined
  // The subagent whose transcript the person has open, as the band above and
  // the pane are told it; none for the main conversation's. The hint line is
  // not told it, and the band below draws for what the band above was last told.
  viewed: string | undefined
  // Runs the frames until the music stops and the bars have fallen; made by
  // session.start, whose `$` the frames draw through.
  wake = () => {}
  // Starts the idle show on a drawing that stays up, if nothing plays yet.
  rest = () => {}

  /** `pane`: the pane's id, its drawing's among the sites. */
  constructor(private readonly pane: string) {}

  retone() {
    this.tone = toneFor(this.prefs.ground, this.backdrop)
  }

  drawn() {
    return { hasPane: this.sites.has(this.pane), hasBand: [...this.sites.keys()].some(id => id !== this.pane) }
  }

  // The subagent in view while it is on stage, which the drawings put in focus;
  // else the one whose transcript the demo has opened.
  inView() {
    return this.ensemble.find(this.viewed) ?? this.ensemble.find(this.spectrum.demoView)
  }

  measured(context: Measured) {
    this.windowSize = context.window
    this.limit = context.limit
    return context
  }

  // The context measured now, not at the next response: the meter moves there
  // on a drawing that shows, and is simply there on the next one.
  remeasured(context: Measured) {
    const isShown = this.sites.size > 0
    this.spectrum.measure(percentOf(this.measured(context)), this.limit, !isShown)
    if (isShown) this.wake()
  }

  // A drawing of the same key and size keeps its bars where they stood; one
  // resized plays on as it stood, laid out anew. One drawn again while a
  // dialog covers it is still held: the dialog may show it as it was, so the
  // frames go on trying until one lands.
  mount(requestId: string, key: string, columns: number, rows: number, extra: Mount = {}): Site {
    const had = this.sites.get(requestId)
    const isSame = had?.key === key && had.board.columns === columns && had.board.rows === rows
    const board = isSame ? had.board : had?.key === key ? had.board.resize(columns, rows, extra.layout) : new Board(columns, rows, extra.layout)
    const site = {
      requestId,
      key,
      board,
      labels: extra.labels ?? false,
      names: extra.names,
      legend: extra.legend,
      retryAt: had?.retryAt,
      sent: new Map<string, string>(),
    }
    this.sites.set(requestId, site)
    this.rest()
    return site
  }

  /**
   * A frame, `elapsed` after the last: the music moves on, and each drawing
   * not held is painted and handed to `blit`. What pace the frames run at now.
   */
  frame(elapsed: number, blit: (site: Site, key: string, cells: string) => void): Pace {
    const { spectrum, ensemble, sites, prefs, tone } = this
    // No idle show while a subagent works, though the main loop rests.
    spectrum.ambient = isAmbient(prefs, this.drawn()) && ensemble.isCalm()
    spectrum.step(elapsed)
    ensemble.step(elapsed)
    const focus = this.inView()
    for (const site of sites.values()) site.board.step(spectrum, ensemble, focus)
    for (const site of sites.values()) {
      if (site.retryAt !== undefined && spectrum.now < site.retryAt) continue
      blit(site, site.key, site.board.paint(prefs.theme, spectrum, ensemble, site.labels, tone, focus))
      if (site.names) blit(site, site.names.key, trail(spectrum, prefs.theme, site.names.columns, site.names.rows, tone, ensemble, focus))
      if (site.legend) blit(site, site.legend, site.board.legend(prefs.theme, tone))
    }
    return pace({
      isCalm: spectrum.isCalm() && ensemble.isCalm(),
      isAmbient: spectrum.ambient,
      isResting: spectrum.isResting(),
      isQuiet: spectrum.isQuiet(),
      isSettled: [...sites.values()].every(site => site.board.isSettled()),
      isGlinting: spectrum.glint() !== undefined && spectrum.gauge > 0,
      isHeld: [...sites.values()].some(site => site.retryAt !== undefined),
    })
  }
}
