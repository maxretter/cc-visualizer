import { describe, expect, test } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { FRAME_MS } from '../hooks/engine/math'
import { Spectrum } from '../hooks/engine/spectrum'
import { trail } from '../hooks/engine/trail'
import { text } from './support'

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
