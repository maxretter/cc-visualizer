import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock, Mounted } from 'claude-code/testing'

import { FRAME_MS } from '../hooks/engine/math'
import { Spectrum } from '../hooks/engine/spectrum'
import { band, pane, prefsStore, staged, text } from './support'

/**
 * How many frames the plugin has drawn so far: each starts by reading the
 * clock. Hooked before `mock.clock`, whose own hook answers the read.
 */
const counted = (on: On) => {
  let reads = 0
  on('clock.now', {}, ($, e, next) => {
    reads += 1

    return next(e)
  })
  return () => reads
}

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
    try {
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
    } finally {
      await ui.unmount()
    }
  })

  test('the frames stop only once the last one has reached the screen', async ($, on) => {
    // A band that stays up, without its idle show: once the bars are down, nothing more to draw.
    const { clock, ui, viz, label, blits, finish, cover } = await staged($, on, { mode: 'always' })
    await viz('idle off')
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    try {
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
    } finally {
      finish('t1')
      await call
      await ui.unmount()
    }
  })

  test('behind a dialog, the frames run only as often as the band is tried, whatever plays', { timeoutMs: 20_000 }, async ($, on) => {
    const frames = counted(on)
    const { clock, ui, label, finish, cover } = await staged($, on)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -r build', tool_use_id: 't1' })
    try {
      await clock.settle()
      // The dialog asks, over the band, and goes unanswered for a minute while the vamp plays.
      cover(true)
      await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -r build' } })
      await clock.advance(3000)
      const before = frames()
      await clock.advance(60_000)
      // A frame a try, two a second: not the vamp's fifteen.
      expect(frames() - before).toBeGreaterThan(100)
      expect(frames() - before).toBeLessThan(130)

      // It closes: the band is back within a try, at the vamp's pace.
      cover(false)
      await clock.advance(1000)
      expect(label()).toMatch(/^\s*waiting on you/)
      const back = frames()
      await clock.advance(1000)
      expect(frames() - back).toBeGreaterThan(10)
    } finally {
      finish('t1')
      await call
      await ui.unmount()
    }
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
    try {
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
    } finally {
      await ui.unmount()
    }
  })

  test('a drawing that stays up plays its idle show again, with nothing to wake it', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    let drawn = ''
    on('ui.blit', ($, e) => {
      if ('cells' in e) drawn = e.cells

      return { value: {} }
    })

    // The pane, open through the reload, is drawn again before the plugin has started.
    const ui = await $.ui.mount(pane)
    try {
      await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
      await clock.advance(10_000)
      expect(text(drawn, 80)[0]).toMatch(/^\s*idle/)
    } finally {
      await ui.unmount()
    }
  })
})

describe('the start of a session', () => {
  test('restores the settings saved', async ($, on) => {
    mock.clock(on)
    prefsStore(on, { mode: 'always', size: 'mini', place: 'below', theme: 'synthwave', ground: 'light', idle: false })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('ui.blit', () => ({ value: {} }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    // Claude is not working: up all the same, small, and under the prompt.
    const above = await $.ui.mount(band(false))
    let below: Mounted<'terminal', 'PromptHint'> | undefined
    try {
      expect(await above.find({ type: 'Raster', key: 'band' })).toBeUndefined()
      below = await $.ui.mount({
        plugin: 'visualizer',
        surface: 'terminal',
        component: 'PromptHint',
        requestId: 'hint',
        viewport: { columns: 85, rows: 40, isFullscreen: true },
        props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      })
      expect((await below.find({ type: 'Raster', key: 'mini' }))?.props).toMatchObject({ columns: 32, rows: 2 })
      const report =
        (await $.command.run({ command: 'viz', args: 'doctor', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })).text ?? ''
      expect(report).toContain('Visualizer: always, mini below the prompt, theme synthwave, idle off')
      expect(report).toContain('Background: light, as /viz ground set it')
    } finally {
      await below?.unmount()
      await above.unmount()
    }
  })

  test('a step that fails leaves the rest: the background, the meter and the subagents are read all the same', async ($, on) => {
    // The store cannot be read as the session starts.
    let isLocked = true
    on('store.get', { key: 'prefs' }, ($, e, next) => {
      if (!isLocked) return next(e)
      isLocked = false

      return { deny: 'the store is locked' }
    })
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'Map the API', type: 'Explore', status: 'running' as const }] }))
    const { clock, ui, viz, label } = await staged($, on, { theme: 'light', context: () => ({ tokens: 50_000, window: 200_000 }) })
    try {
      await clock.advance(500)
      expect(label()).toContain('Map the API')
      expect(label()).toContain('context 25%')
      expect((await viz('doctor')).text).toContain("Background: light, from Claude Code's light theme")
    } finally {
      await ui.unmount()
    }
  })
})

