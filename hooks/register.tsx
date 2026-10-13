// The hooks that reach the world through `$`: the session's start and the
// frames it runs, the context window, Claude Code's settings, the drawings,
// and /viz. The hooks that only play the music are in music.ts, and the
// session they share is stage.ts's. What to do is decided in viz.ts and the
// music in engine/; this reads the world, asks them, and does what they say.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { VizSize, VizTheme } from '../types'
import type { Layout } from './engine/bars'
import { DOCTOR_ROWS, swatches } from './engine/doctor'
import { FRAME_MS } from './engine/math'
import { trail } from './engine/trail'
import { music } from './music'
import { Stage } from './stage'
import type { Site } from './stage'
import {
  DEFAULTS,
  DOCTOR_HINTS,
  HINT,
  PANE_WAITS,
  changes,
  command,
  doctorReport,
  factsOf,
  isAmbient,
  isBandShown,
  measuredFrom,
  percentOf,
  prefsFrom,
  savedOf,
} from './viz'
import type { Measured, Prefs } from './viz'

const PANE = 'viz'
const BAND_ROWS = 5
const PANE_ROWS = 32
const MINI_COLUMNS = 32
const MINI_ROWS = 2
const MINI_LAYOUT: Layout = { width: 1, gap: 1, meter: true }
/** The band's and the pane's bars, the context meter at the right edge. */
const wide = (columns: number): Layout => ({ width: columns >= 30 ? 2 : 1, gap: 1, meter: true })
/** The most columns the tool names beside the mini spectrum take. */
const MINI_NAMES = 56
/** How long between tries at a drawing whose frames the engine refuses. */
const RETRY = 500
/** How long after a setting changes to read it again: by then it has been made, or refused. */
const SETTLED = 100

// The prefs the drawings read, published from the plugin's own copy, and what plays.
const mode = atom({ plugin: 'visualizer', key: 'mode' } as const, DEFAULTS.mode)
const theme = atom({ plugin: 'visualizer', key: 'theme' } as const, DEFAULTS.theme)
const size = atom({ plugin: 'visualizer', key: 'size' } as const, DEFAULTS.size)
const place = atom({ plugin: 'visualizer', key: 'place' } as const, DEFAULTS.place)
const isPlaying = atom({ plugin: 'visualizer', key: 'isPlaying' } as const, false)
const isPaneOpen = atom({ plugin: 'visualizer', key: 'isPaneOpen' } as const, false)

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)))

/** The context window now, with its breakdown: the meter, and where its top is. */
async function measureContext($: EngineInterface): Promise<Measured> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  return measuredFrom(context)
}

