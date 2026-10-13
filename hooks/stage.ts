// The session the hooks share: the music, the drawings its frames repaint,
// and what the person has set. No `$`: register.tsx reads the world into it,
// frames.ts runs its frames, and music.ts plays on it.

import type { VizTheme } from '../types'
import type { Layout } from './engine/bars'
import { Board } from './engine/board'
import { inkOf } from './engine/color'
import type { Tone } from './engine/color'
import { Demo } from './engine/demo'
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

/** What runs the frames: frames.ts's, which each session start binds. */
export type Driver = { wake(): void; rest(): void }

/** The columns the engine keeps beside the prompt's own: the band above is told the screen's less these. */
const GUTTER = 5
/** The screen's columns, when the engine does not say. */
const SCREEN = 80

export class Stage {
  // The animation is the module's own: a reload starts it from silence. The
  // main loop plays on the spectrum, each subagent on its own voice.
  readonly spectrum = new Spectrum()
  readonly ensemble = new Ensemble()
  // /viz demo, played on the main spectrum, its subagents joining the ensemble.
  readonly demo = new Demo(this.spectrum, this.ensemble)
  readonly sites = new Map<string, Site>()
  // The context window's size, and where auto-compact runs in it (1 when it is
  // off): unknown until a measure comes with its breakdown, which only a
  // session bound has.
  windowSize: number | undefined
  limit: number | undefined
  // What the person has set with /viz: the one copy, which the atoms publish
  // for the drawings and the store keeps across sessions.
  prefs: Prefs = DEFAULTS
  // What the terminal's background is read from, beside the prefs' ground.
  backdrop: Backdrop = {}
  // Whether Claude is working, as the prompt's band and hint line are told.
  isWorking = false
  // The prompt's column, the screen's less the gutter, as the band above is
  // told it: narrower beside a docked pane. The hint line is told only the screen's.
  bodyColumns: number | undefined
  // The subagent whose transcript the person has open, as the band above and
  // the pane are told it; none for the main conversation's. The hint line is
  // not told it, and the band below draws for what the band above was last told.
  viewed: string | undefined
  // What runs the frames: none until the session starts, and none run.
  private driver: Driver | undefined

  /** `pane`: the pane's id, its drawing's among the sites. */
  constructor(private readonly pane: string) {}

  /** The frames are run by `driver` from now on. */
  bind(driver: Driver) {
    this.driver = driver
  }

  /** Runs the frames until the music stops and the bars have fallen. */
  wake() {
    this.driver?.wake()
  }

  /** Starts the idle show on a drawing that stays up, if nothing plays yet. */
  rest() {
    this.driver?.rest()
  }

  /** The tone every drawing paints for: the one /viz ground set, or as the backdrop reads. */
  get tone(): Tone {
    return toneFor(this.prefs.ground, this.backdrop)
  }

  /** The prompt's column, as the band above was last told it; until it has been, the screen's less the gutter. */
  promptColumns(viewport: { columns: number } | undefined): number {
    return this.bodyColumns ?? (viewport?.columns ?? SCREEN) - GUTTER
  }

  drawn() {
    return { hasPane: this.sites.has(this.pane), hasBand: [...this.sites.keys()].some(id => id !== this.pane) }
  }

  // The subagent in view while it is on stage, which the drawings put in focus;
  // else the one whose transcript the demo has opened.
  inView() {
    return this.ensemble.find(this.viewed) ?? this.ensemble.find(this.demo.view)
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
   * What a drawing paints now, in `theme` (the one set, unless a render read
   * another), by key, in the order a frame sends them: its board, the tool
   * names beside a mini one, and the legend under the pane's. Its first
   * render and each frame after paint the same way.
   */
  cells(site: Site, theme: VizTheme = this.prefs.theme): Map<string, string> {
    const { spectrum, ensemble } = this
    const ink = inkOf(theme, this.tone)
    const focus = this.inView()
    const cells = new Map([[site.key, site.board.paint(ink, spectrum, ensemble, site.labels, focus)]])
    if (site.names) cells.set(site.names.key, trail(spectrum, ink, site.names.columns, site.names.rows, ensemble, focus))
    if (site.legend) cells.set(site.legend, site.board.legend(ink))
    return cells
  }

  /**
   * A frame, `elapsed` after the last: the music moves on, and each drawing
   * not held is painted and handed to `blit`. What pace the frames run at now.
   */
  frame(elapsed: number, blit: (site: Site, key: string, cells: string) => void): Pace {
    const { spectrum, ensemble, sites, prefs } = this
    // No idle show while a subagent works, though the main loop rests.
    spectrum.ambient = isAmbient(prefs, this.drawn()) && ensemble.isCalm()
    spectrum.step(elapsed, this.demo)
    ensemble.step(elapsed)
    const focus = this.inView()
    for (const site of sites.values()) site.board.step(spectrum, ensemble, focus)
    for (const site of sites.values()) {
      if (site.retryAt !== undefined && spectrum.now < site.retryAt) continue
      for (const [key, cells] of this.cells(site)) blit(site, key, cells)
    }
    const held = [...sites.values()].filter(site => site.retryAt !== undefined).length
    return pace({
      isCalm: spectrum.isCalm() && !this.demo.isPlaying && ensemble.isStill(),
      isAmbient: spectrum.ambient,
      isResting: spectrum.isResting(),
      isQuiet: spectrum.isQuiet(),
      isSettled: [...sites.values()].every(site => site.board.isSettled()),
      isGlinting: spectrum.glint() !== undefined && spectrum.gauge > 0,
      isHeld: held > 0,
      isHidden: held > 0 && held === sites.size,
    })
  }
}