describe('frames', () => {
  test('a frame the same as the last one sent is not sent again', async ($, on) => {
    const { clock, ui, blits, finish } = await staged($, on, { mode: 'mini' })
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    try {
      await clock.advance(1000)
      // The bars move every frame; the names beside them only as the spinner turns.
      expect(blits('mini')).toBeGreaterThan(20)
      expect(blits('names')).toBeGreaterThan(5)
      expect(blits('names')).toBeLessThan(0.75 * blits('mini'))
    } finally {
      finish('t1')
      await call
      await ui.unmount()
    }
  })

  test('in auto, the band steps aside once the work is done and its frames have stopped', async ($, on) => {
    const { clock, ui, blits, finish } = await staged($, on, { mode: 'auto' })
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    try {
      await clock.advance(500)
      finish('t1')
      await call
      // Claude is done, but the music plays on as the bars fall: the band stays for it.
      await ui.redraw(band(false).props)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()

      await clock.advance(8000)
      const sent = blits()
      await clock.advance(1000)
      expect(blits()).toBe(sent)
      await ui.redraw(band(false).props)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    } finally {
      finish('t1')
      await call
      await ui.unmount()
    }
  })

  test('no frames run where nothing draws: a -p run', async ($, on) => {
    const frames = counted(on)
    const clock = mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => new Promise(() => {}))

    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'make it', wait: false, origin: { kind: 'composer' } })
    $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' }).catch(() => {})
    await clock.advance(2000)
    expect(frames()).toBe(0)
  })

  test('in a terminal, the frames wait for a band to play on, and start as it comes up', async ($, on) => {
    const frames = counted(on)
    const clock = mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    on('ui.blit', () => ({ value: {} }))
    on('tool.call', () => new Promise(() => {}))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' }).catch(() => {})
    await clock.advance(1000)
    expect(frames()).toBe(0)
    // The music brings the band up, though Claude is not working by the props, and plays on it.
    const ui = await $.ui.mount(band(false))
    try {
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
      await clock.advance(1000)
      expect(frames()).toBeGreaterThan(25)
    } finally {
      await ui.unmount()
    }
  })

  test('a ticker whose period is refused is started again, and the band plays on', async ($, on) => {
    // The host refuses one period of the frames' timer, which ends it.
    let isRefused = false
    on('clock.every', { ms: FRAME_MS }, ($, e, next) => (isRefused ? { deny: 'busy' } : next(e)))
    const { clock, ui, blits, finish } = await staged($, on)
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    try {
      await clock.advance(500)
      isRefused = true
      await clock.advance(FRAME_MS)
      isRefused = false
      // The watchdog finds no frame since it last looked, and starts them again.
      await clock.advance(4000)
      const sent = blits()
      await clock.advance(1000)
      expect(blits() - sent).toBeGreaterThan(20)
    } finally {
      finish('t1')
      await call
      await ui.unmount()
    }
  })

  test('a frame that fails stops the frames, and the next sound starts them again', async ($, on) => {
    // For a while the clock answers what no frame can count with.
    let isBroken = false
    let reads = 0
    on('clock.now', {}, ($, e, next) => {
      reads += 1

      return isBroken ? { value: 1n as unknown as number } : next(e)
    })
    // A band that stays up, which would play its idle show once the frames stopped.
    const { clock, ui, blits, finish } = await staged($, on, { mode: 'always' })
    const first = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    // The second call, once made.
    let second: Promise<unknown> = Promise.resolve()
    try {
      await clock.advance(500)
      isBroken = true
      const read = reads
      await clock.advance(2000)
      // Stopped at the first that fails, rather than failing at every tick; nor
      // does the band, still up, start them again for its idle show.
      expect(reads - read).toBe(1)

      isBroken = false
      second = $.tool.call({ tool: 'Read', file_path: '/src/auth.ts', tool_use_id: 't2' })
      const sent = blits()
      await clock.advance(1000)
      expect(blits() - sent).toBeGreaterThan(20)
    } finally {
      finish('t1')
      finish('t2')
      await Promise.all([first, second])
      await ui.unmount()
    }
  })

  test('a tick that comes while the last still reads the clock is let go', async ($, on) => {
    // A busy host: the clock answers a tenth of a second late.
    let reads = 0
    let late: MockClock | undefined
    on('clock.now', {}, async ($, e, next) => {
      reads += 1
      await late?.sleep(100)

      return next(e)
    })
    const { clock, ui, blits, finish } = await staged($, on)
    late = clock
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    try {
      await clock.advance(500)
      const read = reads
      const sent = blits()
      await clock.advance(1000)
      // A read at a time, not one at every tick, piling up: and the band still plays.
      expect(reads - read).toBeLessThan(12)
      expect(blits() - sent).toBeGreaterThan(5)
    } finally {
      finish('t1')
      await call
      await ui.unmount()
    }
  })

  test('the idle show draws at 15 fps, and at 8 once Claude has been idle five minutes', { timeoutMs: 20_000 }, async ($, on) => {
    const frames = counted(on)
    // A band that stays up, for the idle show.
    const { clock, ui } = await staged($, on, { mode: 'always' })
    try {
      await clock.advance(270_000)
      let from = frames()
      await clock.advance(10_000)
      expect(Math.abs(frames() - from - 150)).toBeLessThan(10)
      await clock.advance(50_000)
      from = frames()
      await clock.advance(10_000)
      expect(Math.abs(frames() - from - 80)).toBeLessThan(6)
    } finally {
      await ui.unmount()
    }
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
