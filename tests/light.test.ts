import { describe, expect, test } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { GROUND, legible, luminance, toneOf } from '../hooks/engine/color'
import { swatches } from '../hooks/engine/doctor'
import { SOURCES } from '../hooks/engine/sources'
import { Spectrum } from '../hooks/engine/spectrum'
import { band, colors, staged, text } from './support'

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

  test("COLORFGBG's background is its last field set, read when it is one of the 16 colors; anything else is no reading", () => {
    // 7 and 9 to 15 are light, the rest dark.
    expect(toneOf('auto', '0;7')).toBe('light')
    expect(toneOf('auto', '15;8')).toBe('dark')
    expect(toneOf('auto', '0;12')).toBe('light')
    // A field left empty at the end is not the background.
    expect(toneOf('auto', '0;15;')).toBe('light')
    // A color of 256, a default, or a number written otherwise: no reading, so dark.
    expect(toneOf('auto', '15;234')).toBe('dark')
    expect(toneOf('auto', '0;255')).toBe('dark')
    expect(toneOf('auto', '15;default')).toBe('dark')
    expect(toneOf('auto', '0x0f')).toBe('dark')
    expect(toneOf('auto', '')).toBe('dark')
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

  test("a change of Claude Code's theme paints the next frame for it, once written", async ($, on) => {
    const { clock, ui, cells } = await staged($, on, { theme: 'light' })
    const feet = () => brightness(colors(cells(), 80).at(-1)!)
    await clock.advance(500)
    expect(feet()).toBeGreaterThan(0.4)

    await $.config.set({ key: 'theme', value: 'dark', previous: 'light', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
    // A frame or so: no wait for the setting to settle.
    await clock.advance(50)
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

  test("/viz Doctor, in any case, draws its swatches too, as wide as the transcript's room", async ($, on) => {
    const { ui, viz } = await staged($, on)
    const report = (await viz('Doctor')).text ?? ''
    const doctor = { plugin: 'visualizer', surface: 'terminal' as const, component: 'CommandOutput' as const, requestId: 'doctor' }
    const props = { command: 'viz', args: 'Doctor', text: report, isErrored: false }

    const wide = await $.ui.mount({ ...doctor, props })
    expect((await wide.find({ type: 'Raster', key: 'doctor' }))?.props).toMatchObject({ columns: 64, rows: 5 })
    await wide.unmount()

    // A pane docks beside the transcript: the band above is told the narrower column, and the swatches fit it.
    await ui.redraw({ ...band(true).props, bodyColumns: 40 })
    const narrow = await $.ui.mount({ ...doctor, props })
    expect((await narrow.find({ type: 'Raster', key: 'doctor' }))?.props).toMatchObject({ columns: 32, rows: 5 })
    await narrow.unmount()
    await ui.unmount()
  })
})
