// The hooks: what Claude Code tells the plugin, played on the engine's music,
// and the drawings that show it. What to do is decided in viz.ts and the
// music in engine.ts; this reads the world, asks them, and does what they say.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { VizSize, VizTheme } from '../types'
import { Bars, DOCTOR_ROWS, FRAME_MS, Spectrum, Step, sourceOf, swatches, trail } from './engine'
import type { Ask, Call, Layout, Tone } from './engine'
import {
  DEFAULTS,
  DOCTOR_HINTS,
  HINT,
  PANE_WAITS,
  changes,
  command,
  doctorReport,
  factsOf,
  argumentsOf,
  inputKey,
  isAmbient,
  isBandShown,
  isKeyed,
  measuredFrom,
  pace,
  percentOf,
  prefsFrom,
  requestFor,
  savedOf,
  toneFor,
} from './viz'
import type { Backdrop, Check, Measured, Prefs } from './viz'

const PANE = 'viz'
const BAND_ROWS = 5
const PANE_ROWS = 32
const MINI_COLUMNS = 32
const MINI_ROWS = 2
const MINI_LAYOUT: Layout = { width: 1, gap: 1, meter: true }
/** The band's and the pane's bars, the context meter at the right edge. */
const wide = (columns: number): Layout => ({ width: columns >= 30 ? 2 : 1, gap: 1, meter: true })
/** Tools whose whole call waits on the person: a question, a plan to approve. */
const PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])
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

/** A drawing the frames repaint: its bars, and the raster of tool names beside a mini one. */
type Site = {
  requestId: string
  key: string
  bars: Bars
  labels: boolean
  names?: { key: string; columns: number; rows: number }
  /** While the engine refuses its frames (a dialog took its place): when to try again, on the music's clock. */
  retryAt?: number
  /** The cells last sent, by key: a frame the same as them changes nothing on screen, and is not sent. */
  sent: Map<string, string>
}

