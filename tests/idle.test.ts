import { describe, expect, test } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { idleText } from '../hooks/engine/names'
import { IDLE_DELAY, Spectrum } from '../hooks/engine/spectrum'
import { trail } from '../hooks/engine/trail'
import { prefsStore, staged, text } from './support'

describe('idle', () => {
  const run = (args: string) => ({
    command: 'viz',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 80 },
  })

  test('a band that stays up plays a low show once all is quiet, and steps aside for the music', { timeoutMs: 30_000 }, () => {
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
      if (seen.at(-1) !== spectrum.sceneNow()) seen.push(spectrum.sceneNow())
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

  test('no idle show while a subagent works, though the main loop rests; it comes once the subagent is done', { timeoutMs: 30_000 }, async ($, on) => {
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
    // A band that stays up, for the idle show.
    const { clock, ui, label } = await staged($, on, { mode: 'always' })
    try {
      await $.agent.spawn({
        tool_use_id: 'spawn-scout',
        prompt: 'Look around.',
        description: 'Look for the handlers',
        subagentType: 'Explore',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        background: true,
        fork: false,
        name: 'scout',
      })
      await clock.advance(12_000)
      expect(label()).toContain('scout')
      expect(label()).not.toContain('idle')

      await $.turn.complete({ reason: 'answer', answer: 'Found it.', durationMs: 1000, isAborted: false, turnId: 'u1', agentId: 'a1' })
      await clock.advance(4000)
      expect(label()).not.toContain('scout')
      await clock.advance(8000)
      expect(label()).toMatch(/^\s*idle/)
    } finally {
      await ui.unmount()
    }
  })

  test('/viz idle toggles the show and remembers it', { timeoutMs: 30_000 }, async ($, on) => {
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
