// Helpers the tests share: reading Raster cells, a session staged with the
// plugin in it, and the drawings the tests mount.

import type { ConfigRow, On, SessionUsage, ToolCallResult, UiPane } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

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
 * How `staged` sets the session up: the `/viz` mode, the context, the
 * environment, Claude Code's theme, whether the terminal has room for the
 * pane, and whether a hook refuses to open it.
 */
export type Stage = {
  mode?: string
  context?: () => object
  env?: Record<string, string>
  theme?: string
  hasRoom?: boolean
  isPaneRefused?: boolean
}

/** How red the bars are: red over green, on average over the cells drawn. */
export const redness = (cells: string, columns = 80) => {
  const drawn = colors(cells, columns)
    .flat()
    .filter(c => c !== 0)
  return drawn.reduce((sum, c) => sum + ((c >> 16) & 0xff) - ((c >> 8) & 0xff), 0) / Math.max(1, drawn.length)
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
 * A session with the band above the prompt while Claude works, in `mode`, and
 * its frames kept: tool calls run until the test finishes them, each check
 * beneath asks, and the context, the environment and the theme are as given.
 */
export const staged = async ($: Engine, on: On, { mode = 'always', context, env = {}, theme, hasRoom = true, isPaneRefused = false }: Stage = {}) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, env)
  // Claude Code's theme setting, as /config lists it and changes it.
  let setting = theme
  if (theme !== undefined) on('config.list', () => ({ value: [{ key: 'theme', value: setting }] as unknown as ConfigRow[] }))
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
  // while a dialog covers the band, none reach it.
  const drawn = new Map<string, string>()
  const blits = new Map<string, number>()
  let isCovered = false
  on('ui.blit', ($, e) => {
    blits.set(e.key, (blits.get(e.key) ?? 0) + 1)
    if (isCovered) return { value: { deny: 'covered by a dialog' } }
    if ('cells' in e) drawn.set(e.key, e.cells)

    return { value: {} }
  })
  const running = new Map<string, (ran: ToolCallResult) => void>()
  on('tool.call', ($, e) => new Promise<ToolCallResult>(resolve => running.set(e.tool_use_id ?? '', resolve)))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('classic.PermissionRequest', () => ({}))
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
    on('session.usage', () => ({ value: { startedAt: 0, context: context(), rateLimits: [] } as unknown as SessionUsage }))
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
    /** A dialog opens over the band, or closes. */
    cover: (is: boolean) => {
      isCovered = is
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
