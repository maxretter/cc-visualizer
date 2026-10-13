// The hooks that reach the world through `$`: the session's start, which
// hands the frames its `$`, the context window, Claude Code's settings, the
// drawings, and /viz. The hooks that only play the music are in music.ts, the
// session they share is stage.ts's, and frames.ts runs its frames. What to do
// is decided in viz.ts and the music in engine/; this reads the world, asks
// them, and does what they say.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { VizMode, VizSize, VizTheme } from '../types'
import type { Layout } from './engine/bars'
import { DOCTOR_ROWS, swatches } from './engine/doctor'
import { trail } from './engine/trail'
import { Frames } from './frames'
import { music } from './music'
import { Stage } from './stage'
import {
  DEFAULTS,
  DOCTOR_HINTS,
  HINT,
  PANE_WAITS,
  changes,
  command,
  doctorReport,
  factsOf,
  isBandShown,
  isMode,
  isPlace,
  isSize,
  isTheme,
  measuredFrom,
  percentOf,
  prefsFrom,
  verbOf,
} from './viz'
import type { Measured, Prefs, Terminal, View } from './viz'

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
/** The column of names beside the doctor's swatches. */
const DOCTOR_NAMES = 8

// The prefs the drawings read, published from the plugin's own copy, and what plays.
const mode = atom({ plugin: 'visualizer', key: 'mode' } as const, DEFAULTS.mode)
const theme = atom({ plugin: 'visualizer', key: 'theme' } as const, DEFAULTS.theme)
const size = atom({ plugin: 'visualizer', key: 'size' } as const, DEFAULTS.size)
const place = atom({ plugin: 'visualizer', key: 'place' } as const, DEFAULTS.place)
const isPlaying = atom({ plugin: 'visualizer', key: 'isPlaying' } as const, false)
const isPaneOpen = atom({ plugin: 'visualizer', key: 'isPaneOpen' } as const, false)

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)))

/** A value read back from the state, checked: another plugin may have rewritten it. Else `own`, the plugin's copy. */
function checked<T>(is: (value: unknown) => value is T, value: unknown, own: T): T {
  return is(value) ? value : own
}

/** The context window now, with its breakdown: the meter, and where its top is. */
async function measureContext($: EngineInterface): Promise<Measured> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  return measuredFrom(context)
}

