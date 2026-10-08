import { describe, expect, mock, test } from 'claude-code/testing'

import { Bars, Spectrum, shortName, sourceOf, trail } from '../hooks/engine'

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
