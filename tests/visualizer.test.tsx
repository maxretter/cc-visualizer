import type { ConfigRow, On, PromptEditInput, PromptEditResult, SessionUsage, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  BEAT,
  Bars,
  FRAME_MS,
  GRACE,
  GROUND,
  IDLE_DELAY,
  SOURCES,
  Spectrum,
  Step,
  clockText,
  encodeBase64,
  idleText,
  legible,
  luminance,
  mix,
  placeOf,
  shortName,
  sourceOf,
  swatches,
  toneOf,
  trail,
} from '../hooks/engine'
import type { Chunk, SourceId } from '../hooks/engine'
import { PANE_WAITS } from '../hooks/viz'

/** The glyphs of Raster cells, row by row. */
const text = (cells: string, columns: number): string[] => {
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
const colors = (cells: string, columns: number): number[][] => {
  const raw = atob(cells)
  const rows: number[][] = []
  for (let i = 0; i < raw.length; i += 12) {
    if ((i / 12) % columns === 0) rows.push([])
    rows.at(-1)!.push(raw.charCodeAt(i + 4) | (raw.charCodeAt(i + 5) << 8) | (raw.charCodeAt(i + 6) << 16))
  }
  return rows
}

const band = (isWorking: boolean) => ({
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
const prefsStore = (on: On, initial?: Record<string, unknown>) => {
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
 * environment, Claude Code's theme, and whether the terminal has room for the pane.
 */
type Stage = { mode?: string; context?: () => object; env?: Record<string, string>; theme?: string; hasRoom?: boolean }

/** How red the bars are: red over green, on average over the cells drawn. */
const redness = (cells: string, columns = 80) => {
  const drawn = colors(cells, columns)
    .flat()
    .filter(c => c !== 0)
  return drawn.reduce((sum, c) => sum + ((c >> 16) & 0xff) - ((c >> 8) & 0xff), 0) / Math.max(1, drawn.length)
}

/** How many bar glyphs stand in each third of a drawing, below its label row: left, middle, right. */
const thirds = (cells: string, columns = 80) => {
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
const staged = async ($: Engine, on: On, { mode = 'always', context, env = {}, theme, hasRoom = true }: Stage = {}) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, env)
  if (theme !== undefined) on('config.list', () => ({ value: [{ key: 'theme', value: theme }] as unknown as ConfigRow[] }))
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
  on('config.set', ($, e) => ({ value: e.value }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.open', () => ({ value: hasRoom ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'too narrow' } }))
  let closes = 0
  on('ui.close', () => {
    closes += 1

    return { value: undefined }
  })
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
    /** The band's cells as last drawn. */
    cells: () => drawn.get('band') ?? '',
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
  }
}

/** The pane's drawing, as the terminal mounts it beside the transcript. */
const pane = {
  plugin: 'visualizer',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'viz',
  props: { title: 'Visualizer', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

describe('engine', () => {
  test('tools land on their instruments', () => {
    expect(sourceOf('Read')).toBe('read')
    expect(sourceOf('Edit')).toBe('edit')
    expect(sourceOf('Bash')).toBe('bash')
    expect(sourceOf('mcp__claude-in-chrome__navigate')).toBe('web')
    expect(sourceOf('Agent')).toBe('agent')
  })

  test('a hit raises the bars, which fall back to the floor once quiet', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(60, 4)
    spectrum.hit('bash')
    spectrum.step()
    bars.step(spectrum)
    expect(bars.isSettled()).toBe(false)
    for (let i = 0; i < 400; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    expect(spectrum.isQuiet()).toBe(true)
    expect(bars.isSettled()).toBe(true)
  })

  test('a running tool holds a note until it is released', () => {
    const spectrum = new Spectrum()
    spectrum.hold('read')
    for (let i = 0; i < 200; i++) spectrum.step()
    expect(spectrum.isQuiet()).toBe(false)
    spectrum.release('read')
    for (let i = 0; i < 200; i++) spectrum.step()
    expect(spectrum.isQuiet()).toBe(true)
  })

  test('cells cover the whole raster in every theme', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(37, 5)
    spectrum.playDemo()
    for (let i = 0; i < 30; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    for (const theme of ['instrument', 'claude', 'synthwave', 'classic'] as const) {
      // 12 bytes a cell, base64 is 4 characters per 3 bytes.
      expect(bars.paint(theme, spectrum, true).length).toBe((37 * 5 * 12 * 4) / 3)
      expect(bars.legend(theme).length).toBe((37 * 12 * 4) / 3)
    }
  })
})

describe('time', () => {
  test('the music keeps time at any frame rate', () => {
    // A prompt's sweep, an error's flash, the meter filling, and apart, the
    // brainwave coming in: 600 ms of each at 60, 30 and 15 ms a frame.
    const played = (step: number, start: (spectrum: Spectrum) => void) => {
      const spectrum = new Spectrum()
      start(spectrum)
      for (let t = 0; t < 600; t += step) spectrum.step(step)
      return spectrum
    }
    const sent = (s: Spectrum) => {
      s.kick()
      s.error()
      s.measure(60)
    }
    const thinking = (s: Spectrum) => s.beginThinking()
    const full = played(30, sent)
    for (const step of [60, 15]) {
      const other = played(step, sent)
      expect(other.now).toBe(600)
      const reads: ((s: Spectrum) => number)[] = [s => s.flash, s => s.gauge, s => s.at(0.9)]
      for (const read of reads) {
        expect(Math.abs(read(other) - read(full))).toBeLessThan(1e-6)
      }
      expect(Math.abs(played(step, thinking).mind - played(30, thinking).mind)).toBeLessThan(1e-6)
    }
    // The sweep crossed the spectrum at its own speed, not a step's.
    expect(full.at(0.9)).toBeGreaterThan(full.at(0.6) + 0.5)
  })

  test('a long gap moves the clocks, not the bars', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4)
    spectrum.ask('bash', spectrum.startCall('Bash'))
    spectrum.step()
    bars.step(spectrum)
    // The laptop sleeps through ten minutes of waiting.
    spectrum.step(600_000)
    bars.step(spectrum)
    expect(spectrum.dt).toBe(250)
    expect(clockText(spectrum.waitedFor!)).toBe('10:00')
    const [, bottom] = text(trail(spectrum, 'instrument', 50, 2), 50)
    expect(bottom).toContain('waiting on you · 10:00')
  })
})

describe('tool names', () => {
  test('MCP tools drop their server', () => {
    expect(shortName('mcp__claude-in-chrome__navigate')).toBe('navigate')
    expect(shortName('Bash')).toBe('Bash')
  })

  test('repeated calls fold into one name, which fades once they are done', () => {
    const spectrum = new Spectrum()
    const first = spectrum.startCall('Read')
    const second = spectrum.startCall('Read')
    expect(second).toBe(first)
    expect(first.count).toBe(2)
    spectrum.endCall(first)
    spectrum.endCall(second)
    for (let i = 0; i < 60; i++) spectrum.step()
    expect(spectrum.calls).toHaveLength(1)
    for (let i = 0; i < 200; i++) spectrum.step()
    expect(spectrum.calls).toHaveLength(0)
    expect(spectrum.isQuiet()).toBe(true)
  })

  test('the trail puts the newest name at the right, a spinner while it runs', () => {
    const spectrum = new Spectrum()
    spectrum.endCall(spectrum.startCall('Grep'))
    spectrum.startCall('Bash')
    spectrum.step()
    const [top, bottom] = text(trail(spectrum, 'instrument', 30, 2), 30)
    expect(top?.trim()).toBe('')
    expect(bottom?.trimEnd()).toMatch(/Grep \u00b7 \S Bash$/)
  })

  test('the full band names a running tool over its band', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4)
    spectrum.startCall('Edit')
    spectrum.step()
    bars.step(spectrum)
    const [top] = text(bars.paint('instrument', spectrum, true), 80)
    expect(top).toContain('Edit')
    const [unlabelled] = text(bars.paint('instrument', spectrum), 80)
    expect(unlabelled).not.toContain('Edit')
  })
})

describe('thinking', () => {
  const braille = /[\u2801-\u28ff]/

  test('a brainwave rolls above the bars while thinking, then fades', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4)
    spectrum.beginThinking()
    for (let i = 0; i < 30; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    expect(spectrum.mind).toBeGreaterThan(0.5)
    expect(text(bars.paint('instrument', spectrum), 80).join('')).toMatch(braille)

    spectrum.endThinking()
    for (let i = 0; i < 400; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    expect(spectrum.mind).toBe(0)
    expect(text(bars.paint('instrument', spectrum), 80).join('')).not.toMatch(braille)
    expect(spectrum.isQuiet()).toBe(true)
  })

  test('the thinking band wanders, with sparks, rather than keeping a beat', () => {
    const spectrum = new Spectrum()
    spectrum.beginThinking()
    const levels: number[] = []
    for (let t = 0; t < 6000; t += FRAME_MS) {
      spectrum.step()
      levels.push(spectrum.level[0]!)
    }
    const settled = levels.slice(30)
    expect(Math.min(...settled)).toBeGreaterThan(0.05)
    expect(Math.max(...settled) - Math.min(...settled)).toBeGreaterThan(0.25)
    // Its peaks come at uneven gaps: no steady pulse.
    const peaks = settled.flatMap((level, i) => (i > 0 && level > settled[i - 1]! && level >= (settled[i + 1] ?? 0) ? [i] : []))
    const gaps = peaks.slice(1).map((at, i) => at - peaks[i]!)
    expect(peaks.length).toBeGreaterThan(8)
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(10)
  })

  test('a spark runs along the brainwave as a spike, in from either side, then is gone', () => {
    for (const isFromRight of [false, true]) {
      // Two spectra thinking alike, one of which sparks.
      const quiet = new Spectrum()
      const sparked = new Spectrum()
      const steps = (n: number) => {
        for (let i = 0; i < n; i++) for (const spectrum of [quiet, sparked]) spectrum.step()
      }
      for (const spectrum of [quiet, sparked]) spectrum.beginThinking()
      steps(30)
      sparked.spark(0.3, isFromRight)
      // The columns where the two brainwaves differ: the spike, and around it.
      const spike = () => {
        const a = text(new Bars(80, 4).paint('instrument', quiet), 80)
        const b = text(new Bars(80, 4).paint('instrument', sparked), 80)
        const columns: number[] = []
        for (let c = 0; c < 80; c++) if (a.some((row, r) => row[c] !== b[r]![c])) columns.push(c)
        return columns
      }
      const middle = (columns: number[]) => columns.reduce((sum, c) => sum + c, 0) / columns.length
      // A third of the way in, then two thirds, from its side.
      const at = (share: number) => (isFromRight ? 1 - share : share) * 80

      steps(9)
      expect(spike().length).toBeGreaterThan(0)
      expect(Math.abs(middle(spike()) - at(0.33))).toBeLessThan(8)
      steps(9)
      expect(Math.abs(middle(spike()) - at(0.66))).toBeLessThan(8)
      steps(12)
      expect(spike()).toEqual([])
    }
  })

  test('thinking is named in the trail and over its band', () => {
    const spectrum = new Spectrum()
    spectrum.endCall(spectrum.startCall('Read'))
    spectrum.beginThinking()
    for (let i = 0; i < 10; i++) spectrum.step()
    const [, bottom] = text(trail(spectrum, 'instrument', 40, 2), 40)
    expect(bottom?.trimEnd()).toMatch(/Read \u00b7 \S thinking$/)
    const [top] = text(new Bars(80, 4).paint('instrument', spectrum, true), 80)
    expect(top).toContain('thinking')
  })
})

describe('band', () => {
  test('plays while Claude works and steps aside when idle', async ($, on) => {
    // The engine's own band, beneath the plugin.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })

    const working = await $.ui.mount(band(true))
    expect(await working.find({ type: 'Raster', key: 'band' })).toBeDefined()
    await working.unmount()

    const idle = await $.ui.mount(band(false))
    expect(await idle.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    expect(await idle.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await idle.unmount()
  })
})

describe('mini', () => {
  test('/viz mini draws a small spectrum at the right edge', async ($, on) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    on('command.run', () => ({ text: '' }))
    mock.store(on)

    const ran = await $.command.run({
      command: 'viz',
      args: 'mini',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 80 },
    })
    expect(ran.text).toContain('mini')

    const ui = await $.ui.mount(band(true))
    const mini = await ui.find({ type: 'Raster', key: 'mini' })
    expect(mini?.props).toMatchObject({ columns: 32, rows: 2 })
    expect((await ui.find({ type: 'Raster', key: 'names' }))?.props).toMatchObject({ columns: 48, rows: 2 })
    expect(await ui.find({ type: 'Box' })).toMatchObject({ props: { justifyContent: 'flex-end', width: 80 } })
    expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('idle', () => {
  const run = (args: string) => ({
    command: 'viz',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 80 },
  })

  test('a band that stays up plays a low show once all is quiet, and steps aside for the music', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4)
    spectrum.ambient = true
    let highest = 0
    for (let i = 0; i < 500; i++) {
      spectrum.step()
      bars.step(spectrum)
      // Under the label row, and the swell keeps to the bottom of the band.
      if (i > 200) highest = Math.max(highest, ...text(bars.paint('instrument', spectrum), 80).slice(1).map((row, r) => (row.trim() === '' ? 0 : 3 - r)))
    }
    expect(spectrum.idle).toBeGreaterThan(0.95)
    expect(spectrum.isResting()).toBe(true)
    expect(spectrum.isQuiet()).toBe(false)
    expect(bars.isSettled()).toBe(false)
    expect(highest).toBeGreaterThanOrEqual(1)
    expect(highest).toBeLessThanOrEqual(2)

    spectrum.hit('bash')
    for (let i = 0; i < 20; i++) spectrum.step()
    expect(spectrum.idle).toBeLessThan(0.1)
  })

  test('without a band that stays up, the show fades and the bars settle', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4)
    spectrum.ambient = true
    for (let i = 0; i < 300; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    spectrum.ambient = false
    for (let i = 0; i < 200; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    expect(spectrum.idle).toBe(0)
    expect(spectrum.isQuiet()).toBe(true)
    expect(bars.isSettled()).toBe(true)
  })

  test('the scenes take turns: swell, rain, scanner, and round again', () => {
    const spectrum = new Spectrum()
    spectrum.ambient = true
    spectrum.step(IDLE_DELAY)
    const seen: string[] = []
    for (let i = 0; i < 2000; i++) {
      spectrum.step()
      if (seen.at(-1) !== spectrum.sceneNow) seen.push(spectrum.sceneNow)
    }
    expect(seen).toEqual(['swell', 'rain', 'scanner', 'swell'])
  })

  test('idle is named, with how long it has been', () => {
    expect(idleText(0)).toBe('idle')
    expect(idleText(240_000)).toBe('idle 4m')
    expect(idleText(3_900_000)).toBe('idle 1h 5m')

    const spectrum = new Spectrum()
    spectrum.ambient = true
    spectrum.step(IDLE_DELAY)
    for (let i = 0; i < 120; i++) spectrum.step()
    const [top] = text(new Bars(80, 4).paint('instrument', spectrum, true), 80)
    expect(top?.trimEnd()).toMatch(/^\s*idle$/)
    const [, bottom] = text(trail(spectrum, 'instrument', 30, 2), 30)
    expect(bottom?.trimEnd()).toMatch(/ idle$/)

    spectrum.hit('read')
    for (let i = 0; i < 30; i++) spectrum.step()
    expect(text(trail(spectrum, 'instrument', 30, 2), 30).join('')).not.toContain('idle')
  })

  test('/viz idle toggles the show and remembers it', async ($, on) => {
    on('command.run', () => ({ text: '' }))
    const saved = prefsStore(on)

    expect((await $.command.run(run('idle'))).text).toContain('off')
    expect(saved.at(-1)).toMatchObject({ idle: false })
    expect((await $.command.run(run('idle on'))).text).toContain('/viz always')
    expect((await $.command.run(run('always'))).text).toContain('always')
    expect((await $.command.run(run('idle'))).text).toBe('Idle animation off: the bars rest flat.')
    expect((await $.command.run(run('idle on'))).text).toContain('Idle animation on: a swell')
    expect(saved.at(-1)).toMatchObject({ mode: 'always', idle: true })
    expect((await $.command.run(run('idle maybe'))).text).toContain('Usage')
  })
})

describe('waiting on you', () => {
  /** Plays `ms` of music, a frame at a time. */
  const steps = (spectrum: Spectrum, bars: Bars, ms: number) => {
    for (let t = 0; t < ms; t += FRAME_MS) {
      spectrum.step()
      bars.step(spectrum)
    }
  }

  test('an ask past its grace rests the held note and vamps, labeled, until it is answered', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4, { width: 2, gap: 1 })
    const call = spectrum.startCall('Bash')
    const ask = spectrum.ask('bash', call)
    steps(spectrum, bars, GRACE - FRAME_MS)
    expect(spectrum.cue).toBe(0)
    expect(spectrum.waitedFor).toBeUndefined()

    steps(spectrum, bars, 3_000)
    expect(spectrum.cue).toBeGreaterThan(0.9)
    expect(spectrum.isResting()).toBe(false)
    // Only the vamp plays: the frames can slow down.
    expect(spectrum.isCalm()).toBe(true)
    const [top] = text(bars.paint('instrument', spectrum, true), 80)
    expect(top).toMatch(/^waiting on you \u00b7 0:04/)
    expect(top).toContain('Bash')
    // No spinner on a call that waits.
    const [, bottom] = text(trail(spectrum, 'instrument', 50, 2), 50)
    expect(bottom?.trimEnd()).toMatch(/ Bash \u00b7 waiting on you \u00b7 0:04$/)

    spectrum.answer(ask)
    steps(spectrum, bars, 1_300)
    expect(spectrum.cue).toBe(0)
    expect(spectrum.isCalm()).toBe(false)
    expect(text(bars.paint('instrument', spectrum, true), 80)[0]).not.toContain('waiting')
  })

  test('an ask answered within its grace never vamps', () => {
    const spectrum = new Spectrum()
    const ask = spectrum.ask('edit', spectrum.startCall('Edit'))
    let most = 0
    for (let t = 0; t < GRACE - 5 * FRAME_MS; t += FRAME_MS) {
      spectrum.step()
      most = Math.max(most, spectrum.cue)
    }
    spectrum.answer(ask)
    for (let i = 0; i < 60; i++) {
      spectrum.step()
      most = Math.max(most, spectrum.cue)
    }
    expect(most).toBe(0)
  })

  test('the waiting tool\'s band pulses on the beat, the same each bar, and the pulses shrink on a long wait', () => {
    const spectrum = new Spectrum()
    spectrum.ask('bash', undefined, 0)
    for (let i = 0; i < 200; i++) spectrum.step()
    // A bar of four beats, in steps that land on each beat.
    const bar = (x: number) => {
      const levels: number[] = []
      for (let t = 0; t < 4 * BEAT; t += 25) {
        spectrum.step(25)
        levels.push(spectrum.at(x))
      }
      return levels
    }
    const first = bar(0.58)
    const second = bar(0.58)
    expect(Math.max(...first)).toBeGreaterThan(0.5)
    expect(Math.max(...second.map((k, i) => Math.abs(k - first[i]!)))).toBeLessThan(1e-6)
    // The other bands stay down: only the waiting tool's band moves.
    expect(Math.max(...bar(0.05), ...bar(0.32))).toBeLessThan(0.02)
    for (let i = 0; i < 1100; i++) spectrum.step()
    expect(Math.max(...bar(0.58))).toBeLessThan(0.3)
    expect(spectrum.tick).toBeGreaterThan(0)
  })

  test('the wait reads as a clock', () => {
    expect(clockText(0)).toBe('0:00')
    expect(clockText(42_000)).toBe('0:42')
    expect(clockText(3_723_000)).toBe('1:02:03')
  })

  test('a permission ask vamps on the band until the call runs', async ($, on) => {
    const { clock, ui, label, finish } = await staged($, on)
    const call = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1' })
    await clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    await clock.advance(1000)
    expect(label()).toContain('Bash')
    expect(label()).not.toContain('waiting on you')
    await clock.advance(2000)
    expect(label()).toMatch(/^\s*waiting on you \u00b7 0:0[23]/)

    // The run-in-background pill shows once it runs: answered.
    await $.ui.mount({
      plugin: 'visualizer',
      surface: 'terminal',
      component: 'ToolProgress',
      requestId: 't1',
      props: { tool_use_id: 't1', kind: 'background_hint', hint: '' },
    })
    await clock.advance(1000)
    expect(label()).not.toContain('waiting on you')
    finish('t1')
    await call
    await ui.unmount()
  })

  test('an ask the mode settles on its own never vamps, as auto mode settles most', async ($, on) => {
    const { clock, ui, label, finish } = await staged($, on)
    // A background subagent's call the classifier lets run: no progress row shows for it here.
    const call = $.tool.call({ tool: 'Bash', command: 'make test', tool_use_id: 't1' })
    await clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'make test' }, tool_use_id: 't1', agentId: 'a1' })
    await clock.advance(5000)
    expect(label()).toContain('Bash')
    expect(label()).not.toContain('waiting on you')
    finish('t1')
    await call
    await ui.unmount()
  })

  test('a permission request vamps the call it was raised for', async ($, on) => {
    const { clock, ui, label, finish } = await staged($, on)
    const first = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1' })
    const second = $.tool.call({ tool: 'Bash', command: 'rm -r build', tool_use_id: 't2' })
    await clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' })
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -r build' }, tool_use_id: 't2' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -r build' } })
    await clock.advance(3000)
    expect(label()).toMatch(/^\s*waiting on you/)

    // The call the classifier let run ends; the one put to the person still waits.
    finish('t1')
    await first
    await clock.advance(1000)
    expect(label()).toMatch(/^\s*waiting on you/)
    finish('t2')
    await second
    await clock.advance(1000)
    expect(label()).not.toContain('waiting on you')
    await ui.unmount()
  })
})

