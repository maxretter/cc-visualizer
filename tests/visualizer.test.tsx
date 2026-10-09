import type { On, SessionUsage, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BEAT, Bars, FRAME_MS, GRACE, Spectrum, clockText, idleText, mix, shortName, sourceOf, trail } from '../hooks/engine'

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
 * A session with the band above the prompt while Claude works, in `mode`, and
 * its frames kept: tool calls run until the test finishes them, each check
 * beneath asks, and the context is `context()` when one is given.
 */
const staged = async ($: Engine, on: On, mode = 'always', context?: () => object) => {
  const clock = mock.clock(on)
  mock.store(on)
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
  }
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
    // A prompt's sweep, an error's flash, thinking, the meter filling: 600 ms of it at 60, 30 and 15 ms a frame.
    const played = (step: number) => {
      const spectrum = new Spectrum()
      spectrum.kick()
      spectrum.error()
      spectrum.beginThinking()
      spectrum.measure(60)
      for (let t = 0; t < 600; t += step) spectrum.step(step)
      return spectrum
    }
    const full = played(30)
    for (const other of [played(60), played(15)]) {
      expect(other.now).toBe(600)
      const reads: ((s: Spectrum) => number)[] = [s => s.flash, s => s.mind, s => s.gauge, s => s.at(0.9)]
      for (const read of reads) {
        expect(Math.abs(read(other) - read(full))).toBeLessThan(1e-6)
      }
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
    // How red the bars are: red over green, on average over the cells drawn.
    const redness = () => {
      const drawn = colors(cells(), 80)
        .flat()
        .filter(c => c !== 0)
      return drawn.reduce((sum, c) => sum + ((c >> 16) & 0xff) - ((c >> 8) & 0xff), 0) / Math.max(1, drawn.length)
    }
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
      const red = redness()
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
    const { clock, ui, blits } = await staged($, on, 'auto')

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
    const { clock, ui, blits, finish } = await staged($, on, 'mini')
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
    const { clock, ui, label } = await staged($, on, 'always', () => context)
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
    const { clock, ui, cells } = await staged($, on, 'always', () => context)
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
