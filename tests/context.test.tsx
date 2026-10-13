import { describe, expect, test } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { mix } from '../hooks/engine/color'
import { FRAME_MS } from '../hooks/engine/math'
import { Spectrum } from '../hooks/engine/spectrum'
import { band, colors, ink, painted, staged, text } from './support'

describe('the context, through the plugin', () => {
  test('a measure fills the meter, measured again only when the window changes', async ($, on) => {
    let usages = 0
    const context = { tokens: 1, window: 200_000, breakdown: { totalTokens: 1, isAutoCompactEnabled: false } }
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

describe('context', () => {
  test('the meter fills toward auto-compact, labeled with the share of the window', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4, { width: 2, gap: 1, meter: true })
    expect(bars.span).toBe(76)
    // Unmeasured: an empty track, and no label.
    expect(text(painted(bars, ink, spectrum, true), 80).map(row => row.slice(78))).toEqual(['\u2591\u2591', '\u2591\u2591', '\u2591\u2591', '\u2591\u2591'])
    expect(text(painted(bars, ink, spectrum, true), 80)[0]).not.toContain('context')

    // Auto-compact at 80% of the window: 40% of it is halfway up the meter.
    spectrum.measure(40, 0.8)
    for (let i = 0; i < 60; i++) spectrum.step()
    expect(Math.abs(spectrum.gauge - 0.5)).toBeLessThan(0.005)
    const rows = text(painted(bars, ink, spectrum, true), 80)
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
    const meter = () => colors(painted(bars, ink, spectrum), 40).map(row => row.slice(38))
    const brightest = (cells: number[][]) => Math.max(...cells.flat().map(c => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255)))
    spectrum.measure(80, 1, true)
    for (let i = 0; i < 100; i++) spectrum.step()
    expect(spectrum.glint()).toBeUndefined()
    const still = meter()

    const starts: number[] = []
    for (let i = 0; i < 700; i++) {
      spectrum.step()
      if (spectrum.glint() === 0) starts.push(spectrum.now)
    }
    // Every ten seconds, at the first frame after.
    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(10_000)
    expect(starts[1]! - starts[0]!).toBeLessThan(10_000 + FRAME_MS)

    for (let i = 0; i < 400 && (spectrum.glint() ?? 0) < 0.4; i++) spectrum.step()
    expect(brightest(meter())).toBeGreaterThan(brightest(still) + 100)
    for (let i = 0; i < 30; i++) spectrum.step()
    expect(meter()).toEqual(still)

    spectrum.measure(70)
    expect(spectrum.glint()).toBe(0)
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
    expect(text(painted(bars, ink, spectrum, true), 80)[0]).toMatch(/^\s*compacting/)
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

  test("/clear, or a conversation resumed, moves the meter to what it holds; a subagent's start does not", async ($, on) => {
    let context: object = { tokens: 140_000, window: 200_000 }
    const { clock, ui, label } = await staged($, on, { context: () => context })
    await clock.advance(500)
    expect(label()).toContain('context 70%')

    // Cleared: no response has reported its fill yet, so the estimate.
    context = { window: 200_000, breakdown: { totalTokens: 20_000, isAutoCompactEnabled: false } }
    await $.classic.SessionStart({ source: 'clear' })
    await clock.advance(2000)
    expect(label()).toContain('context 10%')

    context = { window: 200_000, breakdown: { totalTokens: 90_000, isAutoCompactEnabled: false } }
    await $.classic.SessionStart({ source: 'resume' })
    await clock.advance(2000)
    expect(label()).toContain('context 45%')

    // A subagent's conversation starting is its own: the meter stays where it is.
    context = { window: 200_000, breakdown: { totalTokens: 180_000, isAutoCompactEnabled: false } }
    await $.classic.SessionStart({ source: 'clear', agent_id: 'a1' })
    await clock.advance(2000)
    expect(label()).toContain('context 45%')
    await ui.unmount()
  })

  test('a top unknown at the start, read before the session was bound, is measured at the first measure', async ($, on) => {
    let usages = 0
    const compacting = { isAutoCompactEnabled: true, autoCompactThreshold: 160_000, totalTokens: 152_000 }
    // No breakdown yet: the top is the whole window, 76% of the way up, amber.
    let context: object = { tokens: 152_000, window: 200_000 }
    const { clock, ui, cells } = await staged($, on, {
      context: () => {
        usages += 1
        return context
      },
    })
    await clock.advance(500)
    expect(colorOf(cells(), 'context')).toBe(mix(0, 0xf59e0b, 0.85))

    // A response: the session is bound, and the breakdown places the top. 95% of the way to auto-compact: red.
    context = { ...context, breakdown: compacting }
    const measure = { context: { tokens: 152_000, window: 200_000 }, rateLimits: [], changed: ['context' as const] }
    await $.session.measure(measure)
    await clock.advance(3000)
    expect(colorOf(cells(), 'context')).toBe(mix(0, 0xef4444, 0.85))
    expect(usages).toBe(2)
    // Known now, and the window the same: not measured again.
    await $.session.measure(measure)
    expect(usages).toBe(2)
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
