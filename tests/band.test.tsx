import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { DEFAULTS, PANE_WAITS } from '../hooks/viz'
import { band, pane, prefsStore, staged } from './support'

describe('band', () => {
  test('plays while Claude works and steps aside when idle', async ($, on) => {
    // The engine's own band, beneath the plugin.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })

    const working = await $.ui.mount(band(true))
    try {
      expect(await working.find({ type: 'Raster', key: 'band' })).toBeDefined()
    } finally {
      await working.unmount()
    }

    const idle = await $.ui.mount(band(false))
    try {
      expect(await idle.find({ type: 'Raster', key: 'band' })).toBeUndefined()
      expect(await idle.find({ type: 'Text', text: 'engine' })).toBeDefined()
    } finally {
      await idle.unmount()
    }
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
    try {
      const mini = await ui.find({ type: 'Raster', key: 'mini' })
      expect(mini?.props).toMatchObject({ columns: 32, rows: 2 })
      expect((await ui.find({ type: 'Raster', key: 'names' }))?.props).toMatchObject({ columns: 48, rows: 2 })
      expect(await ui.find({ type: 'Box' })).toMatchObject({ props: { justifyContent: 'flex-end', width: 80 } })
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    } finally {
      await ui.unmount()
    }
  })
})

describe('the command', () => {
  test('its hint lists the verbs, flat, and /viz help tells each one', async ($, on) => {
    mock.store(on)
    let hint = ''
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => {
      hint = e.argumentHint ?? ''

      return { value: { command: e.name } }
    })
    on('command.run', () => ({ text: '' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    // No verb's own options inside it, to read as the next verb.
    expect(hint).toMatch(/^\[[a-z]+(\|[a-z]+)*\]$/)
    const help =
      (await $.command.run({ command: 'viz', args: 'help', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })).text ?? ''
    for (const verb of hint.slice(1, -1).split('|')) expect(help).toContain(`/viz ${verb}`)
  })
})

describe('the pane', () => {
  test('/viz pane opens it, drawing the bars with a legend; the band steps aside, and is back when the band is asked for', async ($, on) => {
    const { clock, ui, viz, closes } = await staged($, on)
    let drawn: Mounted<'terminal', 'Pane'> | undefined
    try {
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()

      expect((await viz('pane')).text).toBe('Visualizer pane open. Close it with ctrl+x x or /viz off.')
      await clock.advance(100)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()
      drawn = await $.ui.mount(pane)
      expect((await drawn.find({ type: 'Raster', key: 'pane' }))?.props).toMatchObject({ columns: 80, rows: 19 })
      expect((await drawn.find({ type: 'Raster', key: 'legend' }))?.props).toMatchObject({ columns: 80, rows: 1 })

      expect((await viz('bar')).text).toBe('Visualizer: a bar across the whole width.')
      expect(closes()).toBe(1)
      await clock.advance(100)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
    } finally {
      await drawn?.unmount()
      await ui.unmount()
    }
  })

  test('/viz off closes it, and every drawing with it', async ($, on) => {
    const { clock, ui, viz, closes } = await staged($, on)
    try {
      await viz('pane')
      expect((await viz('off')).text).toBe('Visualizer off.')
      expect(closes()).toBe(1)
      await clock.advance(100)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    } finally {
      await ui.unmount()
    }
  })

  test('a pane the terminal has no room for yet says so, and the band stays up meanwhile', async ($, on) => {
    const { clock, ui, viz } = await staged($, on, { hasRoom: false })
    try {
      expect((await viz('pane')).text).toBe(PANE_WAITS)
      await clock.advance(100)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
    } finally {
      await ui.unmount()
    }
  })

  test('a pane refused leaves the band up', async ($, on) => {
    const { clock, ui, viz } = await staged($, on, { isPaneRefused: true })
    try {
      await viz('pane').catch(() => undefined)
      await clock.advance(100)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
    } finally {
      await ui.unmount()
    }
  })

  test('a pane an unload dropped holds the band aside no longer once the plugin starts again', async ($, on) => {
    const { clock, ui, viz, unload } = await staged($, on)
    try {
      await viz('pane')
      await clock.advance(100)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeUndefined()

      // The pane goes with an unload, which this plugin never hears of; the state outlives the reload.
      unload()
      await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
      await clock.advance(100)
      expect(await ui.find({ type: 'Raster', key: 'band' })).toBeDefined()
    } finally {
      await ui.unmount()
    }
  })
})

describe('other surfaces', () => {
  test("a drawing on the desktop leaves the terminal's band playing", async ($, on) => {
    const { clock, ui, blits, finish } = await staged($, on)
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' })
    let desktop: Mounted<'desktop', 'AbovePrompt'> | undefined
    try {
      await clock.advance(500)

      // The desktop draws the same instance, by the same id.
      desktop = await $.ui.mount({ ...band(true), surface: 'desktop' as const })
      expect(await desktop.find({ type: 'Raster', key: 'band' })).toBeUndefined()
      const sent = blits('band')
      await clock.advance(500)
      expect(blits('band') - sent).toBeGreaterThan(5)
    } finally {
      finish('t1')
      await call
      await desktop?.unmount()
      await ui.unmount()
    }
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
    try {
      expect((await below.find({ type: 'Raster', key: 'band' }))?.props).toMatchObject({ columns: 80, rows: 5 })
      expect(await below.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    } finally {
      await below.unmount()
    }
    const above = await $.ui.mount(band(true))
    try {
      expect(await above.find({ type: 'Raster', key: 'band' })).toBeUndefined()
      expect(await above.find({ type: 'Text', text: 'engine' })).toBeDefined()
    } finally {
      await above.unmount()
    }

    // Idle under auto: the hint line alone.
    const idle = await $.ui.mount(hint(false))
    try {
      expect(await idle.find({ type: 'Raster', key: 'band' })).toBeUndefined()
      expect(await idle.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    } finally {
      await idle.unmount()
    }

    expect((await $.command.run(run('pos above'))).text).toBe('Visualizer above the prompt.')
    const back = await $.ui.mount(hint(true))
    try {
      expect(await back.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    } finally {
      await back.unmount()
    }
    const up = await $.ui.mount(band(true))
    try {
      expect(await up.find({ type: 'Raster', key: 'band' })).toBeDefined()
    } finally {
      await up.unmount()
    }
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

  test('/viz saves the prefs as they read, dropping what else the store held', async ($, on) => {
    engine(on)
    const saved = prefsStore(on, { theme: 'synthwave', size: 'huge', junk: 1 })

    await $.command.run(run('pos below'))
    expect(saved.at(-1)).toEqual({ ...DEFAULTS, theme: 'synthwave', place: 'below' })
  })

  test('the band below the prompt is as wide as the prompt, beside a docked pane too', async ($, on) => {
    engine(on)
    mock.store(on)
    const width = async (ui: { find: (query: { type: 'Raster'; key: string }) => Promise<{ props: unknown } | undefined> }) =>
      ((await ui.find({ type: 'Raster', key: 'band' }))?.props as { columns?: number } | undefined)?.columns

    await $.command.run(run('pos below'))
    const above = await $.ui.mount(band(true))
    let below: Mounted<'terminal', 'PromptHint'> | undefined
    try {
      below = await $.ui.mount(hint(true))
      expect(await width(below)).toBe(80)

      // A pane docks beside the transcript: the prompt's column narrows, the screen does not.
      await above.redraw({ ...band(true).props, bodyColumns: 50 })
      expect(await width(below)).toBe(50)
    } finally {
      await below?.unmount()
      await above.unmount()
    }
  })

  test('/viz pos says where it cannot go', async ($, on) => {
    engine(on)
    mock.store(on)

    expect((await $.command.run(run('pos top'))).text).toContain('/viz pane')
    expect((await $.command.run(run('pos sideways'))).text).toBe('Usage: /viz pos [above|below]')
  })
})