type Mount = { layout?: Layout; labels?: boolean; names?: Site['names'] }

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
  // The animation is the module's own: a reload starts it from silence.
  const spectrum = new Spectrum()
  const sites = new Map<string, Site>()
  // Tool calls by their id while they run, the ones that may yet be put to the
  // person, and the ones put to the person until answered.
  const calls = new Map<string, Call>()
  const checks = new Map<string, Check>()
  const asks = new Map<string, Ask>()
  // The context window's size, and where auto-compact runs in it (1 when it is off).
  let windowSize: number | undefined
  let limit = 1
  let ticker: Timer | undefined
  let tempo = FRAME_MS
  // Which ticker's ticks count (not one replaced or stopped, still in flight),
  // and when the last frame was: none after a stop, so the music's clock
  // stands still while nothing plays.
  let ticks = 0
  let last: number | undefined
  // What the person has set with /viz: the one copy, which the atoms publish
  // for the drawings and the store keeps across sessions.
  let prefs: Prefs = DEFAULTS
  // What the terminal's background is read from, and the tone every drawing paints for.
  let backdrop: Backdrop = {}
  let tone: Tone = 'dark'
  // Whether Claude is working, as the prompt's band and hint line are told.
  let isWorking = false
  // The prompt's column less the band's five, as the band above is told it:
  // narrower beside a docked pane. The hint line is told only the screen's.
  let bodyColumns: number | undefined
  // Runs the frames until the music stops and the bars have fallen; made by
  // session.start, whose `$` the frames draw through.
  let wake = () => {}
  // Starts the idle show on a drawing that stays up, if nothing plays yet.
  let rest = () => {}

  const retone = () => {
    tone = toneFor(prefs.ground, backdrop)
  }
  const drawn = () => ({ hasPane: sites.has(PANE), hasBand: [...sites.keys()].some(id => id !== PANE) })

  // A call decided, its ask answered; `answer` wakes the frames too, which a
  // drawing may not do (it writes state), so a drawing settles it and the frames notice.
  const settle = (id: string): boolean => {
    checks.delete(id)
    const ask = asks.get(id)
    if (ask === undefined) return false
    asks.delete(id)
    spectrum.answer(ask)
    return true
  }
  const answer = (id: string) => {
    if (!settle(id)) return
    // The dialog that asked is gone: try the drawings it covered at once.
    for (const site of sites.values()) if (site.retryAt !== undefined) site.retryAt = 0
    wake()
  }

  const measured = (context: Measured) => {
    windowSize = context.window
    limit = context.limit
    return context
  }

  // The context measured now, not at the next response: the meter moves there
  // on a drawing that shows, and is simply there on the next one.
  const remeasured = (context: Measured) => {
    const isShown = sites.size > 0
    spectrum.measure(percentOf(measured(context)), limit, !isShown)
    if (isShown) wake()
  }

  // A drawing of the same key and size keeps its bars where they stood. One
  // drawn again while a dialog covers it is still held: the dialog may show it
  // as it was, so the frames go on trying until one lands.
  const mount = (requestId: string, key: string, columns: number, rows: number, extra: Mount = {}): Site => {
    const had = sites.get(requestId)
    const isSame = had?.key === key && had.bars.columns === columns && had.bars.rows === rows
    const bars = isSame ? had.bars : new Bars(columns, rows, extra.layout)
    const site = {
      requestId,
      key,
      bars,
      labels: extra.labels ?? false,
      names: extra.names,
      retryAt: had?.retryAt,
      sent: new Map<string, string>(),
    }
    sites.set(requestId, site)
    rest()
    return site
  }

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
      spectrum.ambient = isAmbient(prefs, drawn())
      spectrum.step(elapsed)
      for (const site of sites.values()) site.bars.step(spectrum)
      for (const site of sites.values()) {
        if (site.retryAt !== undefined && spectrum.now < site.retryAt) continue
        blit(site, site.key, site.bars.paint(prefs.theme, spectrum, site.labels, tone))
        if (site.names) blit(site, site.names.key, trail(spectrum, prefs.theme, site.names.columns, site.names.rows, tone))
      }
      const pacing = pace({
        isCalm: spectrum.isCalm(),
        isAmbient: spectrum.ambient,
        isResting: spectrum.isResting(),
        isQuiet: spectrum.isQuiet(),
        isSettled: [...sites.values()].every(site => site.bars.isSettled()),
        isGlinting: spectrum.glint() !== undefined && spectrum.gauge > 0,
        isHeld: [...sites.values()].some(site => site.retryAt !== undefined),
      })
      if (pacing === 'full') {
        // Something plays again after a show: back to the full rate.
        if (tempo !== FRAME_MS) wake()
        return
      }
      if (pacing === 'same') return
      const wasFull = tempo === FRAME_MS
      if (pacing === 'show') run(spectrum.showMs())
      else stop()
      if (wasFull) void update($, isPlaying, () => false)
    }
    wake = () => {
      if ((ticker !== undefined && tempo === FRAME_MS) || (prefs.mode === 'off' && sites.size === 0)) return
      run(FRAME_MS)
      void update($, isPlaying, () => true)
    }
    rest = () => {
      if (ticker === undefined && isAmbient(prefs, drawn())) run(spectrum.showMs())
    }

    await $.command.register({ name: 'viz', description: 'Music visualizer for what Claude is doing', argumentHint: HINT, immediate: true })
    prefs = prefsFrom(await $.store.get('prefs'))
    await publish($, prefs)
    // The terminal's background, as Claude Code's theme and the terminal tell it.
    backdrop = {
      theme: await themeOf($),
      colorfgbg: await $.env.get('COLORFGBG').catch(() => undefined),
    }
    retone()
    // Playing or not as the frames are now: a reload mid-turn may have woken them already.
    await update($, isPlaying, () => ticker !== undefined && tempo === FRAME_MS)
    // The meter as it stood, after a reload or on a resumed session.
    void measureContext($).then(remeasured, () => {})

    return next(e)
  })

  // The person types: the keys play on a drawing that is up anyway.
  on('prompt.edit', ($, e, next) => {
    if (isKeyed(prefs.mode, { ...drawn(), isWorking })) {
      spectrum.edited(e.text, e.start, e.end, e.inputText)
      wake()
    }

    return next(e)
  })

  // A prompt sent: a sweep up the spectrum.
  on('prompt.submit', ($, e, next) => {
    spectrum.kick()
    wake()

    return next(e)
  }).catch(($, e, next) => next(e))

  // The model's response as it streams, played a chunk at a time.
  on('turn.step', async function* ($, e, next) {
    const step = new Step(spectrum, e.agentId !== undefined)
    wake()
    try {
      for await (const chunk of next(e)) {
        step.hear(chunk)
        // The frames may have stopped in a lull mid-stream.
        wake()
        yield chunk
      }
    } finally {
      step.end()
    }
  })

  // A tool runs: a hit, its name, a held note until it returns.
  on('tool.call', async ($, e, next) => {
    const call = spectrum.startCall(String(e.tool))
    const id = e.tool_use_id
    if (id !== undefined) {
      calls.set(id, call)
      if (PERSON.has(String(e.tool))) asks.set(id, spectrum.ask(call.source, call, 0))
      else checks.set(id, { tool: e.tool, agentId: e.agentId, input: inputKey(argumentsOf(e)) })
    }
    wake()
    try {
      return await next(e)
    } finally {
      if (id !== undefined) {
        calls.delete(id)
        answer(id)
      }
      spectrum.endCall(call)
    }
  }).catch(($, e, next) => next(e))

  // A tool that ran and failed flashes red. A call refused (at the dialog, by a
  // rule or by auto mode) or cut by an interrupt never ran: core marks it an
  // error too, but this is not raised for it.
  on('classic.PostToolUseFailure', ($, e, next) => {
    if (e.is_interrupt !== true) {
      spectrum.error()
      wake()
    }

    return next(e)
  })

  // The person is asked to allow a call: unless an answer comes within the grace
  // (a hook's), its held note rests and the vamp plays until it is answered.
  // Only asks that reach the person raise this, not the ones auto mode's
  // classifier settles. It watches, and passes the request on unchanged.
  on('classic.PermissionRequest', ($, e, next) => {
    const id = requestFor(checks, e.tool_name, e.agent_id, e.tool_input)
    if (id !== undefined) {
      checks.delete(id)
      const call = calls.get(id)
      asks.set(id, spectrum.ask(call?.source ?? sourceOf(e.tool_name), call))
      wake()
    }

    return next(e)
  })

  // A tool's progress row shows once it runs: the ask was answered.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    settle(e.props.tool_use_id)

    return next(e)
  })

  // The context window, measured after each turn: the meter at the right edge.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      if (e.context.window !== windowSize) await measureContext($).then(measured, () => {})
      const percent = percentOf(e.context)
      if (percent !== undefined) {
        spectrum.measure(percent, limit)
        wake()
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The conversation cleared or another resumed: the meter moves to what it
  // holds now, which no response has reported yet.
  on('classic.SessionStart', ($, e, next) => {
    if ((e.source === 'clear' || e.source === 'resume') && e.agent_id === undefined) {
      void measureContext($).then(remeasured, () => {})
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
          backdrop = { ...backdrop, theme: setting }
          retone()
          if (sites.size > 0) wake()
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
      .then(remeasured, () => {})

    return next(e)
  })

  // The conversation compacts: the tape rewinds until it is done, and the meter drains.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    spectrum.beginRewind()
    wake()
    try {
      const done = await next(e)
      if ('tokensAfter' in done && done.tokensAfter !== undefined && windowSize !== undefined && windowSize > 0) {
        spectrum.measure((100 * done.tokensAfter) / windowSize, limit)
      }

      return done
    } finally {
      spectrum.endRewind()
      wake()
    }
  })

  // The turn ends: a cymbal, a sweep down when interrupted, red on an error.
  on('turn.complete', ($, e, next) => {
    spectrum.ended(e.reason, e.agentId !== undefined)
    wake()

    return next(e)
  })

  // The band as either site draws it: across `bodyColumns`, or mini at its right edge.
  const band = (ui: Pick<Elements['terminal'], 'Box' | 'Raster'>, requestId: string, s: VizSize, t: VizTheme, bodyColumns: number, room: number) => {
    const { Box, Raster } = ui
    if (s === 'mini') {
      const columns = clamp(Math.min(MINI_COLUMNS, bodyColumns), 1, 512)
      const rows = Math.min(MINI_ROWS, room)
      const nameColumns = Math.min(MINI_NAMES, bodyColumns - columns)
      const names = nameColumns >= 8 ? { key: 'names', columns: nameColumns, rows } : undefined
      const site = mount(requestId, 'mini', columns, rows, { layout: MINI_LAYOUT, names })

      return (
        <Box width={bodyColumns} justifyContent="flex-end">
          {names && <Raster key="names" columns={names.columns} rows={rows} cells={trail(spectrum, t, names.columns, rows, tone)} />}
          <Raster key="mini" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum, false, tone)} />
        </Box>
      )
    }

    const columns = clamp(bodyColumns, 1, 512)
    const rows = Math.min(BAND_ROWS, room)
    const site = mount(requestId, 'band', columns, rows, { layout: wide(columns), labels: true })

    return <Raster key="band" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum, true, tone)} />
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
    if (e.surface === 'terminal') isWorking = e.props.isWorking
    if (e.surface === 'terminal' && e.props.bodyColumns !== bodyColumns) {
      const had = bodyColumns
      bodyColumns = e.props.bodyColumns
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
    if (e.surface === 'terminal') isWorking = e.props.isWorking
    const hint = await next(e)
    const view = { surface: e.surface, isWorking: e.props.isWorking, isPlaying: playing, isPaneOpen: paneOpen }
    if (e.surface !== 'terminal' || !isBandShown({ mode: m, place: p }, view, 'below')) {
      sites.delete(e.requestId)

      return hint
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    // As wide as the band above would be; until it has been told, the screen less its five.
    const columns = bodyColumns ?? (e.viewport?.columns ?? 80) - 5

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
    const columns = clamp(e.props.bodyColumns, 1, 512)
    const rows = clamp(e.props.scroll.bodyRows - 1, 2, PANE_ROWS)
    const site = mount(PANE, 'pane', columns, rows, { layout: wide(columns), labels: true })

    return (
      <Box flexDirection="column">
        <Raster key="pane" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum, true, tone)} />
        <Raster key="legend" columns={columns} rows={1} cells={site.bars.legend(t, tone)} />
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
          <Raster key="doctor" columns={columns} rows={DOCTOR_ROWS.length} cells={swatches(t, tone, columns)} />
        </Box>
        <Text dimColor>{DOCTOR_HINTS.join('\n')}</Text>
      </Box>
    )
  })

  // /viz: what it does is viz.ts's to say; this does it.
  on('command.run', { command: 'viz' }, async ($, e) => {
    const outcome = command(e.args, prefs, { isPaneOpen: await read($, isPaneOpen), backdrop })
    if (outcome.isDoctor) {
      const [term, colorterm, program] = await Promise.all([
        $.env.get('TERM').catch(() => undefined),
        $.env.get('COLORTERM').catch(() => undefined),
        $.env.get('TERM_PROGRAM').catch(() => undefined),
      ])
      return { text: doctorReport({ term, colorterm, program }, prefs, backdrop) }
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
    if (outcome.isDemo) spectrum.playDemo()
    const before = prefs
    prefs = outcome.prefs
    retone()
    await publish($, prefs)
    // Save what this command changed over what is saved: another session may
    // have saved the rest since this one read it.
    const changed = changes(before, prefs)
    if (Object.keys(changed).length > 0) {
      await $.store.set('prefs', { ...savedOf(await $.store.get('prefs')), ...changed })
    }
    wake()

    return { text }
  })
}
