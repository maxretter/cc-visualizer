import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { VizMode, VizPlace, VizSize, VizTheme } from '../types'
import { Bars, FRAME_MS, Spectrum, THEME_NAMES, sourceOf, trail } from './engine'
import type { Ask, Call, Layout } from './engine'

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
/** While only the idle show plays, frames come this many times slower, each moving it as far. */
const IDLE_STEPS = 2
/** Frames between tries at a drawing whose frames the engine refuses (half a second). */
const RETRY = 15
const MODES: readonly VizMode[] = ['auto', 'always', 'off']
const SIZES: readonly VizSize[] = ['bar', 'mini']
const PLACES: readonly VizPlace[] = ['above', 'below']

const mode = atom({ plugin: 'visualizer', key: 'mode' } as const, 'auto')
const theme = atom({ plugin: 'visualizer', key: 'theme' } as const, 'instrument')
const size = atom({ plugin: 'visualizer', key: 'size' } as const, 'bar')
const place = atom({ plugin: 'visualizer', key: 'place' } as const, 'above')
const isPlaying = atom({ plugin: 'visualizer', key: 'isPlaying' } as const, false)
const isPaneOpen = atom({ plugin: 'visualizer', key: 'isPaneOpen' } as const, false)

const isMode = (v: unknown): v is VizMode => MODES.includes(v as VizMode)
const isTheme = (v: unknown): v is VizTheme => THEME_NAMES.includes(v as VizTheme)
const isSize = (v: unknown): v is VizSize => SIZES.includes(v as VizSize)
const isPlace = (v: unknown): v is VizPlace => PLACES.includes(v as VizPlace)
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)))

const USAGE = [
  '/viz                    toggle the band',
  '/viz auto               show it while Claude works (default)',
  '/viz always             keep it up, with an idle show while quiet',
  '/viz off                hide it, and close the pane',
  '/viz bar                the band across the whole width',
  '/viz mini               a small spectrum at the right edge',
  '/viz pos [above|below]  the band above the prompt (default), or below it',
  '/viz pane               a big view with a legend',
  '/viz demo               play a few bars without a turn',
  '/viz idle [on|off]      the idle show (with always, or in the pane)',
  `/viz theme [name]       ${THEME_NAMES.join(', ')}`,
].join('\n')

/** A drawing the frames repaint: its bars, and the raster of tool names beside a mini one. */
type Site = {
  requestId: string
  key: string
  bars: Bars
  labels: boolean
  names?: { key: string; columns: number; rows: number }
  /** While the engine refuses its frames (a dialog took its place): the frame to try again at. */
  retryAt?: number
}

type Mount = { layout?: Layout; labels?: boolean; names?: Site['names'] }

type Context = { tokens?: number; window: number; percent?: number }

/** The context window, and where auto-compact runs in it as a share of it (1 when it is off). */
type Measured = Context & { limit: number }

/** The context window now, and where auto-compact runs: the top of the meter. */
async function measureContext($: EngineInterface): Promise<Measured> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const { breakdown } = context
  const limit =
    breakdown?.isAutoCompactEnabled === true && breakdown.autoCompactThreshold !== undefined && context.window > 0
      ? breakdown.autoCompactThreshold / context.window
      : 1
  return { tokens: context.tokens, window: context.window, percent: context.percent, limit }
}

/** The share of the window in use, 0 to 100, finer than the whole percent when the tokens are known. */
const percentOf = (context: Context) =>
  context.tokens !== undefined && context.window > 0 ? (100 * context.tokens) / context.window : context.percent

