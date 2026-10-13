// Helpers the tests share: reading Raster cells, a session staged with the
// plugin in it, and the drawings the tests mount.

import type { ConfigRow, On, PermissionRequestDecision, SessionContextBreakdown, SessionContextUsage, ToolCallResult, UiPane } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Bars } from '../hooks/engine/bars'
import { canvas, pack } from '../hooks/engine/cells'
import { inkOf } from '../hooks/engine/color'
import type { Ink } from '../hooks/engine/color'
import type { Spectrum } from '../hooks/engine/spectrum'

/** The glyphs of Raster cells, row by row. */
export const text = (cells: string, columns: number): string[] => {
  const raw = atob(cells)
  const rows: string[] = []
  let row = ''
  for (let i = 0; i < raw.length; i += 12) {
    const code = raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8) | (raw.charCodeAt(i + 2) << 16)
    row += String.fromCharCode(code)
    if (row.length === columns) {
      rows.push(row)
      row = ''
    }
  }
  return rows
}

/** The foreground colors of Raster cells, row by row. */
export const colors = (cells: string, columns: number): number[][] => {
  const raw = atob(cells)
  const rows: number[][] = []
  for (let i = 0; i < raw.length; i += 12) {
    if ((i / 12) % columns === 0) rows.push([])
    rows.at(-1)!.push(raw.charCodeAt(i + 4) | (raw.charCodeAt(i + 5) << 8) | (raw.charCodeAt(i + 6) << 16))
  }
  return rows
}

/** The ink the tests draw in where the colors are not the point: the instrument theme's, on a dark background. */
export const ink = inkOf('instrument', 'dark')

/** Bars as Raster cells of their own, drawn as a board draws them: in `ink`, over `spectrum`; with `labels`, each tool's name over its band. */
export const painted = (bars: Bars, ink: Ink, spectrum?: Spectrum, labels = false): string => {
  const into = canvas(bars.columns, bars.rows)
  bars.draw(into, ink, spectrum, labels)
  return pack(into.words)
}

export const band = (isWorking: boolean) => ({
  plugin: 'visualizer',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
})

/** A store that keeps the prefs written to it, each write in turn, starting from `initial`. */
export const prefsStore = (on: On, initial?: Record<string, unknown>) => {
  const saved: unknown[] = initial === undefined ? [] : [initial]
  on('store.get', ($, e) => ({ value: e.key === 'prefs' ? saved.at(-1) : undefined }))
  on('store.set', ($, e) => {
    if (e.key === 'prefs') saved.push(e.value)

    return { value: undefined }
  })
  return saved
}

/**
 * The context window as a test gives it: the status line's figures and, of
 * /context's breakdown, what the plugin reads. `staged` reports the rest of
 * the breakdown as a session with nothing else in its window would.
 */
export type Window = Omit<SessionContextUsage, 'breakdown'> & {
  breakdown?: Pick<SessionContextBreakdown, 'totalTokens' | 'isAutoCompactEnabled' | 'autoCompactThreshold'>
}

/** A window as `$.session.usage` reports it, its breakdown whole. */
const usageOf = ({ breakdown, ...context }: Window): SessionContextUsage => {
  if (breakdown === undefined) return context
  const { window } = context
  return {
    ...context,
    breakdown: {
      categories: [],
      maxTokens: window,
      rawMaxTokens: window,
      autocompactSource: 'model-default',
      percentage: window > 0 ? Math.round((100 * breakdown.totalTokens) / window) : 0,
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: null,
      ...breakdown,
    },
  }
}

/** Claude Code's theme setting, as `/config` lists it. */
const themeRow = (value: string): ConfigRow => ({
  key: 'theme',
  label: 'Theme',
  kind: 'choice',
  value,
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
})

/**
 * How `staged` sets the session up: the `/viz` arguments run once it starts
 * (its `mode`), the context, the environment, Claude Code's theme, whether the
 * terminal has room for the pane, whether a hook refuses to open it, and what
 * a settings hook answers a permission request with, if anything.
 */
export type Stage = {
  mode?: string
  context?: () => Window
  env?: Record<string, string>
  theme?: string
  hasRoom?: boolean
  isPaneRefused?: boolean
  decision?: PermissionRequestDecision
}

/** How red the bars are: red over green, on average over the cells drawn. */
export const redness = (cells: string, columns = 80) => {
  const drawn = colors(cells, columns)
    .flat()
    .filter(c => c !== 0)
  return drawn.reduce((sum, c) => sum + ((c >> 16) & 0xff) - ((c >> 8) & 0xff), 0) / Math.max(1, drawn.length)
}

/**
 * A color's hue, named as the tests tell colors apart: the amber of a wait, the
 * red of an error, the green of a meter with room. A color with little in it
 * (a gray, a white) is `gray`, however light or dark.
 */
export type Hue = 'red' | 'orange' | 'amber' | 'yellow' | 'green' | 'cyan' | 'blue' | 'violet' | 'gray'