/** Claude Code's theme setting, as `/config` shows it: `dark`, `light`, `auto`, or another. */
async function themeOf($: EngineInterface): Promise<unknown> {
  return (await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value
}

/** The terminal's own say, for the doctor: its TERM, COLORTERM and TERM_PROGRAM, each unset if it cannot be read. */
async function terminalOf($: EngineInterface): Promise<Terminal> {
  const [term, colorterm, program] = await Promise.all([
    $.env.get('TERM').catch(() => undefined),
    $.env.get('COLORTERM').catch(() => undefined),
    $.env.get('TERM_PROGRAM').catch(() => undefined),
  ])
  return { term, colorterm, program }
}

/** The prefs, published for the drawings, which redraw as they change: each written only if it did. */
async function publish($: EngineInterface, prefs: Prefs) {
  const [m, t, s, p] = await Promise.all([read($, mode), read($, theme), read($, size), read($, place)])
  await Promise.all([
    m !== prefs.mode && update($, mode, () => prefs.mode),
    t !== prefs.theme && update($, theme, () => prefs.theme),
    s !== prefs.size && update($, size, () => prefs.size),
    p !== prefs.place && update($, place, () => prefs.place),
  ])
}

/** Where the band goes and whether it is on, as a drawing reads them back: checked, else as `own` has them. */
async function placedOf($: EngineInterface, own: Prefs) {
  const [m, p] = await Promise.all([read($, mode), read($, place)])
  return { mode: checked(isMode, m, own.mode), place: checked(isPlace, p, own.place) }
}

/** The band's look, as a drawing reads it back: checked, else as `own` has it. */
async function looksOf($: EngineInterface, own: Prefs) {
  const [t, s] = await Promise.all([read($, theme), read($, size)])
  return { theme: checked(isTheme, t, own.theme), size: checked(isSize, s, own.size) }
}

/**
 * What the band at the prompt is told. What plays matters only in auto while
 * Claude rests, and is read only then: a change of pace redraws no drawing it
 * cannot move.
 */
async function viewOf($: EngineInterface, m: VizMode, props: { isWorking: boolean; hasSurvey?: boolean }): Promise<View> {
  const [playing, paneOpen] = await Promise.all([m === 'auto' && !props.isWorking ? read($, isPlaying) : false, read($, isPaneOpen)])
  return { surface: 'terminal', isWorking: props.isWorking, hasSurvey: props.hasSurvey, isPlaying: playing === true, isPaneOpen: paneOpen === true }
}

/**
 * Whether the pane is open and drawn, as the engine lists it, published for
 * the band, which steps aside for it. Not as this plugin last said: a pane an
 * unload closed never tells it, and one opened may wait undrawn.
 */
async function notePane($: EngineInterface) {
  const isDrawn = await $.ui.panes().then(
    panes => panes.some(pane => pane.id === PANE && pane.isPlaced),
    () => false,
  )
  if ((await read($, isPaneOpen)) !== isDrawn) await update($, isPaneOpen, () => isDrawn)
}

/** The subagents at work through a reload, each back in a channel of its own; the rest known, should they work again. */
async function rejoinAgents($: EngineInterface, stage: Stage) {
  const { ensemble } = stage
  for (const agent of await $.agent.list()) {
    // A teammate in a terminal pane of its own, whose id is its address, sends nothing here.
    if (agent.id === agent.teammateId) continue
    const info = { name: agent.name, description: agent.description, type: agent.type }
    if (agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting') ensemble.join(agent.id, info)
    else ensemble.know(agent.id, info)
  }
  if (!ensemble.isCalm()) stage.wake()
}

export const register: Register = on => {
  const stage = new Stage(PANE)
  const { spectrum, ensemble, sites } = stage
  // The frames, kept through a start again, which finds them as they run.
  const frames = new Frames(stage)

  on('session.start', async ($, e, next) => {
    // The frames run through this start's `$` from now on, and only in a
    // terminal: a `-p` run, the SDK and the desktop draw no band.
    frames.bind({
      isTerminal: e.surface === 'terminal',
      every: (ms, fn) => $.clock.every(ms, fn),
      now: () => $.clock.now(),
      blit: args => $.ui.blit(args),
      tell: () => void update($, isPlaying, () => frames.isAwake),
    })
    stage.bind(frames)

    // What the first prompt needs, side by side, each step on its own so that
    // one refused leaves the rest to run.
    await Promise.all(
      [
        // /viz, listed by the first prompt.
        $.command.register({ name: 'viz', description: 'Music visualizer for what Claude is doing', argumentHint: HINT, immediate: true }),
        // The settings as saved, published for the drawings.
        $.store.get('prefs').then(saved => {
          stage.prefs = prefsFrom(saved)
          return publish($, stage.prefs)
        }),
        // The pane as the engine has it: the state outlives a reload, and an unload's close never reached this plugin.
        notePane($),
        // The terminal's background, as Claude Code's theme and the terminal tell it.
        Promise.all([themeOf($), $.env.get('COLORFGBG').catch(() => undefined)]).then(([setting, colorfgbg]) => {
          stage.backdrop = { theme: setting, colorfgbg }
        }),
        // Playing or not as the frames are now: a reload mid-turn may have woken them already.
        update($, isPlaying, () => frames.isAwake),
      ].map(step => step.catch(() => {})),
    )
    // A band that stays up plays its idle show from the start, as it did before a reload.
    stage.rest()

    // These can follow the first prompt, each on its own too. The meter as it
    // stood, after a reload or on a resumed session.
    void measureContext($).then(context => stage.remeasured(context), () => {})
    // The subagents at work through a reload, each back in a channel of its own.
    void rejoinAgents($, stage).catch(() => {})

    return next(e)
  })

  // Prompts, the response, tool calls and their asks, the ends of turns, subagents.
  music(on, stage)

  // The context window, measured after each turn: the meter at the right edge.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      // Another window, or a top not known yet (read before the session was bound): measured again.
      if (e.context.window !== stage.windowSize || stage.limit === undefined) await measureContext($).then(context => stage.measured(context), () => {})
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

  // Claude Code's theme changes: once it is written, the band follows it onto
  // a light background or off one. It watches, and passes the change on unchanged.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    if (set.deny === undefined) {
      stage.backdrop = { ...stage.backdrop, theme: set.value }
      if (sites.size > 0) stage.wake()
    }

    return set
  })

  // Auto-compact turned on or off: once it is written, the top of the meter
  // moves. It watches, and passes the change on unchanged.
  on('config.set', { key: 'autoCompact' }, async ($, e, next) => {
    const set = await next(e)
    if (set.deny === undefined) void measureContext($).then(context => stage.remeasured(context), () => {})

    return set
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

  // Above the prompt: the band in the slot over the input. Another surface
  // draws the engine's own, having read nothing: it never redraws as the
  // music plays, and the terminal's drawing is left as it is.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    stage.isWorking = e.props.isWorking
    // A switch of transcript draws this again: told even while the band is down, for the band below.
    stage.viewed = e.props.view?.agentId
    const prefs = await placedOf($, stage.prefs)
    if (e.props.bodyColumns !== stage.bodyColumns) {
      const had = stage.bodyColumns
      stage.bodyColumns = e.props.bodyColumns
      // A pane docked or closed: the band below the prompt fits itself again.
      if (had !== undefined && prefs.place === 'below') $.ui.invalidate('ui.render')
    }
    // The band down: the engine's own. Off or below, it reads nothing more.
    if (prefs.mode === 'off' || prefs.place !== 'above' || !isBandShown(prefs, await viewOf($, prefs.mode, e.props), 'above')) {
      sites.delete(e.requestId)

      return next(e)
    }

    const { theme: t, size: s } = await looksOf($, stage.prefs)
    return band($.ui.resolve(e), e.requestId, s, t, e.props.bodyColumns, clamp(e.props.maxRows - 1, 1, 256))
  })

  // Below the prompt: the band over the hint line, which stays as the engine
  // draws it. Another surface, or the band off or above: the hint line as it
  // comes, with nothing more read.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    stage.isWorking = e.props.isWorking
    const prefs = await placedOf($, stage.prefs)
    if (prefs.mode === 'off' || prefs.place !== 'below') {
      sites.delete(e.requestId)

      return next(e)
    }
    const view = await viewOf($, prefs.mode, e.props)
    const hint = await next(e)
    if (!isBandShown(prefs, view, 'below')) {
      sites.delete(e.requestId)

      return hint
    }

    const { theme: t, size: s } = await looksOf($, stage.prefs)
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
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>The visualizer draws in the terminal.</Text>
    }

    const t = checked(isTheme, await read($, theme), stage.prefs.theme)
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

  // The pane closed, by /viz, the person or another plugin: the band is back,
  // unless the engine still lists the pane (a hook kept it open).
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      sites.delete(PANE)
      await notePane($)
    }

    return closed
  }).catch(($, e, next) => next(e))

  // /viz doctor's report on the terminal: what it found, then a swatch for
  // each check beside its name, painted for the background the band paints for.
  on('ui.render', { component: 'CommandOutput', props: { command: 'viz' } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored || verbOf(e.props.args) !== 'doctor') return next(e)
    const t = checked(isTheme, await read($, theme), stage.prefs.theme)
    const { Box, Text, Raster } = $.ui.resolve(e)
    // As wide as the transcript has room for beside the names, 64 at most. The
    // row is told no width of its own: the prompt's column, as the band above
    // was told it, else the screen's, each less the engine's five.
    const width = stage.bodyColumns ?? (e.viewport?.columns ?? 80) - 5
    const columns = clamp(width - DOCTOR_NAMES, 1, 64)

    return (
      <Box flexDirection="column">
        <Text bold>Visualizer doctor</Text>
        <Text>{factsOf(e.props.text).join('\n')}</Text>
        <Box flexDirection="row" marginY={1}>
          <Box flexDirection="column" width={DOCTOR_NAMES}>
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
    const outcome = command(e.args, stage.prefs, { isPaneOpen: (await read($, isPaneOpen)) === true, backdrop: stage.backdrop })
    switch (outcome.kind) {
      case 'reply':
        return { text: outcome.text }
      case 'doctor':
        return { text: doctorReport(await terminalOf($), stage.prefs, stage.backdrop) }
      case 'set': {
        let { text } = outcome
        if (outcome.pane === 'open') {
          // The band steps aside once the pane is drawn, not before: an open
          // refused, or one that waits undrawn, leaves it where it was.
          try {
            const opened = await $.ui.open({ id: PANE, title: 'Visualizer', rows: 14 })
            if (!opened.isPlaced) text = PANE_WAITS
          } finally {
            await notePane($)
          }
        } else if (outcome.pane === 'close') {
          await $.ui.close({ id: PANE })
          if (outcome.isOff) sites.clear()
          else sites.delete(PANE)
          await notePane($)
        }
        if (outcome.isDemo) spectrum.playDemo(ensemble)
        const before = stage.prefs
        stage.prefs = outcome.prefs
        await publish($, stage.prefs)
        // Save what this command changed over what is saved: another session may
        // have saved the rest since this one read it. What is saved is read as the
        // prefs, so a key no pref has, or a value none takes, is not kept.
        const changed = changes(before, stage.prefs)
        if (Object.keys(changed).length > 0) {
          await $.store.set('prefs', { ...prefsFrom(await $.store.get('prefs')), ...changed })
        }
        stage.wake()

        return { text }
      }
    }
  })
}