describe('errors', () => {
  test('a tool that fails flashes the bars red; a call refused or interrupted never ran, and does not', async ($, on) => {
    const { clock, ui, cells, finish } = await staged($, on)
    // A Bash call that ends in an error, the failure raised when it ran: how red the bars are just after.
    const end = async (id: string, failure?: { is_interrupt?: boolean }) => {
      const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: id })
      await clock.settle()
      if (failure !== undefined) {
        await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: id, error: 'Exit code 2', ...failure })
      }
      finish(id, { result: 'Exit code 2', isError: true })
      await call
      await clock.advance(100)
      const red = redness(cells())
      await clock.advance(3000)
      return red
    }

    const refused = await end('t1')
    const failed = await end('t2', {})
    const interrupted = await end('t3', { is_interrupt: true })
    expect(failed).toBeGreaterThan(refused + 30)
    expect(interrupted).toBeLessThan(failed - 30)
    await ui.unmount()
  })
})

describe('streaming', () => {
  test('text after a lull in the stream moves the bars again', async ($, on) => {
    let resume = () => {}
    on('turn.step', async function* ($, e) {
      yield { kind: 'text' as const, index: 0, text: 'Let me look' }
      await new Promise<void>(resolve => (resume = resolve))
      yield { kind: 'text' as const, index: 0, text: ' at the code, the tests and the docs.' }

      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    const { clock, ui, blits } = await staged($, on, { mode: 'auto' })

    const reading = (async () => {
      for await (const _ of $.turn.step({ turnId: 'u1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      }
    })()
    // The lull: the bars fall, and the frames stop.
    await clock.advance(5000)
    const sent = blits()
    await clock.advance(1000)
    expect(blits()).toBe(sent)

    resume()
    await reading
    await clock.advance(500)
    expect(blits()).toBeGreaterThan(sent)
    await ui.unmount()
  })
})

describe('a band taken off screen', () => {
  test('a refused frame holds the band, and it comes back to life once frames land again', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    // A dialog over the band: the engine refuses its frames, then shows it again as it was.
    let isCovered = false
    let tried = 0
    let landed = 0
    // A tool that runs throughout: its held note keeps the frames at full rate.
    on('tool.call', () => new Promise(() => {}))
    on('ui.blit', () => {
      if (isCovered) {
        tried += 1

        return { value: { deny: 'not mounted' } }
      }
      landed += 1

      return { value: {} }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'viz', args: 'always', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
    const ui = await $.ui.mount(band(true))
    $.tool.call({ tool: 'Bash', command: 'sleep 9', tool_use_id: 't1' }).catch(() => {})
    await clock.advance(500)
    expect(landed).toBeGreaterThan(5)

    isCovered = true
    await clock.advance(2000)
    // Held: a try now and then, not a frame each time.
    expect(tried).toBeGreaterThan(0)
    expect(tried).toBeLessThan(10)

    isCovered = false
    const before = landed
    await clock.advance(1000)
    expect(landed - before).toBeGreaterThan(10)
    await ui.unmount()
  })

  test('the frames stop only once the last one has reached the screen', async ($, on) => {
    const { clock, ui, viz, label, blits, finish, cover } = await staged($, on)
    await viz('idle off')
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    await clock.advance(500)
    expect(label()).toContain('Bash')

    // A dialog opens over the band; the call ends and the bars fall behind it.
    cover(true)
    finish('t1')
    await call
    await clock.advance(8000)
    // It closes: the band at rest reaches the screen, not the frame it covered, and then the frames stop.
    cover(false)
    await clock.advance(2000)
    expect(label()).not.toContain('Bash')
    const sent = blits()
    await clock.advance(2000)
    expect(blits()).toBe(sent)
    await ui.unmount()
  })
})

describe('typing', () => {
  /** Plays `ms` of music, a frame at a time. */
  const play = (spectrum: Spectrum, ms: number) => {
    for (let t = 0; t < ms; t += FRAME_MS) spectrum.step()
  }

  test('a key plays where it sits on the keyboard: the left hand low, the right high', () => {
    expect(placeOf('a')).toBeLessThan(0.2)
    expect(placeOf('l')).toBeGreaterThan(0.8)
    expect(placeOf('A')).toBe(placeOf('a'))
    const left = new Spectrum()
    left.typed('a')
    left.step()
    const right = new Spectrum()
    right.typed('l')
    right.step()
    expect(left.at(placeOf('a'))).toBeGreaterThan(left.at(placeOf('l')) + 0.4)
    expect(right.at(placeOf('l'))).toBeGreaterThan(right.at(placeOf('a')) + 0.4)
  })

  test('a paste plays as a run, a key at a time, and the notes fade', () => {
    const spectrum = new Spectrum()
    spectrum.typed('qwertyuiop')
    spectrum.step()
    // The run has begun at the left; the right hand is still to come.
    expect(spectrum.at(placeOf('q'))).toBeGreaterThan(0.4)
    expect(spectrum.at(placeOf('p'))).toBeLessThan(0.1)
    play(spectrum, 250)
    expect(spectrum.at(placeOf('p'))).toBeGreaterThan(0.4)
    expect(spectrum.isCalm()).toBe(false)
    play(spectrum, 1500)
    expect(spectrum.isCalm()).toBe(true)
  })

  test('typing holds off the idle show, which waits for a quiet spell to come back', () => {
    const spectrum = new Spectrum()
    spectrum.ambient = true
    play(spectrum, IDLE_DELAY - 1000)
    expect(spectrum.idle).toBe(0)
    play(spectrum, 6000)
    expect(spectrum.idle).toBeGreaterThan(0.95)

    spectrum.typed('hello')
    play(spectrum, 700)
    expect(spectrum.idle).toBeLessThan(0.05)
    // A pause to think is not idle.
    play(spectrum, 5000)
    expect(spectrum.idle).toBe(0)
    play(spectrum, IDLE_DELAY)
    expect(spectrum.idle).toBeGreaterThan(0.5)
  })

  test('the keys play on a band that is up, and never raise one', async ($, on) => {
    const { clock, ui, blits } = await staged($, on, { mode: 'auto' })
    // The test engine raises prompt.edit as the composer does, though its
    // typings (a plugin's own calls) leave it out.
    const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }
    const edit = (inputText: string) => prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText })
    // Claude works: the band is up, and the keys play on it.
    await clock.advance(3000)
    const before = blits()
    await edit('hi')
    await clock.advance(200)
    expect(blits()).toBeGreaterThan(before)

    // Claude is done and the band has gone: typing does not bring it back.
    await ui.redraw(band(false).props)
    await clock.advance(5000)
    const after = blits()
    await edit('there')
    await clock.advance(1000)
    expect(blits()).toBe(after)
    await ui.unmount()
  })
})

describe('light terminals', () => {
  /** The background colors of Raster cells, row by row, the terminal's default as `0x01000000`. */
  const backgrounds = (cells: string, columns: number): number[][] => {
    const raw = atob(cells)
    const rows: number[][] = []
    for (let i = 0; i < raw.length; i += 12) {
      if ((i / 12) % columns === 0) rows.push([])
      rows.at(-1)!.push(raw.charCodeAt(i + 8) | (raw.charCodeAt(i + 9) << 8) | (raw.charCodeAt(i + 10) << 16) | (raw.charCodeAt(i + 11) << 24))
    }
    return rows
  }
  /** How bright a row's colored cells are, on average. */
  const brightness = (row: number[]) => {
    const inked = row.filter(c => c !== 0)
    return inked.reduce((sum, c) => sum + luminance(c), 0) / Math.max(1, inked.length)
  }

  test("the tone follows Claude Code's theme, and for auto the terminal's COLORFGBG", () => {
    expect(toneOf('light')).toBe('light')
    expect(toneOf('light-daltonized')).toBe('light')
    expect(toneOf('dark-ansi')).toBe('dark')
    expect(toneOf('auto', '15;0')).toBe('dark')
    expect(toneOf('auto', '0;15')).toBe('light')
    expect(toneOf('auto', '0;default;15')).toBe('light')
    expect(toneOf('auto')).toBe('dark')
  })

  test('on a light background every color stands out, and the bars fade to white at their feet', () => {
    for (const color of SOURCES.map(source => source.color)) {
      expect(legible(color, 'dark')).toBe(color)
      // A contrast of 3:1 against white, at least.
      expect(1.05 / (luminance(legible(color, 'light')) + 0.05)).toBeGreaterThanOrEqual(3)
    }
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4)
    for (let i = 0; i < 10; i++) {
      for (const source of SOURCES) spectrum.hit(source.id)
      spectrum.step()
      bars.step(spectrum)
    }
    const light = colors(bars.paint('instrument', spectrum, false, 'light'), 80)
    const dark = colors(bars.paint('instrument', spectrum, false, 'dark'), 80)
    expect(brightness(light[3]!)).toBeGreaterThan(brightness(light[1]!))
    expect(brightness(dark[3]!)).toBeLessThan(brightness(dark[1]!))
  })

  test("the doctor's swatches put the background expected beside the terminal's own", () => {
    for (const tone of ['dark', 'light'] as const) {
      const cells = swatches('instrument', tone, 64)
      expect(backgrounds(cells, 64)[2]![0]).toBe(0x01000000)
      expect(backgrounds(cells, 64)[2]![63]).toBe(GROUND[tone])
      // The fade begins in the background.
      expect(colors(cells, 64)[3]![0]).toBe(GROUND[tone])
    }
    expect(text(swatches('instrument', 'dark', 64), 64)[1]).toContain(' web/mcp ')
  })

  test("the band paints for the background: Claude Code's light theme, then /viz ground", async ($, on) => {
    const { clock, ui, viz, cells } = await staged($, on, { theme: 'light' })
    const feet = () => brightness(colors(cells(), 80).at(-1)!)
    await clock.advance(500)
    expect(feet()).toBeGreaterThan(0.4)

    expect((await viz('ground dark')).text).toBe('Visualizer background: dark, as /viz ground set it.')
    await clock.advance(500)
    expect(feet()).toBeLessThan(0.15)
    expect((await viz('ground auto')).text).toBe("Visualizer background: light, from Claude Code's light theme.")
    await clock.advance(500)
    expect(feet()).toBeGreaterThan(0.4)

    // Claude Code's theme changes: the band follows.
    await $.config.set({ key: 'theme', value: 'dark', previous: 'light', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
    await clock.advance(500)
    expect(feet()).toBeLessThan(0.15)
    await ui.unmount()
  })

  test('/viz doctor reports the terminal, and draws its swatches', async ($, on) => {
    const { ui, viz } = await staged($, on, {
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: '0;15' },
      theme: 'auto',
    })
    const report = (await viz('doctor')).text ?? ''
    expect(report).toContain('- Terminal: xterm-256color, 24-bit color')
    expect(report).toContain('- Claude Code theme: auto')
    expect(report).toContain("- Background: light, from the terminal's COLORFGBG (0;15)")
    expect(report).toContain('ground: the halves should be close')

    const drawn = await $.ui.mount({
      plugin: 'visualizer',
      surface: 'terminal',
      component: 'CommandOutput',
      requestId: 'doctor',
      props: { command: 'viz', args: 'doctor', text: report, isErrored: false },
    })
    expect(await drawn.find({ type: 'Text', text: 'Visualizer doctor' })).toBeDefined()
    expect((await drawn.find({ type: 'Raster', key: 'doctor' }))?.props).toMatchObject({ columns: 64, rows: 5 })
    await drawn.unmount()
    await ui.unmount()
  })
})

describe('the command', () => {
  test('its hint lists the verbs, flat, and /viz help tells each one', async ($, on) => {
    mock.store(on)
    let hint = ''
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => {
      hint = e.argumentHint ?? ''

      return { value: { command: e.name } }
    })
    on('command.run', () => ({ text: '' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    // No verb's own options inside it, to read as the next verb.
    expect(hint).toMatch(/^\[[a-z]+(\|[a-z]+)*\]$/)
    const help =
      (await $.command.run({ command: 'viz', args: 'help', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })).text ?? ''
    for (const verb of hint.slice(1, -1).split('|')) expect(help).toContain(`/viz ${verb}`)
  })
})

describe('a model request', () => {
  const levelOf = (spectrum: Spectrum, id: SourceId) => spectrum.level[SOURCES.findIndex(source => source.id === id)]!

  test('thinks until its first text or tool call, and again when it thinks anew; its end stops it', () => {
    const spectrum = new Spectrum()
    const step = new Step(spectrum)
    expect(spectrum.thinking).toBe(1)
    step.hear({ kind: 'text', text: 'Hi' })
    expect(spectrum.thinking).toBe(0)
    step.hear({ kind: 'thinking', text: 'hmm' })
    expect(spectrum.thinking).toBe(1)
    step.hear({ kind: 'tool', name: 'Bash' })
    expect(spectrum.thinking).toBe(0)
    step.end()
    expect(spectrum.thinking).toBe(0)

    // Two at once: one cut off while thinking stops its own thinking alone, once.
    const first = new Step(spectrum)
    const second = new Step(spectrum)
    first.end()
    first.end()
    expect(spectrum.thinking).toBe(1)
    second.end()
    expect(spectrum.thinking).toBe(0)
  })

  test("its chunks play their bands: text the bass, a call its tool's band, the arguments hats; a subagent's softer", () => {
    const played = (chunk: Chunk, isSubagent = false) => {
      const spectrum = new Spectrum()
      new Step(spectrum, isSubagent).hear(chunk)
      spectrum.step()
      return spectrum
    }
    expect(levelOf(played({ kind: 'text', text: 'x'.repeat(18) }), 'text')).toBeGreaterThan(0.5)
    expect(levelOf(played({ kind: 'tool', name: 'Edit' }), 'edit')).toBeGreaterThan(0.8)
    expect(levelOf(played({ kind: 'input', json: '{"command":"ls -la /tmp"}' }), 'args')).toBeGreaterThan(0.3)
    expect(levelOf(played({ kind: 'tool', name: 'Edit' }, true), 'edit')).toBeLessThan(levelOf(played({ kind: 'tool', name: 'Edit' }), 'edit') - 0.1)
    // Thinking text makes the thinking restless.
    expect(played({ kind: 'thinking', text: 'x'.repeat(60) }).restless).toBeGreaterThan(0.2)
  })
})

describe('the end of a turn', () => {
  const ended = (reason: string, isSubagent = false) => {
    const spectrum = new Spectrum()
    spectrum.ended(reason, isSubagent)
    spectrum.step()
    return spectrum
  }

  test('an answer crashes a cymbal, heavier in the highs, a subagent’s softer', () => {
    const answered = ended('answer')
    expect(answered.at(0.9)).toBeGreaterThan(answered.at(0.1) + 0.2)
    expect(ended('answer', true).at(0.9)).toBeLessThan(answered.at(0.9) - 0.2)
    expect(answered.flash).toBe(0)
  })

  test('an interrupt sweeps from the top of the spectrum down; an error or a refusal flashes red', () => {
    const aborted = ended('aborted')
    expect(aborted.flash).toBe(0)
    expect(aborted.at(0.95)).toBeGreaterThan(aborted.at(0.3) + 0.5)
    for (let i = 0; i < 10; i++) aborted.step()
    expect(aborted.at(0.5)).toBeGreaterThan(aborted.at(0.95) + 0.5)
    expect(ended('error').flash).toBeGreaterThan(0.5)
    expect(ended('refusal').flash).toBeGreaterThan(0.5)
  })
})

describe('edits to the prompt', () => {
  test('play what went in, else, quieter, what went out, else a faint tick where the caret went', () => {
    const edit = (text: string, start: number, end: number, inputText: string) => {
      const spectrum = new Spectrum()
      spectrum.edited(text, start, end, inputText)
      spectrum.step()
      return spectrum
    }
    const typed = edit('', 0, 0, 'p')
    const erased = edit('p', 0, 1, '')
    expect(typed.at(placeOf('p'))).toBeGreaterThan(erased.at(placeOf('p')) + 0.2)
    expect(erased.at(placeOf('p'))).toBeGreaterThan(0.2)
    // The caret to the end of the text: a tick at the right, none at the left.
    const moved = edit('abcd', 4, 4, '')
    expect(moved.at(0.94)).toBeGreaterThan(0.15)
    expect(moved.at(0.1)).toBeLessThan(0.05)
  })
})

describe('cells', () => {
  test('the base64 written by hand, for a runtime without its own, is the standard one', () => {
    for (let n = 0; n <= 6; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255)
      expect(encodeBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
    }
    const every = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(encodeBase64(every)).toBe(btoa(String.fromCharCode(...every)))
  })
})

describe('a turn, through the plugin', () => {
  const braille = /[⠁-⣿]/

  test('the prompt sweeps up, thinking draws the brainwave until the text comes, and the answer crashes a cymbal', async ($, on) => {
    let speak = () => {}
    on('turn.step', async function* ($, e) {
      yield { kind: 'thinking' as const, index: 0, text: 'Let me see.' }
      await new Promise<void>(resolve => (speak = resolve))
      yield { kind: 'text' as const, index: 1, text: 'Here it is.' }

      return { turnId: e.turnId, index: e.index, answer: 'Here it is.', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    const { clock, ui, label, cells } = await staged($, on)

    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    await clock.advance(150)
    const [left, , right] = thirds(cells())
    expect(left).toBeGreaterThan(right!)

    const reading = (async () => {
      for await (const _ of $.turn.step({ turnId: 'u1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      }
    })()
    await clock.advance(600)
    expect(label()).toContain('thinking')
    expect(text(cells(), 80).join('')).toMatch(braille)
    speak()
    await reading
    await clock.advance(3000)
    expect(label()).not.toContain('thinking')
    expect(text(cells(), 80).join('')).not.toMatch(braille)

    await $.turn.complete({ reason: 'answer', answer: 'Here it is.', durationMs: 1000, isAborted: false, turnId: 'u1' })
    await clock.advance(100)
    const [low, , high] = thirds(cells())
    expect(high).toBeGreaterThan(low!)
    await ui.unmount()
  })

  test('a stream cut off while thinking stops the thinking', async ($, on) => {
    on('turn.step', async function* () {
      yield { kind: 'thinking' as const, index: 0, text: 'Let me' }
      throw new Error('connection lost')
    })
    const { clock, ui, label, cells } = await staged($, on)
    await (async () => {
      try {
        for await (const _ of $.turn.step({ turnId: 'u1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
        }
      } catch {}
    })()
    await clock.advance(3000)
    expect(label()).not.toContain('thinking')
    expect(text(cells(), 80).join('')).not.toMatch(braille)
    await ui.unmount()
  })

  test('an interrupted turn sweeps back down; one that errs flashes red', async ($, on) => {
    const { clock, ui, cells } = await staged($, on)
    const end = (reason: 'aborted' | 'error') =>
      $.turn.complete({ reason, answer: '', durationMs: 1000, isAborted: reason === 'aborted', turnId: 'u1' })
    await clock.advance(200)
    const calm = redness(cells())

    await end('aborted')
    await clock.advance(100)
    const [left, , right] = thirds(cells())
    expect(right).toBeGreaterThan(left!)
    expect(redness(cells())).toBeLessThan(calm + 15)
    await clock.advance(3000)

    // Red even on bars that have fallen: the floor flashes too.
    await end('error')
    await clock.advance(100)
    expect(redness(cells())).toBeGreaterThan(calm + 40)
    await ui.unmount()
  })
})

describe('the pane', () => {
  test('/viz pane opens it, drawing the bars with a legend; the band steps aside, and is back when the band is asked for', async ($, on) => {
    const { clock, ui, viz, closes } = await staged($, on)
    expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()

    expect((await viz('pane')).text).toBe('Visualizer pane open. Close it with ctrl+x x or /viz off.')
    await clock.advance(100)
    expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    const drawn = await $.ui.mount(pane)
    expect((await drawn.find({ type: 'Raster', key: 'pane' }))?.props).toMatchObject({ columns: 80, rows: 19 })
    expect((await drawn.find({ type: 'Raster', key: 'legend' }))?.props).toMatchObject({ columns: 80, rows: 1 })

    expect((await viz('bar')).text).toBe('Visualizer: a bar across the whole width.')
    expect(closes()).toBe(1)
    await clock.advance(100)
    expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
    await drawn.unmount()
    await ui.unmount()
  })

  test('/viz off closes it, and every drawing with it', async ($, on) => {
    const { clock, ui, viz, closes } = await staged($, on)
    await viz('pane')
    expect((await viz('off')).text).toBe('Visualizer off.')
    expect(closes()).toBe(1)
    await clock.advance(100)
    expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    await ui.unmount()
  })

  test('a pane the terminal has no room for yet says so', async ($, on) => {
    const { ui, viz } = await staged($, on, { hasRoom: false })
    expect((await viz('pane')).text).toBe(PANE_WAITS)
    await ui.unmount()
  })
})

describe('the context, through the plugin', () => {
  test('a measure fills the meter, measured again only when the window changes', async ($, on) => {
    let usages = 0
    const context = { tokens: 1, window: 200_000 }
    const { clock, ui, label } = await staged($, on, {
      context: () => {
        usages += 1
        return context
      },
    })
    expect(usages).toBe(1)
    await $.session.measure({ context: { tokens: 50_000, window: 200_000 }, rateLimits: [], changed: ['context'] })
    await clock.advance(200)
    expect(label()).toContain('context 25%')
    expect(usages).toBe(1)

    // Another model, another window: measured again, for the meter's top.
    await $.session.measure({ context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] })
    await clock.advance(200)
    expect(label()).toContain('context 5%')
    expect(usages).toBe(2)

    // Only the cost moved: the meter stays.
    await $.session.measure({ context: { tokens: 900_000, window: 1_000_000 }, rateLimits: [], changed: ['cost'] })
    await clock.advance(200)
    expect(label()).toContain('context 5%')
    await ui.unmount()
  })

  test("compacting rewinds, labeled, until done, and the meter drains; a subagent's, or the precompute pass, does not", async ($, on) => {
    let finish = () => {}
    // A compaction keeps at least one message: the summary.
    const messages = [{ role: 'user' as const, text: 'The conversation so far.', toolUses: [] }]
    on('session.compact', () => new Promise(resolve => (finish = () => resolve({ messages, tokensBefore: 150_000, tokensAfter: 30_000 }))))
    const { clock, ui, label } = await staged($, on, { context: () => ({ tokens: 150_000, window: 200_000 }) })
    await clock.advance(200)
    expect(label()).toContain('context 75%')

    const compacting = $.session.compact({ trigger: 'auto', messages })
    await clock.advance(300)
    expect(label()).toContain('compacting')
    finish()
    await compacting
    await clock.advance(1500)
    expect(label()).not.toContain('compacting')
    expect(label()).toContain('context 15%')

    for (const quiet of [{ agentId: 'a1' }, { trigger: 'precompute' as const }]) {
      const pass = $.session.compact({ trigger: 'auto', messages, ...quiet })
      await clock.advance(300)
      expect(label()).not.toContain('compacting')
      finish()
      await pass
    }
    await ui.unmount()
  })
})

describe('a reload', () => {
  test('a tool call while the plugin starts keeps it playing', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    // The command registers slowly: the start is still under way when a call comes.
    let registered = () => {}
    on('command.register', ($, e) => new Promise(resolve => (registered = () => resolve({ value: { command: e.name } }))))
    on('command.run', () => ({ text: '' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    on('ui.blit', () => ({ value: {} }))
    on('tool.call', () => new Promise(() => {}))

    const starting = $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()
    $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' }).catch(() => {})
    await clock.settle()
    registered()
    await starting
    // Not working, by the props, but the call still runs: the band plays on.
    const ui = await $.ui.mount(band(false))
    expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
    await ui.unmount()
  })
})

describe('frames', () => {
  test('a frame the same as the last one sent is not sent again', async ($, on) => {
    const { clock, ui, blits, finish } = await staged($, on, { mode: 'mini' })
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    await clock.advance(1000)
    // The bars move every frame; the names beside them only as the spinner turns.
    expect(blits('mini')).toBeGreaterThan(20)
    expect(blits('names')).toBeGreaterThan(5)
    expect(blits('names')).toBeLessThan(0.75 * blits('mini'))
    finish('t1')
    await call
    await ui.unmount()
  })

  test('the idle show wants frames slower once Claude has been idle a while', () => {
    const spectrum = new Spectrum()
    spectrum.ambient = true
    spectrum.step()
    expect(spectrum.showMs).toBe(2 * FRAME_MS)
    spectrum.step(5 * 60_000)
    expect(spectrum.showMs).toBe(125)
    // Waiting on the person: the vamp keeps its pace.
    spectrum.ask('bash', undefined, 0)
    spectrum.step()
    expect(spectrum.showMs).toBe(2 * FRAME_MS)
  })
})

describe('context', () => {
  test('the meter fills toward auto-compact, labeled with the share of the window', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4, { width: 2, gap: 1, meter: true })
    expect(bars.span).toBe(76)
    // Unmeasured: an empty track, and no label.
    expect(text(bars.paint('instrument', spectrum, true), 80).map(row => row.slice(78))).toEqual(['\u2591\u2591', '\u2591\u2591', '\u2591\u2591', '\u2591\u2591'])
    expect(text(bars.paint('instrument', spectrum, true), 80)[0]).not.toContain('context')

    // Auto-compact at 80% of the window: 40% of it is halfway up the meter.
    spectrum.measure(40, 0.8)
    for (let i = 0; i < 60; i++) spectrum.step()
    expect(Math.abs(spectrum.gauge - 0.5)).toBeLessThan(0.005)
    const rows = text(bars.paint('instrument', spectrum, true), 80)
    expect(rows.map(row => row.slice(78))).toEqual(['\u2591\u2591', '\u2591\u2591', '\u2588\u2588', '\u2588\u2588'])
    expect(rows[0]?.trimEnd()).toMatch(/context 40%\s+\u2591\u2591$/)
  })

  test('the meter drains slowly and rises quickly; the bars rest only once it settles', () => {
    const spectrum = new Spectrum()
    spectrum.measure(90, 1, true)
    expect(spectrum.gauge).toBe(0.9)
    spectrum.measure(10)
    for (let i = 0; i < 10; i++) spectrum.step()
    expect(spectrum.gauge).toBeGreaterThan(0.5)
    expect(spectrum.isResting()).toBe(false)
    for (let i = 0; i < 200; i++) spectrum.step()
    expect(spectrum.gauge).toBe(0.1)
    expect(spectrum.isResting()).toBe(true)
    spectrum.measure(60)
    for (let i = 0; i < 10; i++) spectrum.step()
    expect(spectrum.gauge).toBeGreaterThan(0.45)
  })

  test('now and then a glint runs up the meter, and after each measure', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(40, 4, { width: 2, gap: 1, meter: true })
    const meter = () => colors(bars.paint('instrument', spectrum), 40).map(row => row.slice(38))
    const brightest = (cells: number[][]) => Math.max(...cells.flat().map(c => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255)))
    spectrum.measure(80, 1, true)
    for (let i = 0; i < 100; i++) spectrum.step()
    expect(spectrum.glint).toBeUndefined()
    const still = meter()

    const starts: number[] = []
    for (let i = 0; i < 700; i++) {
      spectrum.step()
      if (spectrum.glint === 0) starts.push(spectrum.now)
    }
    // Every ten seconds, at the first frame after.
    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(10_000)
    expect(starts[1]! - starts[0]!).toBeLessThan(10_000 + FRAME_MS)

    for (let i = 0; i < 400 && (spectrum.glint ?? 0) < 0.4; i++) spectrum.step()
    expect(brightest(meter())).toBeGreaterThan(brightest(still) + 100)
    for (let i = 0; i < 30; i++) spectrum.step()
    expect(meter()).toEqual(still)

    spectrum.measure(70)
    expect(spectrum.glint).toBe(0)
  })

  test('compacting rewinds the tape, labeled, until it is done', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4, { width: 2, gap: 1, meter: true })
    spectrum.beginRewind()
    for (let i = 0; i < 100; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    expect(spectrum.isResting()).toBe(false)
    expect(text(bars.paint('instrument', spectrum, true), 80)[0]).toMatch(/^\s*compacting/)
    spectrum.endRewind()
    for (let i = 0; i < 300; i++) spectrum.step()
    expect(spectrum.isQuiet()).toBe(true)
  })

  test('the band draws the meter at its right edge', async ($, on) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    const ui = await $.ui.mount(band(true))
    const raster = await ui.find({ type: 'Raster', key: 'band' })
    const rows = text(String(raster?.props.cells), 80)
    expect(rows.map(row => row.slice(78))).toEqual(Array(5).fill('\u2591\u2591'))
    await ui.unmount()
  })
})

describe('context, measured', () => {
  /** The label's color, where `word` is drawn in the band's top row. */
  const colorOf = (cells: string, word: string) => {
    const at = (text(cells, 80)[0] ?? '').indexOf(word)
    return at < 0 ? undefined : colors(cells, 80)[0]![at]
  }

  test('/clear moves the meter to what the fresh conversation holds', async ($, on) => {
    let context: object = { tokens: 140_000, window: 200_000 }
    const { clock, ui, label } = await staged($, on, { context: () => context })
    await clock.advance(500)
    expect(label()).toContain('context 70%')

    // Cleared: no response has reported its fill yet, so the estimate.
    context = { window: 200_000, breakdown: { totalTokens: 20_000, isAutoCompactEnabled: false } }
    await $.classic.SessionStart({ source: 'clear' })
    await clock.advance(2000)
    expect(label()).toContain('context 10%')
    await ui.unmount()
  })

  test('turning auto-compact off moves the top of the meter', async ($, on) => {
    const compacting = { isAutoCompactEnabled: true, autoCompactThreshold: 160_000, totalTokens: 152_000 }
    let context: object = { tokens: 152_000, window: 200_000, breakdown: compacting }
    const { clock, ui, cells } = await staged($, on, { context: () => context })
    await clock.advance(500)
    // 76% of the window is 95% of the way to auto-compact: red.
    expect(colorOf(cells(), 'context')).toBe(mix(0, 0xef4444, 0.85))

    context = { ...context, breakdown: { ...compacting, isAutoCompactEnabled: false } }
    await $.config.set({ key: 'autoCompact', value: false, previous: true, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
    await clock.advance(3000)
    // Now 76% of the way to the top: amber.
    expect(colorOf(cells(), 'context')).toBe(mix(0, 0xf59e0b, 0.85))
    await ui.unmount()
  })
})

describe('place', () => {
  const run = (args: string) => ({
    command: 'viz',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 85 },
  })
  const hint = (isWorking: boolean) => ({
    plugin: 'visualizer',
    surface: 'terminal' as const,
    component: 'PromptHint' as const,
    requestId: 'hint',
    viewport: { columns: 85, rows: 40, isFullscreen: true },
    props: { isDraft: false, isWorking, hint: '? for shortcuts' },
  })
  const engine = (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('command.run', () => ({ text: '' }))
  }

  test('/viz pos below draws the band under the prompt, over the hint line it keeps', async ($, on) => {
    engine(on)
    mock.store(on)

    expect((await $.command.run(run('pos below'))).text).toBe('Visualizer below the prompt.')
    const below = await $.ui.mount(hint(true))
    expect((await below.find({ type: 'Raster', key: 'band' }))?.props).toMatchObject({ columns: 80, rows: 5 })
    expect(await below.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    await below.unmount()
    const above = await $.ui.mount(band(true))
    expect(await above.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    expect(await above.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await above.unmount()

    // Idle under auto: the hint line alone.
    const idle = await $.ui.mount(hint(false))
    expect(await idle.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    expect(await idle.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    await idle.unmount()

    expect((await $.command.run(run('pos above'))).text).toBe('Visualizer above the prompt.')
    const back = await $.ui.mount(hint(true))
    expect(await back.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    await back.unmount()
    const up = await $.ui.mount(band(true))
    expect(await up.find({ type: 'Raster', key: 'band' })).toBeDefined()
    await up.unmount()
  })

  test('/viz bar and /viz mini keep the place /viz pos gave, and it is remembered', async ($, on) => {
    engine(on)
    const saved = prefsStore(on)

    await $.command.run(run('mini'))
    expect((await $.command.run(run('pos below'))).text).toBe('Visualizer below the prompt.')
    expect(saved.at(-1)).toMatchObject({ size: 'mini', place: 'below' })
    expect((await $.command.run(run('bar'))).text).toBe('Visualizer: a bar across the whole width.')
    expect(saved.at(-1)).toMatchObject({ size: 'bar', place: 'below' })
    // No place given: the other one.
    expect((await $.command.run(run('pos'))).text).toBe('Visualizer above the prompt.')
    expect(saved.at(-1)).toMatchObject({ size: 'bar', place: 'above' })
  })

  test('/viz saves only what it changed, over what another session saved since', async ($, on) => {
    engine(on)
    const saved = prefsStore(on)

    await $.command.run(run('mini'))
    // Another session picks a theme after this one read its prefs.
    saved.push({ ...(saved.at(-1) as object), theme: 'synthwave' })
    await $.command.run(run('pos below'))
    expect(saved.at(-1)).toMatchObject({ size: 'mini', place: 'below', theme: 'synthwave' })
    // A command that changes nothing saves nothing.
    const writes = saved.length
    await $.command.run(run('pos below'))
    expect(saved).toHaveLength(writes)
  })

  test('the band below the prompt is as wide as the prompt, beside a docked pane too', async ($, on) => {
    engine(on)
    mock.store(on)
    const width = async (ui: { find: (query: { type: 'Raster'; key: string }) => Promise<{ props: unknown } | undefined> }) =>
      ((await ui.find({ type: 'Raster', key: 'band' }))?.props as { columns?: number } | undefined)?.columns

    await $.command.run(run('pos below'))
    const above = await $.ui.mount(band(true))
    const below = await $.ui.mount(hint(true))
    expect(await width(below)).toBe(80)

    // A pane docks beside the transcript: the prompt's column narrows, the screen does not.
    await above.redraw({ ...band(true).props, bodyColumns: 50 })
    expect(await width(below)).toBe(50)
    await below.unmount()
    await above.unmount()
  })

  test('/viz pos says where it cannot go', async ($, on) => {
    engine(on)
    mock.store(on)

    expect((await $.command.run(run('pos top'))).text).toContain('/viz pane')
    expect((await $.command.run(run('pos sideways'))).text).toBe('Usage: /viz pos [above|below]')
  })
})