/** The hue a color reads as: by its angle on the color wheel, `gray` when it has too little color to have one. */
export const hueOf = (color: number): Hue => {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const max = Math.max(r, g, b)
  const spread = max - Math.min(r, g, b)
  if (max === 0 || spread / max < 0.25) return 'gray'
  const sector = max === r ? (g - b) / spread + 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4
  const degrees = (sector * 60) % 360
  const bounds: [number, Hue][] = [[15, 'red'], [30, 'orange'], [45, 'amber'], [70, 'yellow'], [165, 'green'], [200, 'cyan'], [250, 'blue'], [330, 'violet']]
  return bounds.find(([below]) => degrees < below)?.[1] ?? 'red'
}

/** How amber a drawing's bars are, below its label row: the share of the cells drawn that are. */
export const amberness = (cells: string, columns = 80) => {
  const drawn = colors(cells, columns)
    .slice(1)
    .flat()
    .filter(c => c !== 0)
  return drawn.filter(c => hueOf(c) === 'amber').length / Math.max(1, drawn.length)
}

/** How many bar glyphs stand in each third of a drawing, below its label row: left, middle, right. */
export const thirds = (cells: string, columns = 80) => {
  const rows = text(cells, columns).slice(1)
  const counts = [0, 0, 0]
  for (const row of rows) {
    for (let c = 0; c < columns; c++) if (/[▂-█]/.test(row[c] ?? '')) counts[Math.min(2, Math.floor((3 * c) / columns))]! += 1
  }
  return counts
}

/**
 * A session with the band above the prompt while Claude works, and its frames
 * kept: tool calls run until the test finishes them, each check beneath asks,
 * and the context, the environment and the theme are as given.
 *
 * Unless `mode` says otherwise, `/viz always` runs as it starts; and the band
 * is mounted for a Claude at work (`isWorking`), which it stays until a test
 * redraws it. A band shown always plays its idle show after 8 s of quiet
 * (`IDLE_DELAY`), unless `/viz idle off` stops it: a test that reads the
 * label, or counts frames, over a quiet spell that long says the mode it needs.
 */
export const staged = async ($: Engine, on: On, { mode = 'always', context, env = {}, theme, hasRoom = true, isPaneRefused = false, decision }: Stage = {}) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, env)
  // Claude Code's theme setting, as /config lists it and changes it.
  let setting = theme
  if (theme !== undefined) on('config.list', () => ({ value: setting === undefined ? [] : [themeRow(setting)] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('ui.render', { component: 'ToolProgress' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.hint}</Text>
  })
  // The frames that reached the screen, and how many were sent, by drawing;
  // while a dialog covers a drawing, none reach it.
  const drawn = new Map<string, string>()
  const blits = new Map<string, number>()
  let covered: (key: string) => boolean = () => false
  on('ui.blit', ($, e) => {
    blits.set(e.key, (blits.get(e.key) ?? 0) + 1)
    if (covered(e.key)) return { value: { deny: 'covered by a dialog' } }
    if ('cells' in e) drawn.set(e.key, e.cells)

    return { value: {} }
  })
  const running = new Map<string, (ran: ToolCallResult) => void>()
  on('tool.call', ($, e) => new Promise<ToolCallResult>(resolve => running.set(e.tool_use_id ?? '', resolve)))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('classic.PermissionRequest', () => (decision === undefined ? {} : { decision }))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('config.set', ($, e) => {
    if (e.key === 'theme' && typeof e.value === 'string') setting = e.value

    return { value: e.value }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // The panes open, as the engine lists them: placed if there was room, until closed.
  const panes = new Map<string, UiPane>()
  on('ui.open', ($, e) => {
    if (isPaneRefused) return { deny: 'refused' }
    panes.set(e.id, { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: hasRoom })

    return { value: hasRoom ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'too narrow' } }
  })
  let closes = 0
  on('ui.close', ($, e) => {
    closes += 1
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes.values()] }))
  on('prompt.edit', ($, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  if (context !== undefined) {
    on('session.usage', () => ({ value: { startedAt: 0, context: usageOf(context()), rateLimits: [] } }))
  }

  const viz = (args: string) =>
    $.command.run({ command: 'viz', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await viz(mode)
  const ui = await $.ui.mount(band(true))
  return {
    clock,
    ui,
    viz,
    /** The band's cells as last drawn, or another drawing's by its key. */
    cells: (key = 'band') => drawn.get(key) ?? '',
    /** The band's top row, where its labels go. */
    label: () => text(drawn.get('band') ?? '', 80)[0] ?? '',
    /** How many frames were sent, of one drawing or of all. */
    blits: (key?: string) => (key === undefined ? [...blits.values()].reduce((sum, n) => sum + n, 0) : (blits.get(key) ?? 0)),
    /** Ends a running call, as the tool answered. */
    finish: (id: string, ran: ToolCallResult = { result: 'done' }) => running.get(id)?.(ran),
    /** A dialog opens over the drawings, or only the one of `key`, or closes. */
    cover: (is: boolean, key?: string) => {
      covered = is ? drawing => key === undefined || drawing === key : () => false
    },
    /** How many times a pane was closed. */
    closes: () => closes,
    /** The pane goes as an unload drops it: gone from the engine's list, no `ui.close` raised. */
    unload: (id = 'viz') => panes.delete(id),
  }
}

/** The pane's drawing, as the terminal mounts it beside the transcript. */
export const pane = {
  plugin: 'visualizer',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'viz',
  props: { title: 'Visualizer', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}
