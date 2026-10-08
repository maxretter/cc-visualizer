import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { VizMode, VizSize, VizTheme } from '../types'
import { Bars, FRAME_MS, Spectrum, THEME_NAMES, sourceOf, trail } from './engine'
import type { Layout } from './engine'

const PANE = 'viz'
const BAND_ROWS = 4
const PANE_ROWS = 32
const MINI_COLUMNS = 32
const MINI_ROWS = 2
const MINI_LAYOUT: Layout = { width: 1, gap: 1 }
/** The most columns the tool names beside the mini spectrum take. */
const MINI_NAMES = 56
const MODES: readonly VizMode[] = ['auto', 'always', 'off']
const SIZES: readonly VizSize[] = ['full', 'mini']

const mode = atom({ plugin: 'visualizer', key: 'mode' } as const, 'auto')
const theme = atom({ plugin: 'visualizer', key: 'theme' } as const, 'instrument')
const size = atom({ plugin: 'visualizer', key: 'size' } as const, 'full')
const isPlaying = atom({ plugin: 'visualizer', key: 'isPlaying' } as const, false)
const isPaneOpen = atom({ plugin: 'visualizer', key: 'isPaneOpen' } as const, false)

const isMode = (v: unknown): v is VizMode => MODES.includes(v as VizMode)
const isTheme = (v: unknown): v is VizTheme => THEME_NAMES.includes(v as VizTheme)
const isSize = (v: unknown): v is VizSize => SIZES.includes(v as VizSize)
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)))

const USAGE = [
  '/viz               toggle the band above the prompt',
  '/viz auto          show it while Claude works (default)',
  '/viz always        keep it up, flat while idle',
  '/viz off           hide it, and close the pane',
  '/viz mini          a small spectrum at the right edge',
  '/viz full          the band across the whole width',
  '/viz pane          a big view with a legend',
  '/viz demo          play a few bars without a turn',
  `/viz theme [name]  ${THEME_NAMES.join(', ')}`,
].join('\n')

/** A drawing the frames repaint: its bars, and the raster of tool names beside a mini one. */
type Site = {
  requestId: string
  key: string
  bars: Bars
  labels: boolean
  names?: { key: string; columns: number; rows: number }
}

type Mount = { layout?: Layout; labels?: boolean; names?: Site['names'] }

export const register: Register = on => {
  // The animation is the module's own: a reload starts it from silence.
  const spectrum = new Spectrum()
  const sites = new Map<string, Site>()
  let ticker: Timer | undefined
  let modeNow: VizMode = 'auto'
  let themeNow: VizTheme = 'instrument'
  // Runs the frames until the music stops and the bars have fallen; made by
  // session.start, whose `$` the frames draw through.
  let wake = () => {}

  // A drawing of the same key and size keeps its bars where they stood.
  const mount = (requestId: string, key: string, columns: number, rows: number, extra: Mount = {}): Site => {
    const had = sites.get(requestId)
    const isSame = had?.key === key && had.bars.columns === columns && had.bars.rows === rows
    const bars = isSame ? had.bars : new Bars(columns, rows, extra.layout)
    const site = { requestId, key, bars, labels: extra.labels ?? false, names: extra.names }
    sites.set(requestId, site)
    return site
  }

  on('session.start', async ($, e, next) => {
    const blit = (site: Site, key: string, cells: string) => {
      void $.ui.blit({ requestId: site.requestId, key, cells }).then(
        sent => {
          if (sent.deny !== undefined && sites.get(site.requestId) === site) sites.delete(site.requestId)
        },
        () => {},
      )
    }
    const frame = () => {
      spectrum.step()
      for (const site of sites.values()) {
        site.bars.step(spectrum)
        blit(site, site.key, site.bars.paint(themeNow, spectrum, site.labels))
        if (site.names) blit(site, site.names.key, trail(spectrum, themeNow, site.names.columns, site.names.rows))
      }
      if (spectrum.isQuiet() && [...sites.values()].every(site => site.bars.isSettled())) {
        ticker?.cancel()
        ticker = undefined
        void update($, isPlaying, () => false)
      }
    }
    wake = () => {
      if (ticker !== undefined || (modeNow === 'off' && sites.size === 0)) return
      ticker = $.clock.every(FRAME_MS, frame)
      void update($, isPlaying, () => true)
    }

    await $.command.register({
      name: 'viz',
      description: 'Music visualizer for what Claude is doing',
      argumentHint: '[auto|always|off|mini|full|pane|demo|theme <name>]',
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
    if (isSize(savedSize)) await update($, size, () => savedSize)
    await update($, isPlaying, () => false)

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
    wake()
    try {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError === true) spectrum.error()

      return ran
    } finally {
      spectrum.endCall(call)
    }
  }).catch(($, e, next) => next(e))

  // The turn ends: a cymbal, a record scratch when interrupted, red on an error.
  on('turn.complete', ($, e, next) => {
    if (e.reason === 'aborted') spectrum.scratch()
    else if (e.reason === 'answer') spectrum.cymbal(e.agentId === undefined ? 1 : 0.4)
    else spectrum.error()
    wake()

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [m, t, s, playing, paneOpen] = await Promise.all([
      read($, mode),
      read($, theme),
      read($, size),
      read($, isPlaying),
      read($, isPaneOpen),
    ])
    modeNow = m
    themeNow = t
    const isShown = m === 'always' || (m === 'auto' && (e.props.isWorking || playing))
    if (e.surface !== 'terminal' || e.props.hasSurvey || paneOpen || !isShown) {
      sites.delete(e.requestId)

      return next(e)
    }

    const { Box, Raster } = $.ui.resolve(e)
    const room = clamp(e.props.maxRows - 1, 1, 256)
    if (s === 'mini') {
      const columns = clamp(Math.min(MINI_COLUMNS, e.props.bodyColumns), 1, 512)
      const rows = Math.min(MINI_ROWS, room)
      const nameColumns = Math.min(MINI_NAMES, e.props.bodyColumns - columns)
      const names = nameColumns >= 8 ? { key: 'names', columns: nameColumns, rows } : undefined
      const site = mount(e.requestId, 'mini', columns, rows, { layout: MINI_LAYOUT, names })

      return (
        <Box width={e.props.bodyColumns} justifyContent="flex-end">
          {names && <Raster key="names" columns={names.columns} rows={rows} cells={trail(spectrum, t, names.columns, rows)} />}
          <Raster key="mini" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum)} />
        </Box>
      )
    }

    const columns = clamp(e.props.bodyColumns, 1, 512)
    const rows = Math.min(BAND_ROWS, room)
    const site = mount(e.requestId, 'band', columns, rows, { labels: true })

    return <Raster key="band" columns={columns} rows={rows} cells={site.bars.paint(t, spectrum, true)} />
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
    const site = mount(PANE, 'pane', columns, rows, { labels: true })

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
    let text: string

    if (verb === '' || verb === 'toggle') {
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
      const shape = verb === 'mini' ? 'mini, at the right edge' : 'full width'
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
    }
    modeNow = m
    themeNow = t
    await update($, mode, () => m)
    await update($, theme, () => t)
    await update($, size, () => z)
    await $.store.set('prefs', { mode: m, theme: t, size: z })
    wake()

    return { text }
  })
}