/** Claude Code's theme setting, as `/config` shows it: `dark`, `light`, `auto`, or another. */
async function themeOf($: EngineInterface): Promise<unknown> {
  return (await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value
}

/** The prefs, published for the drawings, which redraw as they change. */
async function publish($: EngineInterface, prefs: Prefs) {
  await update($, mode, () => prefs.mode)
  await update($, theme, () => prefs.theme)
  await update($, size, () => prefs.size)
  await update($, place, () => prefs.place)
}

export const register: Register = on => {
  const stage = new Stage(PANE)
  const { spectrum, ensemble, sites } = stage
  let ticker: Timer | undefined
  let tempo = FRAME_MS
  // Which ticker's ticks count (not one replaced or stopped, still in flight),
  // and when the last frame was: none after a stop, so the music's clock
  // stands still while nothing plays.
  let ticks = 0
  let last: number | undefined

  on('session.start', async ($, e, next) => {
    // A refused frame holds the drawing rather than dropping it: a dialog takes
    // the band off screen, and the engine shows it again as it was, without a
    // new render, so only a frame that lands brings it back to life.
    const hold = (site: Site) => {
      site.retryAt = spectrum.now + RETRY
      // None of what it was sent may be on screen: the next try sends it all.
      site.sent.clear()
    }
    const blit = (site: Site, key: string, cells: string) => {
      if (site.sent.get(key) === cells) return
      site.sent.set(key, cells)
      void $.ui.blit({ requestId: site.requestId, key, cells }).then(
        sent => {
          if (sent.deny !== undefined) hold(site)
          else site.retryAt = undefined
        },
        () => hold(site),
      )
    }
    const run = (ms: number) => {
      if (ticker !== undefined && tempo === ms) return
      if (ticker === undefined) last = undefined
      ticker?.cancel()
      tempo = ms
      const own = ++ticks
      ticker = $.clock.every(ms, () => tick(own))
    }
    const stop = () => {
      ticker?.cancel()
      ticker = undefined
      ticks += 1
    }
    // A tick reads the clock and moves the music on by the time since the last
    // frame: ticks come late when the host is busy, and the music keeps time.
    const tick = (own: number) => {
      void $.clock.now().then(
        now => {
          if (own !== ticks) return
          const elapsed = last === undefined ? tempo : now - last
          last = now
          frame(elapsed)
        },
        () => {},
      )
    }
    const frame = (elapsed: number) => {
      const pacing = stage.frame(elapsed, blit)
      if (pacing === 'full') {
        // Something plays again after a show: back to the full rate.
        if (tempo !== FRAME_MS) stage.wake()
        return
      }
      if (pacing === 'same') return
      const wasFull = tempo === FRAME_MS
      if (pacing === 'show') run(spectrum.showMs())
      else stop()
      if (wasFull) void update($, isPlaying, () => false)
    }
    stage.wake = () => {
      if ((ticker !== undefined && tempo === FRAME_MS) || (stage.prefs.mode === 'off' && sites.size === 0)) return
      run(FRAME_MS)
      void update($, isPlaying, () => true)
    }
    stage.rest = () => {
      if (ticker === undefined && isAmbient(stage.prefs, stage.drawn())) run(spectrum.showMs())
    }

    await $.command.register({ name: 'viz', description: 'Music visualizer for what Claude is doing', argumentHint: HINT, immediate: true })
    stage.prefs = prefsFrom(await $.store.get('prefs'))
    await publish($, stage.prefs)
    // The terminal's background, as Claude Code's theme and the terminal tell it.
    stage.backdrop = {
      theme: await themeOf($),
      colorfgbg: await $.env.get('COLORFGBG').catch(() => undefined),
    }
    stage.retone()
    // Playing or not as the frames are now: a reload mid-turn may have woken them already.
    await update($, isPlaying, () => ticker !== undefined && tempo === FRAME_MS)
    // The meter as it stood, after a reload or on a resumed session.
    void measureContext($).then(context => stage.remeasured(context), () => {})
    // The subagents at work through a reload, each back in a channel of its own.
    for (const agent of await $.agent.list().catch(() => [])) {
      // A teammate in a terminal pane of its own, whose id is its address, sends nothing here.
      if (agent.id === agent.teammateId) continue
      const info = { name: agent.name, description: agent.description, type: agent.type }
      if (agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting') ensemble.join(agent.id, info)
      else ensemble.know(agent.id, info)
    }
    if (!ensemble.isCalm()) stage.wake()

    return next(e)
  })

  // Prompts, the response, tool calls and their asks, the ends of turns, subagents.
  music(on, stage)

  // The context window, measured after each turn: the meter at the right edge.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      if (e.context.window !== stage.windowSize) await measureContext($).then(context => stage.measured(context), () => {})
      const percent = percentOf(e.context)
      if (percent !== undefined) {
        spectrum.measure(percent, stage.limit)
        stage.wake()
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The conversation cleared or another resumed: the meter moves to what it
  // holds now, which no response has reported yet.
  on('classic.SessionStart', ($, e, next) => {
    if ((e.source === 'clear' || e.source === 'resume') && e.agent_id === undefined) {
      void measureContext($).then(context => stage.remeasured(context), () => {})
    }

    return next(e)
  })

  // Claude Code's theme changes: once it has, the band follows it onto a light
  // background or off one. It watches, and passes the change on unchanged.
  on('config.set', { key: 'theme' }, ($, e, next) => {
    void $.clock
      .sleep(SETTLED)
      .then(() => themeOf($))
      .then(
        setting => {
          stage.backdrop = { ...stage.backdrop, theme: setting }
          stage.retone()
          if (sites.size > 0) stage.wake()
        },
        () => {},
      )

    return next(e)
  })

  // Auto-compact turned on or off: once it has, the top of the meter moves.
  // It watches, and passes the change on unchanged.
  on('config.set', { key: 'autoCompact' }, ($, e, next) => {
    void $.clock
      .sleep(SETTLED)
      .then(() => measureContext($))
      .then(context => stage.remeasured(context), () => {})

    return next(e)
  })

  // The conversation compacts: the tape rewinds until it is done, and the meter drains.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    spectrum.beginRewind()
    stage.wake()
    try {
      const done = await next(e)
      if ('tokensAfter' in done && done.tokensAfter !== undefined && stage.windowSize !== undefined && stage.windowSize > 0) {
        spectrum.measure((100 * done.tokensAfter) / stage.windowSize, stage.limit)
      }

      return done
    } finally {
      spectrum.endRewind()
      stage.wake()
    }
  })

  // The band as either site draws it: across `bodyColumns`, or mini at its right edge.
  const band = (ui: Pick<Elements['terminal'], 'Box' | 'Raster'>, requestId: string, s: VizSize, t: VizTheme, bodyColumns: number, room: number) => {
    const { Box, Raster } = ui
    const focus = stage.inView()
    if (s === 'mini') {
      const columns = clamp(Math.min(MINI_COLUMNS, bodyColumns), 1, 512)
      const rows = Math.min(MINI_ROWS, room)
      const nameColumns = Math.min(MINI_NAMES, bodyColumns - columns)
      const names = nameColumns >= 8 ? { key: 'names', columns: nameColumns, rows } : undefined
      const site = stage.mount(requestId, 'mini', columns, rows, { layout: MINI_LAYOUT, names })

      return (
        <Box width={bodyColumns} justifyContent="flex-end">
          {names && <Raster key="names" columns={names.columns} rows={rows} cells={trail(spectrum, t, names.columns, rows, stage.tone, ensemble, focus)} />}
          <Raster key="mini" columns={columns} rows={rows} cells={site.board.paint(t, spectrum, ensemble, false, stage.tone, focus)} />
        </Box>
      )
    }

    const columns = clamp(bodyColumns, 1, 512)
    const rows = Math.min(BAND_ROWS, room)
    const site = stage.mount(requestId, 'band', columns, rows, { layout: wide(columns), labels: true })

    return <Raster key="band" columns={columns} rows={rows} cells={site.board.paint(t, spectrum, ensemble, true, stage.tone, focus)} />
  }

  // Above the prompt: the band in the slot over the input.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [m, t, s, p, playing, paneOpen] = await Promise.all([
      read($, mode),
      read($, theme),
      read($, size),
      read($, place),
      read($, isPlaying),
      read($, isPaneOpen),
    ])
    if (e.surface === 'terminal') {
      stage.isWorking = e.props.isWorking
      // A switch of transcript draws this again: told even while the band is down, for the band below.
      stage.viewed = e.props.view?.agentId
    }
    if (e.surface === 'terminal' && e.props.bodyColumns !== stage.bodyColumns) {
      const had = stage.bodyColumns
      stage.bodyColumns = e.props.bodyColumns
      // A pane docked or closed: the band below the prompt fits itself again.
      if (had !== undefined && p === 'below') $.ui.invalidate('ui.render')
    }
    const view = { surface: e.surface, isWorking: e.props.isWorking, hasSurvey: e.props.hasSurvey, isPlaying: playing, isPaneOpen: paneOpen }
    if (e.surface !== 'terminal' || !isBandShown({ mode: m, place: p }, view, 'above')) {
      sites.delete(e.requestId)

      return next(e)
    }

    return band($.ui.resolve(e), e.requestId, s, t, e.props.bodyColumns, clamp(e.props.maxRows - 1, 1, 256))
  })

  // Below the prompt: the band over the hint line, which stays as the engine draws it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const [m, t, s, p, playing, paneOpen] = await Promise.all([
      read($, mode),
      read($, theme),
      read($, size),
      read($, place),
      read($, isPlaying),
      read($, isPaneOpen),
    ])
    if (e.surface === 'terminal') stage.isWorking = e.props.isWorking
    const hint = await next(e)
    const view = { surface: e.surface, isWorking: e.props.isWorking, isPlaying: playing, isPaneOpen: paneOpen }
    if (e.surface !== 'terminal' || !isBandShown({ mode: m, place: p }, view, 'below')) {
      sites.delete(e.requestId)

      return hint
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    // As wide as the band above would be; until it has been told, the screen less its five.
    const columns = stage.bodyColumns ?? (e.viewport?.columns ?? 80) - 5

    return (
      <Box flexDirection="column">
        {band(ui, e.requestId, s, t, columns, BAND_ROWS)}
        {hint}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = await read($, theme)
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>The visualizer draws in the terminal.</Text>
    }

    const { Box, Raster } = $.ui.resolve(e)
    stage.viewed = e.props.view?.agentId
    const columns = clamp(e.props.bodyColumns, 1, 512)
    const rows = clamp(e.props.scroll.bodyRows - 1, 2, PANE_ROWS)
    const site = stage.mount(PANE, 'pane', columns, rows, { layout: wide(columns), labels: true, legend: 'legend' })

    return (
      <Box flexDirection="column">
        <Raster key="pane" columns={columns} rows={rows} cells={site.board.paint(t, spectrum, ensemble, true, stage.tone, stage.inView())} />
        <Raster key="legend" columns={columns} rows={1} cells={site.board.legend(t, stage.tone)} />
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      sites.delete(PANE)
      await update($, isPaneOpen, () => false)
    }

    return closed
  }).catch(($, e, next) => next(e))

  // /viz doctor's report on the terminal: what it found, then a swatch for
  // each check beside its name, painted for the background the band paints for.
  on('ui.render', { component: 'CommandOutput', props: { command: 'viz' } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored || e.props.args.trim().split(/\s+/)[0] !== 'doctor') return next(e)
    const t = await read($, theme)
    const { Box, Text, Raster } = $.ui.resolve(e)
    const columns = 64

    return (
      <Box flexDirection="column">
        <Text bold>Visualizer doctor</Text>
        <Text>{factsOf(e.props.text).join('\n')}</Text>
        <Box flexDirection="row" marginY={1}>
          <Box flexDirection="column" width={8}>
            <Text dimColor>{DOCTOR_ROWS.join('\n')}</Text>
          </Box>
          <Raster key="doctor" columns={columns} rows={DOCTOR_ROWS.length} cells={swatches(t, stage.tone, columns)} />
        </Box>
        <Text dimColor>{DOCTOR_HINTS.join('\n')}</Text>
      </Box>
    )
  })

  // /viz: what it does is viz.ts's to say; this does it.
  on('command.run', { command: 'viz' }, async ($, e) => {
    const outcome = command(e.args, stage.prefs, { isPaneOpen: await read($, isPaneOpen), backdrop: stage.backdrop })
    if (outcome.isDoctor) {
      const [term, colorterm, program] = await Promise.all([
        $.env.get('TERM').catch(() => undefined),
        $.env.get('COLORTERM').catch(() => undefined),
        $.env.get('TERM_PROGRAM').catch(() => undefined),
      ])
      return { text: doctorReport({ term, colorterm, program }, stage.prefs, stage.backdrop) }
    }
    if (outcome.isReplyOnly) return { text: outcome.text }

    let { text } = outcome
    if (outcome.pane === 'open') {
      await update($, isPaneOpen, () => true)
      const opened = await $.ui.open({ id: PANE, title: 'Visualizer', rows: 14 })
      if (!opened.isPlaced) text = PANE_WAITS
    } else if (outcome.pane === 'close') {
      await $.ui.close({ id: PANE })
      if (outcome.isOff) {
        sites.clear()
      } else {
        sites.delete(PANE)
        await update($, isPaneOpen, () => false)
      }
    }
    if (outcome.isDemo) spectrum.playDemo(ensemble)
    const before = stage.prefs
    stage.prefs = outcome.prefs
    stage.retone()
    await publish($, stage.prefs)
    // Save what this command changed over what is saved: another session may
    // have saved the rest since this one read it.
    const changed = changes(before, stage.prefs)
    if (Object.keys(changed).length > 0) {
      await $.store.set('prefs', { ...savedOf(await $.store.get('prefs')), ...changed })
    }
    stage.wake()

    return { text }
  })
}
