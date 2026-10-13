import type { AgentSpawnResult, On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { Board } from '../hooks/engine/board'
import { CHANNEL, channelsFit } from '../hooks/engine/channels'
import { Demo } from '../hooks/engine/demo'
import { Ensemble } from '../hooks/engine/ensemble'
import { FRAME_MS } from '../hooks/engine/math'
import { Spectrum } from '../hooks/engine/spectrum'
import { trail } from '../hooks/engine/trail'
import { Stage } from '../hooks/stage'
import { band, colors, ink, painted, redness, staged, text } from './support'

describe('subagents', () => {
  /** Bar glyphs above the floor, as many as stand in a drawing's rows below its label. */
  const raised = (rows: string[]) => rows.slice(1).join('').replace(/[^▂-█]/g, '').length

  test('each joins with a voice of its own: its name, and a color apart from the others', () => {
    const ensemble = new Ensemble()
    const scout = ensemble.join('a1', { name: 'scout', description: 'Find the handlers', type: 'Explore' })
    const audit = ensemble.join('a2', { description: 'Audit  the\nAPI', type: 'general-purpose' })
    const plan = ensemble.join('a3', { type: 'Plan' })
    expect([scout.name, audit.name, plan.name]).toEqual(['scout', 'Audit the API', 'Plan'])
    expect(new Set([scout.color, audit.color, plan.color]).size).toBe(3)
    expect(ensemble.voiceOf('a1')).toBe(scout)
    // The main loop, and a loop never heard of (the engine's own forks), have none.
    expect(ensemble.voiceOf(undefined)).toBeUndefined()
    expect(ensemble.voiceOf('fork')).toBeUndefined()
  })

  test('one that ends says how it went for a while, and leaves', () => {
    const ensemble = new Ensemble()
    ensemble.join('a1', { name: 'scout' })
    const audit = ensemble.join('a2', { name: 'audit' })
    expect(ensemble.end('a2', 'error')).toBe(true)
    expect(audit.outcome).toBe('failed')
    expect(ensemble.end('elsewhere', 'answer')).toBe(false)
    for (let t = 0; t < 2900; t += 100) ensemble.step(100)
    expect(ensemble.voices).toContain(audit)
    ensemble.step(100)
    expect(ensemble.voices.map(voice => voice.name)).toEqual(['scout'])
    expect(ensemble.isCalm()).toBe(false)
  })

  test('one that works again after it ended plays again: a teammate woken, an agent resumed', () => {
    const ensemble = new Ensemble()
    const scout = ensemble.join('a1', { name: 'scout' })
    ensemble.end('a1', 'answer')
    expect(ensemble.voiceOf('a1')).toBe(scout)
    expect(scout.outcome).toBeUndefined()
    ensemble.end('a1', 'answer')
    for (let t = 0; t < 5000; t += 100) ensemble.step(100)
    expect(ensemble.isCalm()).toBe(true)
    expect(ensemble.voiceOf('a1')?.name).toBe('scout')
  })

  test('each joins in a color no other on stage has: one that left frees its own', () => {
    const ensemble = new Ensemble()
    const voices = Array.from({ length: 8 }, (_, i) => ensemble.join(`a${i}`, { name: `agent ${i}` }))
    expect(new Set(voices.map(voice => voice.color)).size).toBe(8)
    ensemble.end('a1', 'answer')
    for (let t = 0; t < 3_100; t += 100) ensemble.step(100)
    // The ninth, while the first still plays: the color the second left.
    expect(ensemble.join('a8', { name: 'agent 8' }).color).toBe(voices[1]!.color)
    expect(new Set(ensemble.voices.map(voice => voice.color)).size).toBe(8)
  })

  test('one at work without a sound stands still, on stage: its channel wants no frames until it plays or ends', () => {
    const ensemble = new Ensemble()
    const scout = ensemble.join('a1', { name: 'scout' })
    ensemble.step()
    expect(ensemble.isStill()).toBe(true)
    expect(ensemble.isCalm()).toBe(false)
    const call = scout.spectrum.startCall('Read')
    ensemble.step()
    expect(ensemble.isStill()).toBe(false)
    scout.spectrum.endCall(call)
    for (let t = 0; t < 4_000; t += FRAME_MS) ensemble.step()
    expect(ensemble.isStill()).toBe(true)
    // Saying how it went, it moves until it has left.
    ensemble.end('a1', 'answer')
    for (let t = 0; t < 2_900; t += 100) ensemble.step(100)
    expect(ensemble.isStill()).toBe(false)
    ensemble.step(100)
    expect(ensemble.isStill()).toBe(true)
  })

  test('the latest subagents heard of are remembered, to play again; the oldest are let go', () => {
    const ensemble = new Ensemble()
    for (let i = 0; i < 300; i++) {
      ensemble.join(`a${i}`, { name: `agent ${i}` })
      ensemble.end(`a${i}`, 'answer')
    }
    for (let t = 0; t < 3_100; t += 100) ensemble.step(100)
    expect(ensemble.isCalm()).toBe(true)
    expect(ensemble.voiceOf('a299')?.name).toBe('agent 299')
    expect(ensemble.voiceOf('a0')).toBeUndefined()
    expect(ensemble.end('a0', 'answer')).toBe(false)
  })

  test('channels fit beside a main spectrum that keeps half the width, and at least 32 columns', () => {
    expect(channelsFit(80)).toBe(2)
    expect(channelsFit(120)).toBe(3)
    expect(channelsFit(60)).toBe(1)
    expect(channelsFit(48)).toBe(0)
    expect(channelsFit(32)).toBe(0)
  })

  test('bars narrowed or widened stand as they stood', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4, { width: 2, gap: 1, meter: true })
    spectrum.hit('bash')
    for (let i = 0; i < 3; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    const before = raised(text(painted(bars, ink, spectrum), 80))
    expect(before).toBeGreaterThan(0)
    for (const columns of [63, 46, 80]) {
      expect(raised(text(painted(bars.resize(columns), ink, spectrum), columns))).toBeGreaterThan(0.5 * before)
    }
  })

  /**
   * A board as wide as the band, 4 rows, and a way to move the music and it on
   * together; `view` opens a subagent's transcript, as the plugin is told it.
   */
  const staging = () => {
    const spectrum = new Spectrum()
    const ensemble = new Ensemble()
    const board = new Board(80, 4, { width: 2, gap: 1, meter: true })
    let viewed: string | undefined
    const step = (ms = FRAME_MS) => {
      spectrum.step(ms)
      ensemble.step(ms)
      board.step(spectrum, ensemble, ensemble.find(viewed))
    }
    const paint = () => board.paint(ink, spectrum, ensemble, true, ensemble.find(viewed))
    const view = (agentId?: string) => {
      viewed = agentId
    }
    return { spectrum, ensemble, board, step, paint, view, rows: () => text(paint(), 80) }
  }

  test("channels sit at the right of the main bars, each its voice's spectrum, with its name in its color and what it is doing", () => {
    const { ensemble, board, step, paint, rows } = staging()
    const scout = ensemble.join('a1', { name: 'scout' })
    const audit = ensemble.join('a2', { description: 'audit wake calls' })
    scout.spectrum.startCall('Grep')
    for (let i = 0; i < 3; i++) step()
    // On stage when the board was made (a reload, a resize): open at once.
    const main = 80 - 2 * CHANNEL
    expect(board.bars.columns).toBe(main)
    const drawn = rows()
    const left = drawn.map(row => row.slice(main, main + CHANNEL))
    const right = drawn.map(row => row.slice(main + CHANNEL))
    expect(left[0]).toMatch(/^ {2}scout [⠁-⣿] Grep/)
    // A task too long for the label is cut at the end of a word.
    expect(right[0]).toMatch(/^ {2}audit wake\s*$/)
    expect(raised(left)).toBeGreaterThan(0)
    expect(raised(right)).toBe(0)
    expect(colors(paint(), 80)[0]![main + 2]).toBe(scout.color)
    audit.spectrum.startCall('Read')
    step()
    expect(rows()[0]!.slice(main + CHANNEL)).toMatch(/^ {2}audit [⠁-⣿] Read\s*$/)
  })

  test('a channel opens as its agent starts and closes the same way once it is done, the main bars narrowing and widening smoothly', () => {
    const { ensemble, board, step, rows } = staging()
    step()
    ensemble.join('a1', { name: 'scout' })
    const opening: number[] = []
    for (let t = 0; t < 600; t += FRAME_MS) {
      step()
      opening.push(board.bars.columns)
    }
    expect(opening.at(-1)).toBe(80 - CHANNEL)
    expect(new Set(opening).size).toBeGreaterThan(5)
    for (let i = 1; i < opening.length; i++) expect(opening[i - 1]! - opening[i]!).toBeLessThan(4)

    ensemble.end('a1', 'answer')
    for (let t = 0; t < 2900; t += 100) step(100)
    // It says it's done for a while before it closes.
    expect(board.bars.columns).toBe(80 - CHANNEL)
    expect(rows()[0]!.slice(80 - CHANNEL)).toMatch(/^ {2}scout done/)
    const closing: number[] = []
    let shrinking = ''
    for (let t = 0; t < 700; t += FRAME_MS) {
      step()
      closing.push(board.bars.columns)
      if (board.bars.columns > 80 - CHANNEL + 4 && shrinking === '') shrinking = rows()[0]!.slice(board.bars.columns)
    }
    expect(closing.at(-1)).toBe(80)
    expect(new Set(closing).size).toBeGreaterThan(5)
    for (let i = 1; i < closing.length; i++) expect(closing[i]! - closing[i - 1]!).toBeLessThan(4)
    // Shrinking, it still shows itself, not a blank: the way it opened, backward.
    expect(shrinking).toMatch(/^ {2}scout/)
  })

  test('more agents than fit: how many wait shows, and one opens at the end as the first to finish closes', () => {
    const { ensemble, board, step, rows } = staging()
    for (const name of ['one', 'two', 'three']) ensemble.join(name, { name })
    step()
    const main = 80 - 2 * CHANNEL
    const top = () => rows()[0]!.slice(main)
    expect(top()).toMatch(/^ {2}one\s+two\s+\+1$/)
    ensemble.end('one', 'answer')
    step()
    expect(top()).toMatch(/^ {2}one done/)
    const widths = new Set<number>()
    for (let t = 0; t < 4000; t += FRAME_MS) {
      step()
      widths.add(board.bars.columns)
    }
    // Two slid over, three opened after it, and the main bars held, give or take a column.
    expect(rows()[0]!.slice(board.bars.columns)).toMatch(/^ {2}two\s+three\s*$/)
    expect(board.bars.columns).toBe(main)
    for (const width of widths) expect(Math.abs(width - main)).toBeLessThanOrEqual(1)
  })

  test('a channel freed goes to an agent still at work: one that finished while it waited never takes one', () => {
    const { ensemble, step, rows } = staging()
    for (const name of ['one', 'two', 'three', 'four']) ensemble.join(name, { name })
    step()
    const main = 80 - 2 * CHANNEL
    const top = () => rows()[0]!.slice(main)
    expect(top()).toMatch(/^ {2}one\s+two\s+\+2$/)
    ensemble.end('one', 'answer')
    for (let t = 0; t < 2_000; t += 100) step(100)
    ensemble.end('three', 'answer')
    step()
    // Three no longer waits.
    expect(top()).toMatch(/^ {2}one done\s+two\s+\+1$/)
    // One closes while three still says it is done: four opens in its place.
    for (let t = 0; t < 1_600; t += FRAME_MS) step()
    expect(top()).toMatch(/^ {2}two\s+four\s*$/)
  })

  test('the demo brings in two subagents, which play, say they are done, and leave before it ends', () => {
    const spectrum = new Spectrum()
    const ensemble = new Ensemble()
    const demo = new Demo(spectrum, ensemble)
    demo.play()
    const seen = new Set<string>()
    const tools = new Set<string>()
    let together = false
    let done = 0
    for (let t = 0; t < 11_400; t += FRAME_MS) {
      spectrum.step(FRAME_MS, demo)
      ensemble.step()
      if (ensemble.voices.length === 2) together = true
      for (const voice of ensemble.voices) {
        seen.add(voice.name)
        for (const call of voice.spectrum.calls) tools.add(call.name)
        if (voice.outcome === 'done') done += 1
      }
    }
    expect([...seen]).toEqual(['scout', 'tests'])
    expect(together).toBe(true)
    expect(done).toBeGreaterThan(0)
    for (const tool of ['Grep', 'Read', 'Edit', 'Bash']) expect(tools).toContain(tool)
    // Gone by the time the demo's cymbal crashes.
    expect(ensemble.isCalm()).toBe(true)
  })

  test("the demo opens each subagent's transcript in turn, its channel growing into the band, then the main conversation's again", () => {
    const spectrum = new Spectrum()
    const ensemble = new Ensemble()
    const board = new Board(80, 4, { width: 2, gap: 1, meter: true })
    const demo = new Demo(spectrum, ensemble)
    demo.play()
    const views: (string | undefined)[] = []
    let narrowest = 80
    for (let t = 0; t < 12_000; t += FRAME_MS) {
      spectrum.step(FRAME_MS, demo)
      ensemble.step()
      const focus = ensemble.find(demo.view)
      board.step(spectrum, ensemble, focus)
      if (views.at(-1) !== focus?.name) views.push(focus?.name)
      narrowest = Math.min(narrowest, board.bars.columns)
    }
    expect(views).toEqual(['scout', 'tests', undefined])
    // The main bars narrowed to a channel's width, and are whole again once the subagents have left.
    expect(narrowest).toBe(CHANNEL)
    expect(board.bars.columns).toBe(80)
    expect(demo.view).toBeUndefined()
  })

  test('a demo played again over one still playing ends its subagents first: none is left at work', () => {
    const spectrum = new Spectrum()
    const ensemble = new Ensemble()
    const demo = new Demo(spectrum, ensemble)
    demo.play()
    for (let t = 0; t < 5_000; t += FRAME_MS) {
      spectrum.step(FRAME_MS, demo)
      ensemble.step()
    }
    expect(ensemble.voices.length).toBe(2)
    demo.play()
    expect(ensemble.voices.every(voice => voice.outcome === 'done')).toBe(true)
    for (let t = 0; t < 15_000; t += FRAME_MS) {
      spectrum.step(FRAME_MS, demo)
      ensemble.step()
    }
    expect(ensemble.isCalm()).toBe(true)
  })

  test('beside a mini spectrum, the trail names each subagent and what it is doing, in its color', () => {
    const spectrum = new Spectrum()
    const ensemble = new Ensemble()
    const scout = ensemble.join('a1', { name: 'scout' })
    scout.spectrum.startCall('Grep')
    spectrum.endCall(spectrum.startCall('Edit'))
    const cells = trail(spectrum, ink, 60, 2, ensemble)
    const [, bottom] = text(cells, 60)
    expect(bottom).toMatch(/Edit · [⠁-⣿] scout Grep {2}$/)
    expect(colors(cells, 60)[1]![bottom!.indexOf('scout')]).toBe(scout.color)
  })

  test("a subagent in view grows into the main bars' room as they narrow to a channel's width, together, and back once out of view", () => {
    const { spectrum, ensemble, board, step, paint, view, rows } = staging()
    const scout = ensemble.join('a1', { name: 'scout' })
    ensemble.join('a2', { name: 'audit' })
    scout.spectrum.startCall('Grep')
    spectrum.startCall('Edit')
    const main = 80 - 2 * CHANNEL
    step()
    expect(board.bars.columns).toBe(main)

    view('a1')
    const widths: number[] = []
    const audit: number[] = []
    for (let t = 0; t < 700; t += FRAME_MS) {
      step()
      widths.push(board.bars.columns)
      audit.push(rows()[0]!.indexOf('audit'))
    }
    // The main bars narrow smoothly to a channel's width...
    expect(widths.at(-1)).toBe(CHANNEL)
    expect(new Set(widths).size).toBeGreaterThan(5)
    for (let i = 1; i < widths.length; i++) expect(widths[i - 1]! - widths[i]!).toBeLessThan(4)
    // ...as the channel grows by as much: the one after it holds still.
    for (const at of audit) expect(at).toBe(main + CHANNEL + 2)

    const top = rows()[0]!
    // Narrowed, the main bars are labeled as a channel is.
    expect(top.slice(0, CHANNEL)).toMatch(/^main [⠁-⣿] Edit/)
    // Grown, the channel is labeled as the main bars were: its name in its color leading, its call over its band.
    expect(top.slice(CHANNEL, main + CHANNEL)).toMatch(/^ {2}scout .*Grep/)
    expect(colors(paint(), 80)[0]![CHANNEL + 2]).toBe(scout.color)
    expect(top.slice(main + CHANNEL)).toMatch(/^ {2}audit/)

    // Back on the main conversation: each shrinks or widens back to its own size.
    view(undefined)
    for (let t = 0; t < 700; t += FRAME_MS) step()
    expect(board.bars.columns).toBe(main)
    expect(rows()[0]!.slice(0, main)).toContain('Edit')
    expect(rows()[0]!.slice(main, main + CHANNEL)).toMatch(/^ {2}scout [⠁-⣿] Grep/)
  })

  test('a subagent in view that ends says so over its grown channel, which shrinks back as it closes', () => {
    const { spectrum, ensemble, board, step, view, rows } = staging()
    ensemble.join('a1', { name: 'scout' })
    spectrum.startCall('Edit')
    view('a1')
    for (let t = 0; t < 700; t += FRAME_MS) step()
    expect(board.bars.columns).toBe(CHANNEL)
    ensemble.end('a1', 'answer')
    step()
    // Labeled as the main bars are, from where its bars start.
    expect(rows()[0]!.slice(CHANNEL)).toMatch(/^ {2,3}scout done/)
    for (let t = 0; t < 4_000; t += 100) step(100)
    expect(board.bars.columns).toBe(80)
    expect(rows()[0]).toContain('Edit')
    expect(rows()[0]).not.toContain('scout')
  })

  test('a subagent in view with no channel to grow, waiting for one, plays on the main bars, its name leading', () => {
    const { spectrum, ensemble, board, step, view, rows } = staging()
    for (const name of ['one', 'two']) ensemble.join(name, { name })
    const three = ensemble.join('three', { name: 'three' })
    three.spectrum.startCall('Grep')
    spectrum.startCall('Edit')
    view('three')
    for (let t = 0; t < 700; t += FRAME_MS) step()
    const main = 80 - 2 * CHANNEL
    expect(board.bars.columns).toBe(main)
    expect(rows()[0]!.slice(0, main)).toMatch(/^\s*three .*Grep/)
    expect(rows()[0]!.slice(0, main)).not.toContain('Edit')
  })

  test('beside a mini spectrum playing a subagent in view, the trail names it first, then the main loop, then the others', () => {
    const spectrum = new Spectrum()
    const ensemble = new Ensemble()
    const scout = ensemble.join('a1', { name: 'scout' })
    ensemble.join('a2', { name: 'audit' })
    scout.spectrum.startCall('Grep')
    spectrum.endCall(spectrum.startCall('Edit'))
    const [, bottom] = text(trail(spectrum, ink, 60, 2, ensemble, scout), 60)
    expect(bottom).toMatch(/audit · main Edit · [⠁-⣿] scout Grep {2}$/)
  })

  test('a board paints into the same cells each frame, nothing of the last left behind', () => {
    const { spectrum, ensemble, step, paint, view } = staging()
    const scout = ensemble.join('a1', { name: 'scout' })
    ensemble.join('a2', { name: 'audit' })
    spectrum.beginThinking()
    scout.spectrum.startCall('Grep')
    spectrum.startCall('Edit')
    // Through the channels opening, one growing in view and shrinking back, all of it moving.
    for (let t = 0; t < 2_000; t += FRAME_MS) {
      if (t === 330) view('a1')
      if (t === 990) view(undefined)
      step()
      expect(paint()).toBe(paint())
    }
    // All of it done and fallen: the cells a board fresh to the same stage paints.
    spectrum.endThinking()
    scout.spectrum.endCall(scout.spectrum.calls[0]!)
    spectrum.endCall(spectrum.calls[0]!)
    for (let t = 0; t < 6_000; t += 100) step(100)
    const fresh = new Board(80, 4, { width: 2, gap: 1, meter: true })
    fresh.step(spectrum, ensemble)
    expect(paint()).toBe(fresh.paint(ink, spectrum, ensemble, true))
    expect(text(paint(), 80)[0]).toMatch(/scout\s+audit/)
  })

  test('a drawing resized plays on as it stood: its bars at their heights, its channels as open as they were', () => {
    const stage = new Stage('viz')
    const layout = { width: 2, gap: 1, meter: true }
    const site = stage.mount('band', 'band', 80, 4, { layout, labels: true })
    const scout = stage.ensemble.join('a1', { name: 'scout' })
    stage.ensemble.join('a2', { name: 'audit' })
    scout.spectrum.startCall('Grep')
    stage.spectrum.startCall('Bash')
    for (let t = 0; t < 600; t += FRAME_MS) stage.frame(FRAME_MS, () => {})
    const standing = raised(text(painted(site.board.bars, ink, stage.spectrum), site.board.bars.columns))
    expect(standing).toBeGreaterThan(0)

    for (const [columns, rows] of [[100, 4], [64, 4], [64, 6]] as const) {
      const { board } = stage.mount('band', 'band', columns, rows, { layout, labels: true })
      expect(board.columns).toBe(columns)
      // Before a frame: standing, not risen again from the floor.
      expect(board.isSettled()).toBe(false)
      expect(raised(text(painted(board.bars, ink, stage.spectrum), columns))).toBeGreaterThan(0.5 * standing)
      // Open at once where they fit, the one that no longer does waiting for room.
      expect(board.channels.has(scout)).toBe(true)
      stage.frame(FRAME_MS, () => {})
      expect(text(board.paint(ink, stage.spectrum, stage.ensemble, true), columns)[0]).toMatch(columns > 80 ? /scout.*audit/ : /scout.*\+1$/)
    }
  })
})

