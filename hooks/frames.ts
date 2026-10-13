// The frames that repaint the stage's drawings: the timer that runs them at
// the pace the music wants, the watchdog beside it, and whether the music
// plays, as the drawings are told. No `$`: each session start hands them the
// world they reach through it (`bind`), and the stage wakes them and rests them.

import type { RasterBlitArgs, Timer, UiBlitResult } from 'claude-code'

import { FRAME_MS } from './engine/math'
import type { Site, Stage } from './stage'
import { isAmbient } from './viz'

/** How long between tries at a drawing whose frames the engine refuses, and so between frames while every drawing is refused. */
const RETRY = 500
/** How often the watchdog looks for a new frame: four periods of the slowest the frames run at. */
const WATCH = 2_000
/** How many looks the watchdog may miss while frames are drawn before its own period counts as refused. */
const MISSED = 3

/** What the frames reach the world through: the session start's `$`, and where it draws. */
export type World = {
  /** Whether the session draws in a terminal, the one place the drawings go. */
  isTerminal: boolean
  /** `$.clock.every`: calls `fn` every `ms` until cancelled, or until a period is refused. */
  every: (ms: number, fn: () => void) => Timer
  /** `$.clock.now`. */
  now: () => Promise<number>
  /** `$.ui.blit`: a drawing's next cells, or why the engine refused them. */
  blit: (args: RasterBlitArgs) => Promise<UiBlitResult>
  /** Tells the drawings whether the music plays: `isAwake`, as it stands when the write lands. */
  tell: () => void
}

export class Frames {
  // Whether the music plays, as `isPlaying` tells the drawings: the frames run
  // at the full rate, or will once there is a drawing to play on. Each write
  // of it writes this as it stands then, so the last to land is right.
  isAwake = false
  // What the frames reach the world through: the latest session start's,
  // bound before the stage can wake them.
  private world!: World
  private ticker: Timer | undefined
  private tempo = FRAME_MS
  // Which ticker's ticks count (not one replaced or stopped, still in flight),
  // and when the last frame was: none after a stop, so the music's clock
  // stands still while nothing plays.
  private ticks = 0
  private last: number | undefined
  // The ticker whose tick is still reading the clock: its next ticks are let
  // go until it has, so a busy host's ticks never pile up and land in a burst.
  private reading: number | undefined
  // The frames drawn, and how many there were when the watchdog last looked.
  private count = 0
  private watched = 0
  private watchdog: Timer | undefined
  // A frame failed: the frames wait for the next sound, not the idle show.
  private hasFailed = false

  constructor(private readonly stage: Stage) {}

  /** The frames reach the world through `world` from now on. */
  bind(world: World) {
    this.world = world
  }

  /** Runs the frames until the music stops and the bars have fallen. */
  wake() {
    const { sites, prefs } = this.stage
    if (!this.world.isTerminal || (prefs.mode === 'off' && sites.size === 0)) return
    this.hasFailed = false
    if (!this.isAwake) {
      this.isAwake = true
      this.world.tell()
    }
    // No drawing yet: in auto, `isPlaying` brings the band up, and the frames start as it mounts.
    if (sites.size > 0) this.run(FRAME_MS)
  }

  /** Starts the idle show on a drawing that stays up, if nothing plays yet. */
  rest() {
    const { stage } = this
    if (this.ticker !== undefined || stage.sites.size === 0 || this.hasFailed) return
    // The music woke before there was a drawing to play on: it plays on this one.
    if (this.isAwake) this.run(FRAME_MS)
    else if (isAmbient(stage.prefs, stage.drawn())) this.run(stage.spectrum.showMs())
  }

  // The music has stopped: in auto, the band steps aside.
  private rested() {
    if (!this.isAwake) return
    this.isAwake = false
    this.world.tell()
  }

  // A refused frame holds the drawing rather than dropping it: a dialog takes
  // the band off screen, and the engine shows it again as it was, without a
  // new render, so only a frame that lands brings it back to life.
  private hold(site: Site) {
    site.retryAt = this.stage.spectrum.now + RETRY
    // None of what it was sent may be on screen: the next try sends it all.
    site.sent.clear()
  }

  private readonly blit = (site: Site, key: string, cells: string) => {
    if (site.sent.get(key) === cells) return
    site.sent.set(key, cells)
    void this.world.blit({ requestId: site.requestId, key, cells }).then(
      sent => {
        if (sent.deny !== undefined) {
          this.hold(site)
        } else if (site.retryAt !== undefined) {
          site.retryAt = undefined
          // A frame landed once the dialog went: the frames keep their own pace again at once.
          if (this.ticker !== undefined && this.tempo === RETRY) this.run(FRAME_MS)
        }
      },
      () => this.hold(site),
    )
  }

  // The ticker, `ms` apart from now on: the ticks of the one before no longer count.
  private arm(ms: number) {
    this.ticker?.cancel()
    this.tempo = ms
    const own = ++this.ticks
    this.ticker = this.world.every(ms, () => this.tick(own))
  }

  private run(ms: number) {
    if (this.ticker !== undefined && this.tempo === ms) return
    if (this.ticker === undefined) {
      this.last = undefined
      this.watch()
    }
    this.arm(ms)
  }

  private stop() {
    this.ticker?.cancel()
    this.ticker = undefined
    this.watchdog?.cancel()
    this.watchdog = undefined
    this.ticks += 1
  }

  // A refused period ends a ticker without a word, and the band would freeze
  // as it stood: a slow timer beside it looks now and then, and starts it
  // again when no frame has come since the last look.
  private watch() {
    this.watchdog?.cancel()
    this.watched = this.count
    this.watchdog = this.world.every(WATCH, () => {
      if (this.ticker !== undefined && this.count === this.watched) this.arm(this.tempo)
      this.watched = this.count
    })
  }

  // A tick reads the clock and moves the music on by the time since the last
  // frame: ticks come late when the host is busy, and the music keeps time.
  // One that comes while the last still reads the clock is let go.
  private tick(own: number) {
    if (this.reading === own) return
    this.reading = own
    void this.world.now().then(
      now => {
        if (this.reading === own) this.reading = undefined
        if (own !== this.ticks) return
        try {
          const elapsed = this.last === undefined ? this.tempo : now - this.last
          this.last = now
          this.count += 1
          // The watchdog has missed its looks: its own period was refused.
          if (this.count - this.watched > (MISSED * WATCH) / this.tempo) this.watch()
          this.frame(elapsed)
        } catch {
          // A frame that fails would fail at every tick: the frames stop
          // instead, and the next sound tries them again.
          this.stop()
          this.rested()
          this.hasFailed = true
        }
      },
      () => {
        if (this.reading === own) this.reading = undefined
      },
    )
  }

  private frame(elapsed: number) {
    const { stage } = this
    const pacing = stage.frame(elapsed, this.blit)
    if (pacing === 'full') {
      // Something plays again after a show: back to the full rate.
      if (this.tempo !== FRAME_MS) this.wake()
      return
    }
    if (pacing === 'same') return
    if (pacing === 'held') {
      // Every drawing is behind a dialog: a frame only as often as one is
      // tried, whatever plays, until one lands.
      this.run(RETRY)
      return
    }
    if (pacing === 'show') this.run(stage.spectrum.showMs())
    else this.stop()
    this.rested()
  }
}
