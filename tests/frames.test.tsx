import { describe, expect, mock, test } from 'claude-code/testing'

import { FRAME_MS } from '../hooks/engine/math'
import { Spectrum } from '../hooks/engine/spectrum'
import { band, staged } from './support'

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
    expect(spectrum.showMs()).toBe(2 * FRAME_MS)
    spectrum.step(5 * 60_000)
    expect(spectrum.showMs()).toBe(125)
    // Waiting on the person: the vamp keeps its pace.
    spectrum.ask('bash', undefined, 0)
    spectrum.step()
    expect(spectrum.showMs()).toBe(2 * FRAME_MS)
  })
})