describe('subagents, through the plugin', () => {
  /** Spawns as the Agent tool does, each started with the next id: a1, a2, ... */
  const spawner = (on: On) => {
    let started = 0
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++started}` }))
  }
  /** Spawns as the Agent tool does; `isTeammate` starts a teammate of the session's team. */
  const spawn = ($: Engine, name: string, isTeammate = false) =>
    $.agent.spawn({
      tool_use_id: `spawn-${name}`,
      prompt: 'Look around.',
      description: `Look for ${name}`,
      subagentType: isTeammate ? 'teammate' : 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
      name,
      ...(isTeammate ? { isTeammate: true as const } : {}),
    })
  /** Spawns the test answers when it likes, each by its name with an id: the subagent's loop may start, and end, before then. */
  const answered = (on: On) => {
    const answers = new Map<string, (spawned: AgentSpawnResult) => void>()
    on('agent.spawn', ($, e) => new Promise<AgentSpawnResult>(resolve => answers.set(e.name ?? '', resolve)))
    return (name: string, agentId: string) => answers.get(name)?.({ model: 'claude-haiku-5-5', agentId })
  }
  /** A call made in subagent `agentId`'s loop: a session stamps the loop on it, which `$.tool.call` names no field for. */
  const inLoop = (agentId: string) => ({ agentId })
  /** A drawing's columns, as mounted. */
  const columnsOf = async (ui: { find: (query: { type: 'Raster'; key: string }) => Promise<{ props: unknown } | undefined> }, key: string) =>
    ((await ui.find({ type: 'Raster', key }))?.props as { columns?: number } | undefined)?.columns
  /** How red a drawing's bars are from column `from` to `to`, below its label row: red over green, on average over the cells drawn. */
  const rednessOf = (cells: string, from: number, to: number) => {
    const drawn = colors(cells, 80)
      .slice(1)
      .flatMap(row => row.slice(from, to))
      .filter(c => c !== 0)
    return drawn.reduce((sum, c) => sum + ((c >> 16) & 0xff) - ((c >> 8) & 0xff), 0) / Math.max(1, drawn.length)
  }

  test('a subagent plays in a channel that opens at the right of the band, says when it is done, and closes', async ($, on) => {
    spawner(on)
    const { clock, ui, cells, finish } = await staged($, on)
    const rows = () => text(cells(), 80)
    const channel = () => (rows()[0] ?? '').slice(80 - CHANNEL)
    const main = () => (rows()[0] ?? '').slice(0, 80 - CHANNEL)
    // The context meter, at the main bars' right edge: where the bars end.
    const meter = () => rows().at(-1)?.indexOf('░░')
    await clock.advance(100)
    expect(meter()).toBe(78)

    const spawned = await spawn($, 'scout')
    const agentId = spawned.agentId!
    await clock.advance(600)
    expect(channel()).toMatch(/^ {2}scout/)
    expect(meter()).toBe(78 - CHANNEL)
    // One drawing all along: the channel opens inside the band.
    expect(await columnsOf(ui, 'band')).toBe(80)

    // Its call plays in its channel, not over the main spectrum.
    const call = $.tool.call({ tool: 'Read', file_path: '/src/auth.ts', tool_use_id: 't1', ...inLoop(agentId) })
    await clock.advance(200)
    expect(channel()).toMatch(/scout [⠁-⣿] Read/)
    expect(main()).not.toContain('Read')
    finish('t1')
    await call

    await $.turn.complete({ reason: 'answer', answer: 'Found it.', durationMs: 1000, isAborted: false, turnId: 'u1', agentId })
    await clock.advance(200)
    expect(channel()).toContain('scout done')
    await clock.advance(5000)
    expect(rows()[0]).not.toContain('scout')
    expect(meter()).toBe(78)
    await ui.unmount()
  })

  test("a subagent's permission ask has its channel waiting, and the band waiting on you, after the main loop's turn too", async ($, on) => {
    spawner(on)
    const { clock, ui, cells, finish } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    const agentId = (await spawn($, 'scout')).agentId!
    const call = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1', ...inLoop(agentId) })
    await clock.settle()
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: agentId })
    // The main loop's turn ends with what is left of it, none of the subagent's.
    await $.turn.complete({ reason: 'answer', answer: 'A scout is on it.', durationMs: 1000, isAborted: false, turnId: 'u1' })
    await clock.advance(3000)
    expect(top()).toMatch(/^\s*waiting on you/)
    expect(top().slice(80 - CHANNEL)).toContain('scout waiting')

    finish('t1')
    await call
    await clock.advance(1000)
    expect(top()).not.toContain('waiting')
    await ui.unmount()
  })

  test("a subagent's tool that fails flashes its own channel red, not the main bars", async ($, on) => {
    spawner(on)
    const { clock, ui, cells, finish } = await staged($, on)
    const agentId = (await spawn($, 'scout')).agentId!
    const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1', ...inLoop(agentId) })
    await clock.advance(600)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 't1', error: 'Exit code 2', agent_id: agentId })
    finish('t1', { result: 'Exit code 2', isError: true })
    await call
    await clock.advance(100)
    expect(rednessOf(cells(), 80 - CHANNEL, 80)).toBeGreaterThan(rednessOf(cells(), 0, 80 - CHANNEL) + 30)
    await ui.unmount()
  })

  test("a subagent's turn that is interrupted says it stopped, and one that errs says it failed", async ($, on) => {
    spawner(on)
    const { clock, ui, cells } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    const one = (await spawn($, 'one')).agentId!
    const two = (await spawn($, 'two')).agentId!
    await clock.advance(600)
    await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1000, isAborted: true, turnId: 'u1', agentId: one })
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1000, isAborted: false, turnId: 'u2', agentId: two })
    await clock.advance(200)
    expect(top().slice(80 - 2 * CHANNEL)).toMatch(/^ {2}one stopped\s+two failed\s*$/)
    await clock.advance(5000)
    expect(top()).not.toMatch(/one|two/)
    await ui.unmount()
  })

  test('a teammate in a terminal pane of its own gets no channel: nothing of it plays here', async ($, on) => {
    // A teammate in a pane runs no loop here, and its id is its address; one in this process has an id of its own.
    on('agent.spawn', ($, e) => ({ model: 'claude-haiku-5-5', agentId: e.name === 'pane' ? 'pane@crew' : 'a1', teammateId: `${e.name}@crew` }))
    const { clock, ui, cells } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    await spawn($, 'pane', true)
    await spawn($, 'mate', true)
    await clock.advance(600)
    expect(top().slice(80 - CHANNEL)).toMatch(/^ {2}mate/)
    expect(top()).not.toContain('pane')
    await ui.unmount()
  })

  test('a subagent that stops says it is done and closes, though its turn never ends here; one a hook sends back to work plays on', async ($, on) => {
    spawner(on)
    let verdict: { block?: string } = {}
    on('classic.SubagentStop', () => verdict)
    const { clock, ui, cells } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    const agentId = (await spawn($, 'scout')).agentId!
    await clock.advance(600)
    // `stop_hook_active`: a stop that comes after a hook sent it back to work.
    const stop = (isAgain: boolean) => $.classic.SubagentStop({ agent_id: agentId, agent_type: 'Explore', stop_hook_active: isAgain, agent_transcript_path: '' })
    verdict = { block: 'The tests still fail.' }
    await stop(false)
    await clock.advance(200)
    expect(top().slice(80 - CHANNEL)).toMatch(/^ {2}scout\s*$/)
    verdict = {}
    await stop(true)
    await clock.advance(200)
    expect(top().slice(80 - CHANNEL)).toMatch(/^ {2}scout done/)
    await clock.advance(5000)
    expect(top()).not.toContain('scout')
    await ui.unmount()
  })

  test('subagents whose loops start before their spawns are answered play their first steps in their channels, each named once answered', async ($, on) => {
    const answer = answered(on)
    on('classic.SubagentStart', () => ({}))
    const { clock, ui, cells, finish } = await staged($, on)
    const channels = () => (text(cells(), 80)[0] ?? '').slice(80 - 2 * CHANNEL)
    const spawning = [spawn($, 'scout'), spawn($, 'audit')]
    await clock.settle()
    // Both of one type, and the second's loop starts first: it is taken for the first's until they are answered.
    await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'Explore' })
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    const call = $.tool.call({ tool: 'Read', file_path: '/src/auth.ts', tool_use_id: 't1', ...inLoop('a2') })
    await clock.advance(600)
    expect(channels()).toMatch(/^ {2}\S+ [⠁-⣿] Read/)
    expect((text(cells(), 80)[0] ?? '').slice(0, 80 - 2 * CHANNEL)).not.toContain('Read')
    answer('scout', 'a1')
    answer('audit', 'a2')
    await Promise.all(spawning)
    await clock.advance(100)
    expect(channels()).toMatch(/^ {2}audit [⠁-⣿] Read\s+scout\s*$/)
    finish('t1')
    await call
    await ui.unmount()
  })

  test('a subagent whose loop starts and ends before its spawn is answered says how it went, and closes', async ($, on) => {
    const answer = answered(on)
    on('classic.SubagentStart', () => ({}))
    const { clock, ui, cells } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    const spawning = spawn($, 'scout')
    await clock.settle()
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await clock.advance(100)
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 10, isAborted: false, turnId: 'u1', agentId: 'a1' })
    // Answered once it has ended: it stays ended.
    answer('scout', 'a1')
    await spawning
    await clock.advance(600)
    expect(top().slice(80 - CHANNEL)).toMatch(/^ {2}scout failed/)
    await clock.advance(5000)
    expect(top()).not.toContain('scout')
    await ui.unmount()
  })

  test('a subagent whose loop ends, never heard of, before its spawn is answered opens no channel that would never close, and plays if it works again', async ($, on) => {
    const answer = answered(on)
    const { clock, ui, cells, finish } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    await clock.advance(200)
    const calm = redness(cells())
    const spawning = spawn($, 'scout')
    await clock.settle()
    // It fails at once: the main bars flash for it, as for a loop never heard of.
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 10, isAborted: false, turnId: 'u1', agentId: 'a1' })
    answer('scout', 'a1')
    await spawning
    await clock.advance(100)
    expect(redness(cells())).toBeGreaterThan(calm + 40)
    await clock.advance(1000)
    expect(top()).not.toContain('scout')
    // Resumed, it is the scout.
    const call = $.tool.call({ tool: 'Read', file_path: '/src/auth.ts', tool_use_id: 't1', ...inLoop('a1') })
    await clock.advance(600)
    expect(top().slice(80 - CHANNEL)).toMatch(/^ {2}scout [⠁-⣿] Read/)
    finish('t1')
    await call
    await ui.unmount()
  })

  test('in /viz auto, a subagent at work without a sound lets the band go, and brings it back as it stops', async ($, on) => {
    spawner(on)
    on('classic.SubagentStop', () => ({}))
    const { clock, ui } = await staged($, on, { mode: 'auto' })
    const agentId = (await spawn($, 'scout')).agentId!
    await clock.advance(2000)
    await ui.unmount()
    // Claude rests, and nothing moves: the band is down, though the subagent is on stage.
    const resting = await $.ui.mount(band(false))
    expect(await resting.find({ type: 'Raster', key: 'band' })).toBeUndefined()
    await resting.unmount()
    // It stops: its channel says so, on a band up again.
    await $.classic.SubagentStop({ agent_id: agentId, agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '' })
    const ended = await $.ui.mount(band(false))
    expect(await ended.find({ type: 'Raster', key: 'band' })).toBeDefined()
    await ended.unmount()
  })

  test('/viz demo plays its subagents in channels at the right of the band, and opens each in turn', async ($, on) => {
    const { clock, ui, cells, viz } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    await viz('demo')
    // The drums start 2.5 s in: both channels open, neither opened yet (tests, thinking, cut to fit).
    await clock.advance(4_400)
    expect(top().slice(80 - 2 * CHANNEL)).toMatch(/^ {2}scout.* {2}test/)
    // Scout's transcript opened: its channel grown, the main bars narrowed.
    await clock.advance(900)
    expect(top().slice(0, CHANNEL)).toMatch(/^main/)
    expect(top().slice(CHANNEL)).toMatch(/^ {2,3}scout/)
    // Then tests': scout's back to a channel's width, tests' grown.
    await clock.advance(1_400)
    expect(top().slice(0, CHANNEL)).toMatch(/^main/)
    expect(top().slice(CHANNEL, 2 * CHANNEL)).toMatch(/^ {2}scout/)
    expect(top().slice(2 * CHANNEL)).toMatch(/^ {2,3}tests/)
    // Then the main conversation's again.
    await clock.advance(1_100)
    expect(top().slice(80 - 2 * CHANNEL)).toMatch(/^ {2}scout.* {2}tests/)
    await ui.unmount()
  })

  /** The band above the prompt with subagent `agentId`'s transcript in view, or the main conversation's. */
  const viewing = (agentId?: string) => ({ ...band(true), props: { ...band(true).props, view: agentId === undefined ? {} : { agentId } } })

  test("opening a subagent's transcript grows its channel across the band as the main bars narrow, and back", async ($, on) => {
    spawner(on)
    const { clock, ui, cells, finish } = await staged($, on)
    const top = () => text(cells(), 80)[0] ?? ''
    const agentId = (await spawn($, 'scout')).agentId!
    const read = $.tool.call({ tool: 'Read', file_path: '/src/auth.ts', tool_use_id: 't1', ...inLoop(agentId) })
    const make = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't2' })
    await clock.advance(600)
    expect(top().slice(0, 80 - CHANNEL)).toContain('Bash')
    expect(top().slice(80 - CHANNEL)).toMatch(/^ {2}scout [⠁-⣿] Read/)

    await ui.unmount()
    const focused = await $.ui.mount(viewing(agentId))
    await clock.advance(700)
    expect(top().slice(0, CHANNEL)).toMatch(/^main [⠁-⣿] Bash/)
    expect(top().slice(CHANNEL)).toMatch(/^ {2,3}scout .*Read/)
    expect(top().slice(CHANNEL)).not.toContain('Bash')
    await focused.unmount()

    const back = await $.ui.mount(viewing())
    await clock.advance(700)
    expect(top().slice(0, 80 - CHANNEL)).toContain('Bash')
    expect(top().slice(80 - CHANNEL)).toMatch(/^ {2}scout [⠁-⣿] Read/)
    finish('t1')
    finish('t2')
    await Promise.all([read, make])
    await back.unmount()
  })

  test('the band below the prompt puts the subagent in view in focus too, as the band above is told it', async ($, on) => {
    spawner(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    const { clock, ui, cells, viz } = await staged($, on)
    await viz('pos below')
    const agentId = (await spawn($, 'scout')).agentId!
    await ui.unmount()
    // Above the prompt the engine draws its own, and the plugin is told which transcript is in view all the same.
    const above = await $.ui.mount(viewing(agentId))
    const below = await $.ui.mount({
      plugin: 'visualizer',
      surface: 'terminal' as const,
      component: 'PromptHint' as const,
      requestId: 'hint',
      viewport: { columns: 85, rows: 40, isFullscreen: true },
      props: { isDraft: false, isWorking: true, hint: '? for shortcuts' },
    })
    await clock.advance(1_200)
    const top = text(cells(), 80)[0] ?? ''
    expect(top.slice(0, CHANNEL)).toMatch(/^main/)
    expect(top.slice(CHANNEL)).toMatch(/^ {2,3}scout/)
    await below.unmount()
    await above.unmount()
  })

  test('after a reload, the subagents still at work are back in their channels, open at once', async ($, on) => {
    on('agent.list', () => ({
      value: [
        { id: 'a1', description: 'Map the API', type: 'Explore', status: 'running' as const },
        { id: 'a2', description: 'Old job', type: 'Explore', status: 'completed' as const },
        { id: 'a3', description: 'Plan it', type: 'Plan', status: 'pending' as const },
        { id: 'a4', description: 'Wait on CI', type: 'general-purpose', status: 'waiting' as const },
        // A teammate in a terminal pane of its own, its id its address: its pane may have closed long ago.
        { id: 'pane@crew', teammateId: 'pane@crew', name: 'pane', description: 'Gone', type: 'teammate', status: 'running' as const },
      ],
    }))
    const { clock, ui, cells } = await staged($, on)
    await clock.advance(FRAME_MS)
    const top = text(cells(), 80)[0] ?? ''
    // Two channels fit; the third at work waits for one.
    expect(top.slice(80 - 2 * CHANNEL)).toMatch(/^ {2}Map the API\s+Plan it\s+\+1$/)
    expect(top).not.toContain('Old job')
    await ui.unmount()
  })
})
