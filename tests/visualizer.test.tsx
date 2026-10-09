import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { Bars, GRACE, Spectrum, clockText, idleText, shortName, sourceOf, trail } from '../hooks/engine'

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
    expect(idleText(Math.ceil(240_000 / 33))).toBe('idle 4m')
    expect(idleText(Math.ceil(3_900_000 / 33))).toBe('idle 1h 5m')

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
    const saved: unknown[] = []
    on('store.set', ($, e) => {
      if (e.key === 'prefs') saved.push(e.value)

      return { value: undefined }
    })

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
  const run = (args: string) => ({
    command: 'viz',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 80 },
  })
  const steps = (spectrum: Spectrum, bars: Bars, n: number) => {
    for (let i = 0; i < n; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
  }

  test('an ask past its grace rests the held note and vamps, labeled, until it is answered', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4, { width: 2, gap: 1 })
    const call = spectrum.startCall('Bash')
    const ask = spectrum.ask('bash', call)
    steps(spectrum, bars, GRACE - 1)
    expect(spectrum.cue).toBe(0)
    expect(spectrum.waitedFor).toBeUndefined()

    steps(spectrum, bars, 90)
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
    steps(spectrum, bars, 40)
    expect(spectrum.cue).toBe(0)
    expect(spectrum.isCalm()).toBe(false)
    expect(text(bars.paint('instrument', spectrum, true), 80)[0]).not.toContain('waiting')
  })

  test('an ask answered within its grace never vamps', () => {
    const spectrum = new Spectrum()
    const ask = spectrum.ask('edit', spectrum.startCall('Edit'))
    let most = 0
    for (let i = 0; i < GRACE - 5; i++) {
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
    const bar = (x: number) => {
      const levels: number[] = []
      for (let i = 0; i < 72; i++) {
        spectrum.step()
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
    expect(clockText(Math.ceil(42_000 / 33))).toBe('0:42')
    expect(clockText(Math.ceil(3_723_000 / 33))).toBe('1:02:03')
  })

  test('a permission ask vamps on the band until the call runs', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    const drawn = new Map<string, string>()
    on('ui.render', { component: 'ToolProgress' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('ui.blit', ($, e) => {
      if ('cells' in e) drawn.set(e.key, e.cells)

      return { value: {} }
    })
    let finish = () => {}
    on('tool.call', () => new Promise(resolve => (finish = () => resolve({ result: 'done' }))))
    on('tool.check', () => ({ decision: 'ask' as const }))
    const label = () => text(drawn.get('band') ?? '', 80)[0] ?? ''

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run(run('always'))
    const ui = await $.ui.mount(band(true))
    const call = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1' })
    await clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' })
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
    finish()
    await call
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
      if (spectrum.glint === 0) starts.push(spectrum.frame)
    }
    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBe(300)

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
    const saved: unknown[] = []
    on('store.set', ($, e) => {
      if (e.key === 'prefs') saved.push(e.value)

      return { value: undefined }
    })

    await $.command.run(run('mini'))
    expect((await $.command.run(run('pos below'))).text).toBe('Visualizer below the prompt.')
    expect(saved.at(-1)).toMatchObject({ size: 'mini', place: 'below' })
    expect((await $.command.run(run('bar'))).text).toBe('Visualizer: a bar across the whole width.')
    expect(saved.at(-1)).toMatchObject({ size: 'bar', place: 'below' })
    // No place given: the other one.
    expect((await $.command.run(run('pos'))).text).toBe('Visualizer above the prompt.')
    expect(saved.at(-1)).toMatchObject({ size: 'bar', place: 'above' })
  })

  test('/viz pos says where it cannot go', async ($, on) => {
    engine(on)
    mock.store(on)

    expect((await $.command.run(run('pos top'))).text).toContain('/viz pane')
    expect((await $.command.run(run('pos sideways'))).text).toBe('Usage: /viz pos [above|below]')
  })
})