export const register: Register = on => {
  // The animation is the module's own: a reload starts it from silence.
  const spectrum = new Spectrum()
  const sites = new Map<string, Site>()
  // Tool calls by their id while they run, and the ones put to the person until answered.
  const calls = new Map<string, Call>()
  const asks = new Map<string, Ask>()
  // The context window's size, and where auto-compact runs in it (1 when it is off).
  let windowSize: number | undefined
  let limit = 1
  let ticker: Timer | undefined
  let tempo = FRAME_MS
  let modeNow: VizMode = 'auto'
  let themeNow: VizTheme = 'instrument'
  let idleNow = true
  // Runs the frames until the music stops and the bars have fallen; made by
  // session.start, whose `$` the frames draw through.
  let wake = () => {}
  // Starts the idle show on a drawing that stays up, if nothing plays yet.
  let rest = () => {}

  // A drawing stays up once all is quiet: the pane, or the band shown always.
  const isAmbient = () => idleNow && (sites.has(PANE) || (modeNow === 'always' && sites.size > 0))

  // An ask answered; `answer` wakes the frames too, which a drawing may not do
  // (it writes state), so a drawing settles it and the frames notice.
  const settle = (id: string): boolean => {
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

  // A drawing of the same key and size keeps its bars where they stood.
  const mount = (requestId: string, key: string, columns: number, rows: number, extra: Mount = {}): Site => {
    const had = sites.get(requestId)
    const isSame = had?.key === key && had.bars.columns === columns && had.bars.rows === rows
    const bars = isSame ? had.bars : new Bars(columns, rows, extra.layout)
    const site = { requestId, key, bars, labels: extra.labels ?? false, names: extra.names }
    sites.set(requestId, site)
    rest()
    return site
  }

  on('session.start', async ($, e, next) => {
    // A refused frame holds the drawing rather than dropping it: a dialog takes
    // the band off screen, and the engine shows it again as it was, without a
    // new render, so only a frame that lands brings it back to life.
    const hold = (site: Site) => {
      site.retryAt = spectrum.frame + RETRY
    }
    const blit = (site: Site, key: string, cells: string) => {
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
      ticker?.cancel()
      tempo = ms
      ticker = $.clock.every(ms, frame)
    }
    const frame = () => {
      spectrum.ambient = isAmbient()
      for (let k = tempo === FRAME_MS ? 1 : IDLE_STEPS; k > 0; k--) {
        spectrum.step()
        for (const site of sites.values()) site.bars.step(spectrum)
      }
      for (const site of sites.values()) {
        if (site.retryAt !== undefined && spectrum.frame < site.retryAt) continue
        blit(site, site.key, site.bars.paint(themeNow, spectrum, site.labels))
        if (site.names) blit(site, site.names.key, trail(spectrum, themeNow, site.names.columns, site.names.rows))
      }
      if (!spectrum.isCalm()) {
        // Something plays again after a show: back to the full rate.
        if (tempo !== FRAME_MS) wake()
        return
      }
      // The music stopped. A show plays slower: the vamp while the person is
      // waited on, or the idle show on a drawing that stays up. Or nothing
      // does: stop once the bars have fallen.
      if (spectrum.ambient || !spectrum.isResting()) {
        if (tempo !== FRAME_MS) return
        run(FRAME_MS * IDLE_STEPS)
      } else if (spectrum.isQuiet() && [...sites.values()].every(site => site.bars.isSettled())) {
        ticker?.cancel()
        ticker = undefined
      } else {
        return
      }
      void update($, isPlaying, () => false)
    }
    wake = () => {
      if ((ticker !== undefined && tempo === FRAME_MS) || (modeNow === 'off' && sites.size === 0)) return
      run(FRAME_MS)
      void update($, isPlaying, () => true)
    }
    rest = () => {
      if (ticker === undefined && isAmbient()) run(FRAME_MS * IDLE_STEPS)
    }

    await $.command.register({
      name: 'viz',
      description: 'Music visualizer for what Claude is doing',
      argumentHint: '[auto|always|off|bar|mini|pos <above|below>|pane|demo|idle|theme <name>]',
      immediate: true,
    })
    const saved = await $.store.get('prefs')
    const prefs = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {}
    const savedMode = prefs.mode
    const savedTheme = prefs.theme
    const savedSize = prefs.size
    if (isMode(savedMode)) {
      modeNow = savedMode
      await update($, mode, () => savedMode)
    }
    if (isTheme(savedTheme)) {
      themeNow = savedTheme
      await update($, theme, () => savedTheme)
    }
    // `full` is what 0.2 called the bar.
    if (isSize(savedSize) || savedSize === 'full') await update($, size, () => (savedSize === 'mini' ? 'mini' : 'bar'))
    const savedPlace = prefs.place
    if (isPlace(savedPlace)) await update($, place, () => savedPlace)
    if (typeof prefs.idle === 'boolean') idleNow = prefs.idle
    await update($, isPlaying, () => false)
    // The meter as it stood, after a reload or on a resumed session.
    void measureContext($).then(
      context => {
        const percent = percentOf(measured(context))
        if (percent !== undefined) spectrum.measure(percent, limit, true)
      },
      () => {},
    )

    return next(e)
  })

  // A prompt sent: a sweep up the spectrum.
  on('prompt.submit', ($, e, next) => {
    spectrum.kick()
    wake()

    return next(e)
  }).catch(($, e, next) => next(e))

  // The model's response as it streams: thinking is the sub-bass and the
  // brainwave, from the request until its first text or tool call; text the
  // bass, a tool call it writes a hit on that tool's band, its arguments hats.
  on('turn.step', async function* ($, e, next) {
    const gain = e.agentId === undefined ? 1 : 0.6
    let isThinking = true
    spectrum.beginThinking()
    wake()
    try {
      for await (const chunk of next(e)) {
        const isThought = chunk.kind === 'thinking'
        if (isThought !== isThinking && (isThought || chunk.kind === 'text' || chunk.kind === 'tool')) {
          isThinking = isThought
          if (isThought) spectrum.beginThinking()
          else spectrum.endThinking()
        }
        if (chunk.kind === 'text') spectrum.stream('text', chunk.text.length, gain)
        else if (chunk.kind === 'thinking') spectrum.stream('think', chunk.text.length, gain)
        else if (chunk.kind === 'tool') spectrum.hit(sourceOf(chunk.name), 0.8 * gain)
        else if (chunk.kind === 'input') spectrum.stream('args', chunk.json.length, gain)
        yield chunk
      }
    } finally {
      if (isThinking) spectrum.endThinking()
    }
  })

  // A tool runs: a hit, its name, a held note until it returns; an error flashes red.
  on('tool.call', async ($, e, next) => {
    const call = spectrum.startCall(String(e.tool))
    const id = e.tool_use_id
    if (id !== undefined) {
      calls.set(id, call)
      if (PERSON.has(String(e.tool))) asks.set(id, spectrum.ask(call.source, call, 0))
    }
    wake()
    try {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError === true) spectrum.error()

      return ran
    } finally {
      if (id !== undefined) {
        calls.delete(id)
        answer(id)
      }
      spectrum.endCall(call)
    }
  }).catch(($, e, next) => next(e))

  // A tool call put to the person: unless an answer comes within the grace
  // (auto mode's classifier settles most), its held note rests and the vamp
  // plays until it is answered. A hook that fails leaves the verdict as it was.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (verdict.decision === 'ask' && id !== undefined && !asks.has(id)) {
      const call = calls.get(id)
      asks.set(id, spectrum.ask(call?.source ?? sourceOf(e.tool), call))
      wake()
    }

    return verdict
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

  // The turn ends: a cymbal, a record scratch when interrupted, red on an error.
  on('turn.complete', ($, e, next) => {
    if (e.reason === 'aborted') spectrum.scratch()
    else if (e.reason === 'answer') spectrum.cymbal(e.agentId === undefined ? 1 : 0.4)
    else spectrum.error()
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
          {names && <Raster key="names" columns={names.columns} rows={rows} cells={trail(spectrum, t, names.columns, rows)} />}
          <Raster key="mini" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum)} />
        </Box>
      )
    }

    const columns = clamp(bodyColumns, 1, 512)
    const rows = Math.min(BAND_ROWS, room)
    const site = mount(requestId, 'band', columns, rows, { layout: wide(columns), labels: true })

    return <Raster key="band" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum, true)} />
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
    modeNow = m
    themeNow = t
    const isShown = m === 'always' || (m === 'auto' && (e.props.isWorking || playing))
    if (e.surface !== 'terminal' || e.props.hasSurvey || paneOpen || !isShown || p !== 'above') {
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
    modeNow = m
    themeNow = t
    const hint = await next(e)
    const isShown = m === 'always' || (m === 'auto' && (e.props.isWorking || playing))
    if (e.surface !== 'terminal' || paneOpen || !isShown || p !== 'below') {
      sites.delete(e.requestId)

      return hint
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    // The hint line has no measured body: the band keeps the five columns the band above leaves.
    const bodyColumns = (e.viewport?.columns ?? 80) - 5

    return (
      <Box flexDirection="column">
        {band(ui, e.requestId, s, t, bodyColumns, BAND_ROWS)}
        {hint}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = await read($, theme)
    themeNow = t
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
        <Raster key="pane" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum, true)} />
        <Raster key="legend" columns={columns} rows={1} cells={site.bars.legend(t)} />
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

  on('command.run', { command: 'viz' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const was = await read($, mode)
    let m = was
    let t = await read($, theme)
    let z = await read($, size)
    let p = await read($, place)
    let text: string

    if (verb === 'pos') {
      if (arg === 'top') {
        return { text: 'Claude Code has no spot at the top of the screen that stays put. The closest is the pane: /viz pane.' }
      }
      if (arg !== '' && !isPlace(arg)) return { text: 'Usage: /viz pos [above|below]' }
      p = isPlace(arg) ? arg : p === 'above' ? 'below' : 'above'
      if (was === 'off') m = 'auto'
      text = `Visualizer ${p} the prompt.`
    } else if (verb === '' || verb === 'toggle') {
      m = was === 'off' ? 'auto' : 'off'
      text = m === 'off' ? 'Visualizer off.' : 'Visualizer on: it plays while Claude works.'
    } else if (verb === 'on') {
      m = was === 'off' ? 'auto' : was
      text = 'Visualizer on.'
    } else if (isMode(verb)) {
      m = verb
      text = {
        auto: 'Visualizer on: it plays while Claude works.',
        always: 'Visualizer on, always shown.',
        off: 'Visualizer off.',
      }[verb]
    } else if (isSize(verb)) {
      z = verb
      if (was === 'off') m = 'auto'
      const shape = verb === 'mini' ? 'mini, at the right edge' : 'a bar across the whole width'
      text = was === 'off' ? `Visualizer on, ${shape}.` : `Visualizer: ${shape}.`
    } else if (verb === 'pane') {
      await update($, isPaneOpen, () => true)
      const opened = await $.ui.open({ id: PANE, title: 'Visualizer', rows: 14 })
      text = opened.isPlaced
        ? 'Visualizer pane open. Close it with ctrl+x x or /viz off.'
        : 'The visualizer pane opens once the terminal is wide enough.'
    } else if (verb === 'demo') {
      if (was === 'off') m = 'auto'
      spectrum.playDemo()
      text = was === 'off' ? 'Visualizer on, playing a demo.' : 'Playing a demo for a few seconds.'
    } else if (verb === 'idle') {
      const isOn = arg === '' ? !idleNow : arg === 'on' ? true : arg === 'off' ? false : undefined
      if (isOn === undefined) return { text: 'Usage: /viz idle [on|off]' }
      idleNow = isOn
      text = !isOn
        ? 'Idle animation off: the bars rest flat.'
        : m === 'always'
          ? 'Idle animation on: a swell, rain and a scanner, in turn.'
          : 'Idle animation on. It plays on a band that stays up: /viz always, or the pane.'
    } else if (verb === 'theme') {
      if (arg === '') {
        t = THEME_NAMES[(THEME_NAMES.indexOf(t) + 1) % THEME_NAMES.length]!
      } else if (isTheme(arg)) {
        t = arg
      } else {
        return { text: `No theme "${arg}". Themes: ${THEME_NAMES.join(', ')}.` }
      }
      text = `Visualizer theme: ${t}.`
    } else {
      return { text: USAGE }
    }

    if (verb === 'off' || (m === 'off' && was !== 'off')) {
      await $.ui.close({ id: PANE })
      sites.clear()
    } else if ((verb === 'pos' || isSize(verb)) && (await read($, isPaneOpen))) {
      // Asked for the band: the pane, which it steps aside for, closes.
      await $.ui.close({ id: PANE })
      sites.delete(PANE)
      await update($, isPaneOpen, () => false)
    }
    modeNow = m
    themeNow = t
    await update($, mode, () => m)
    await update($, theme, () => t)
    await update($, size, () => z)
    await update($, place, () => p)
    await $.store.set('prefs', { mode: m, theme: t, size: z, place: p, idle: idleNow })
    wake()

    return { text }
  })
}
