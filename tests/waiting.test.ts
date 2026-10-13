import { describe, expect, test } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { FRAME_MS } from '../hooks/engine/math'
import { clockText } from '../hooks/engine/names'
import { INDEX } from '../hooks/engine/sources'
import { BEAT, GRACE, Spectrum } from '../hooks/engine/spectrum'
import { trail } from '../hooks/engine/trail'
import { staged, text } from './support'

describe('waiting on you', () => {
  /** Plays `ms` of music, a frame at a time. */
  const steps = (spectrum: Spectrum, bars: Bars, ms: number) => {
    for (let t = 0; t < ms; t += FRAME_MS) {
      spectrum.step()
      bars.step(spectrum)
    }
  }

  test('an ask past its grace rests the held note and vamps, labeled, until it is answered', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4, { width: 2, gap: 1 })
    const call = spectrum.startCall('Bash')
    const ask = spectrum.ask('bash', call)
    steps(spectrum, bars, GRACE - FRAME_MS)
    expect(spectrum.cue).toBe(0)
    expect(spectrum.waitedFor()).toBeUndefined()

    steps(spectrum, bars, 3_000)
    expect(spectrum.cue).toBeGreaterThan(0.9)
    expect(spectrum.isResting()).toBe(false)
    // Only the vamp plays: the frames can slow down.
    expect(spectrum.isCalm()).toBe(true)
    const [top] = text(bars.paint('instrument', spectrum, true), 80)
    expect(top).toMatch(/^waiting on you \u00b7 0:04/)
    expect(top).toContain('Bash')
    // No spinner on a call that waits.
    const [, bottom] = text(trail(spectrum, 'instrument', 50, 2), 50)
    expect(bottom?.trimEnd()).toMatch(/ Bash \u00b7 waiting on you \u00b7 0:04$/)

    spectrum.answer(ask)
    steps(spectrum, bars, 1_300)
    expect(spectrum.cue).toBe(0)
    expect(spectrum.isCalm()).toBe(false)
    expect(text(bars.paint('instrument', spectrum, true), 80)[0]).not.toContain('waiting')
  })

  test('an ask answered within its grace never vamps', () => {
    const spectrum = new Spectrum()
    const ask = spectrum.ask('edit', spectrum.startCall('Edit'))
    let most = 0
    for (let t = 0; t < GRACE - 5 * FRAME_MS; t += FRAME_MS) {
      spectrum.step()
      most = Math.max(most, spectrum.cue)
    }
    spectrum.answer(ask)
    for (let i = 0; i < 60; i++) {
      spectrum.step()
      most = Math.max(most, spectrum.cue)
    }
    expect(most).toBe(0)
  })

  test('the waiting tool\'s band pulses on the beat, the same each bar, and the pulses shrink on a long wait', () => {
    const spectrum = new Spectrum()
    spectrum.ask('bash', undefined, 0)
    for (let i = 0; i < 200; i++) spectrum.step()
    // A bar of four beats, in steps that land on each beat.
    const bar = (x: number) => {
      const levels: number[] = []
      for (let t = 0; t < 4 * BEAT; t += 25) {
        spectrum.step(25)
        levels.push(spectrum.at(x))
      }
      return levels
    }
    const first = bar(0.58)
    const second = bar(0.58)
    expect(Math.max(...first)).toBeGreaterThan(0.5)
    expect(Math.max(...second.map((k, i) => Math.abs(k - first[i]!)))).toBeLessThan(1e-6)
    // The other bands stay down: only the waiting tool's band moves.
    expect(Math.max(...bar(0.05), ...bar(0.32))).toBeLessThan(0.02)
    for (let i = 0; i < 1100; i++) spectrum.step()
    expect(Math.max(...bar(0.58))).toBeLessThan(0.3)
    expect(spectrum.tick()).toBeGreaterThan(0)
  })

  test("a subagent's ask, heard on the main spectrum, rests none of the main loop's own held notes", () => {
    const spectrum = new Spectrum()
    const call = spectrum.startCall('Bash')
    // A subagent's Bash waits on the person: heard here, its call on the subagent's own spectrum.
    spectrum.ask('bash', undefined, 0)
    for (let i = 0; i < 100; i++) spectrum.step()
    expect(spectrum.cue).toBeGreaterThan(0.9)
    expect(spectrum.level[INDEX.bash]).toBeGreaterThan(0.1)
    expect(spectrum.isRunning(call)).toBe(true)
    // The main loop's own Bash waits too: its held note rests.
    spectrum.ask('bash', call, 0)
    for (let i = 0; i < 100; i++) spectrum.step()
    expect(spectrum.level[INDEX.bash]).toBe(0)
    expect(spectrum.isCalm()).toBe(true)
  })

  test('the wait reads as a clock', () => {
    expect(clockText(0)).toBe('0:00')
    expect(clockText(42_000)).toBe('0:42')
    expect(clockText(3_723_000)).toBe('1:02:03')
  })

  test('a permission ask vamps on the band until the call runs', async ($, on) => {
    const { clock, ui, label, finish } = await staged($, on)
    const call = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1' })
    await clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    await clock.advance(1000)
    expect(label()).toContain('Bash')
    expect(label()).not.toContain('waiting on you')
    await clock.advance(2000)
    expect(label()).toMatch(/^\s*waiting on you \u00b7 0:0[23]/)

    // The run-in-background pill shows once it runs: answered.
    await $.ui.mount({
      plugin: 'visualizer',
      surface: 'terminal',
      component: 'ToolProgress',
      requestId: 't1',
      props: { tool_use_id: 't1', kind: 'background_hint', hint: '' },
    })
    await clock.advance(1000)
    expect(label()).not.toContain('waiting on you')
    finish('t1')
    await call
    await ui.unmount()
  })

  test('an ask the mode settles on its own never vamps, as auto mode settles most', async ($, on) => {
    const { clock, ui, label, finish } = await staged($, on)
    // A background subagent's call the classifier lets run: no progress row shows for it here.
    const call = $.tool.call({ tool: 'Bash', command: 'make test', tool_use_id: 't1' })
    await clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'make test' }, tool_use_id: 't1', agentId: 'a1' })
    await clock.advance(5000)
    expect(label()).toContain('Bash')
    expect(label()).not.toContain('waiting on you')
    finish('t1')
    await call
    await ui.unmount()
  })

  test('a permission request vamps the call it was raised for', async ($, on) => {
    const { clock, ui, label, finish } = await staged($, on)
    const first = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1' })
    const second = $.tool.call({ tool: 'Bash', command: 'rm -r build', tool_use_id: 't2' })
    await clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' })
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -r build' }, tool_use_id: 't2' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -r build' } })
    await clock.advance(3000)
    expect(label()).toMatch(/^\s*waiting on you/)

    // The call the classifier let run ends; the one put to the person still waits.
    finish('t1')
    await first
    await clock.advance(1000)
    expect(label()).toMatch(/^\s*waiting on you/)
    finish('t2')
    await second
    await clock.advance(1000)
    expect(label()).not.toContain('waiting on you')
    await ui.unmount()
  })

  test('a question, or a plan to approve, waits on the person at once, until it is answered', async ($, on) => {
    const { clock, ui, label, finish } = await staged($, on)
    const question = { question: 'Which store?', header: 'Store', options: [{ label: 'Redis', description: 'fast' }, { label: 'SQLite', description: 'simple' }], multiSelect: false }
    const asked = [
      () => $.tool.call({ tool: 'AskUserQuestion', questions: [question], tool_use_id: 't1' }),
      () => $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 't2' }),
    ]
    for (const [i, ask] of asked.entries()) {
      const call = ask()
      await clock.advance(100)
      expect(label()).toMatch(/^\s*waiting on you · 0:00/)
      finish(`t${i + 1}`)
      await call
      await clock.advance(1000)
      expect(label()).not.toContain('waiting on you')
    }
    await ui.unmount()
  })

  test('a permission ask a hook answers never waits on the person, however long the call then runs', async ($, on) => {
    // A settings hook beneath allows it, so the person is never asked.
    const { clock, ui, label, finish } = await staged($, on, { decision: { behavior: 'allow' } })
    const call = $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'Sum it up.', tool_use_id: 't1' })
    await clock.settle()
    await $.classic.PermissionRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com', prompt: 'Sum it up.' } })
    await clock.advance(5000)
    expect(label()).toContain('WebFetch')
    expect(label()).not.toContain('waiting on you')
    finish('t1')
    await call
    await ui.unmount()
  })

  test("the main loop's turn ends with what is left of it: an ask, a call and thinking whose ends never came", async ($, on) => {
    let resume = () => {}
    on('turn.step', async function* ($, e) {
      yield { kind: 'thinking' as const, index: 0, text: 'Let me see.' }
      await new Promise<void>(resolve => (resume = resolve))

      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    const { clock, ui, label, finish } = await staged($, on)
    const reading = (async () => {
      for await (const _ of $.turn.step({ turnId: 'u1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      }
    })()
    await clock.advance(600)
    expect(label()).toContain('thinking')
    const call = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1' })
    await clock.settle()
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    await clock.advance(3000)
    expect(label()).toMatch(/^\s*waiting on you/)

    await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 4000, isAborted: true, turnId: 'u1' })
    await clock.advance(3500)
    expect(label()).not.toContain('waiting on you')
    expect(label()).not.toContain('thinking')
    expect(label()).not.toContain('Bash')
    resume()
    await reading
    finish('t1')
    await call
    await ui.unmount()
  })
})
