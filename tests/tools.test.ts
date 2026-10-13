import { describe, expect, test } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { shortName } from '../hooks/engine/sources'
import { Spectrum } from '../hooks/engine/spectrum'
import { trail } from '../hooks/engine/trail'
import { text } from './support'

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
