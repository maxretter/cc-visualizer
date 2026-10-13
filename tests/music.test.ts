import { describe, expect, test } from 'claude-code/testing'

import { Bars } from '../hooks/engine/bars'
import { encodeBase64 } from '../hooks/engine/cells'
import { clockText } from '../hooks/engine/names'
import { sourceOf, SOURCES } from '../hooks/engine/sources'
import type { SourceId } from '../hooks/engine/sources'
import { Spectrum } from '../hooks/engine/spectrum'
import { Step } from '../hooks/engine/step'
import type { Chunk } from '../hooks/engine/step'
import { trail } from '../hooks/engine/trail'
import { redness, staged, text, thirds } from './support'

describe('engine', () => {
  test('tools land on their instruments', () => {
    expect(sourceOf('Read')).toBe('read')
    expect(sourceOf('Edit')).toBe('edit')
    expect(sourceOf('Bash')).toBe('bash')
    expect(sourceOf('mcp__claude-in-chrome__navigate')).toBe('web')
    expect(sourceOf('Agent')).toBe('agent')
  })

  test('a hit raises the bars, which fall back to the floor once quiet', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(60, 4)
    spectrum.hit('bash')
    spectrum.step()
    bars.step(spectrum)
    expect(bars.isSettled()).toBe(false)
    for (let i = 0; i < 400; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    expect(spectrum.isQuiet()).toBe(true)
    expect(bars.isSettled()).toBe(true)
  })

  test('a running tool holds a note until it is released', () => {
    const spectrum = new Spectrum()
    spectrum.hold('read')
    for (let i = 0; i < 200; i++) spectrum.step()
    expect(spectrum.isQuiet()).toBe(false)
    spectrum.release('read')
    for (let i = 0; i < 200; i++) spectrum.step()
    expect(spectrum.isQuiet()).toBe(true)
  })

  test('cells cover the whole raster in every theme', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(37, 5)
    spectrum.playDemo()
    for (let i = 0; i < 30; i++) {
      spectrum.step()
      bars.step(spectrum)
    }
    for (const theme of ['instrument', 'claude', 'synthwave', 'classic'] as const) {
      // 12 bytes a cell, base64 is 4 characters per 3 bytes.
      expect(bars.paint(theme, spectrum, true).length).toBe((37 * 5 * 12 * 4) / 3)
      expect(bars.legend(theme).length).toBe((37 * 12 * 4) / 3)
    }
  })
})

describe('time', () => {
  test('the music keeps time at any frame rate', () => {
    // A prompt's sweep, an error's flash, the meter filling, and apart, the
    // brainwave coming in: 600 ms of each at 60, 30 and 15 ms a frame.
    const played = (step: number, start: (spectrum: Spectrum) => void) => {
      const spectrum = new Spectrum()
      start(spectrum)
      for (let t = 0; t < 600; t += step) spectrum.step(step)
      return spectrum
    }
    const sent = (s: Spectrum) => {
      s.kick()
      s.error()
      s.measure(60)
    }
    const thinking = (s: Spectrum) => s.beginThinking()
    const full = played(30, sent)
    for (const step of [60, 15]) {
      const other = played(step, sent)
      expect(other.now).toBe(600)
      const reads: ((s: Spectrum) => number)[] = [s => s.flash, s => s.gauge, s => s.at(0.9)]
      for (const read of reads) {
        expect(Math.abs(read(other) - read(full))).toBeLessThan(1e-6)
      }
      expect(Math.abs(played(step, thinking).mind - played(30, thinking).mind)).toBeLessThan(1e-6)
    }
    // The sweep crossed the spectrum at its own speed, not a step's.
    expect(full.at(0.9)).toBeGreaterThan(full.at(0.6) + 0.5)
  })

  test('a long gap moves the clocks, not the bars', () => {
    const spectrum = new Spectrum()
    const bars = new Bars(80, 4)
    spectrum.ask('bash', spectrum.startCall('Bash'))
    spectrum.step()
    bars.step(spectrum)
    // The laptop sleeps through ten minutes of waiting.
    spectrum.step(600_000)
    bars.step(spectrum)
    expect(spectrum.dt).toBe(250)
    expect(clockText(spectrum.waitedFor()!)).toBe('10:00')
    const [, bottom] = text(trail(spectrum, 'instrument', 50, 2), 50)
    expect(bottom).toContain('waiting on you · 10:00')
  })
})

describe('errors', () => {
  test('a tool that fails flashes the bars red; a call refused or interrupted never ran, and does not', async ($, on) => {
    const { clock, ui, cells, finish } = await staged($, on)
    // A Bash call that ends in an error, the failure raised when it ran: how red the bars are just after.
    const end = async (id: string, failure?: { is_interrupt?: boolean }) => {
      const call = $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: id })
      await clock.settle()
      if (failure !== undefined) {
        await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: id, error: 'Exit code 2', ...failure })
      }
      finish(id, { result: 'Exit code 2', isError: true })
      await call
      await clock.advance(100)
      const red = redness(cells())
      await clock.advance(3000)
      return red
    }

    const refused = await end('t1')
    const failed = await end('t2', {})
    const interrupted = await end('t3', { is_interrupt: true })
    expect(failed).toBeGreaterThan(refused + 30)
    expect(interrupted).toBeLessThan(failed - 30)
    await ui.unmount()
  })
})

describe('streaming', () => {
  test('text after a lull in the stream moves the bars again', async ($, on) => {
    let resume = () => {}
    on('turn.step', async function* ($, e) {
      yield { kind: 'text' as const, index: 0, text: 'Let me look' }
      await new Promise<void>(resolve => (resume = resolve))
      yield { kind: 'text' as const, index: 0, text: ' at the code, the tests and the docs.' }

      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    const { clock, ui, blits } = await staged($, on, { mode: 'auto' })

    const reading = (async () => {
      for await (const _ of $.turn.step({ turnId: 'u1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      }
    })()
    // The lull: the bars fall, and the frames stop.
    await clock.advance(5000)
    const sent = blits()
    await clock.advance(1000)
    expect(blits()).toBe(sent)

    resume()
    await reading
    await clock.advance(500)
    expect(blits()).toBeGreaterThan(sent)
    await ui.unmount()
  })
})

describe('a model request', () => {
  const levelOf = (spectrum: Spectrum, id: SourceId) => spectrum.level[SOURCES.findIndex(source => source.id === id)]!

  test('thinks until its first text or tool call, and again when it thinks anew; its end stops it', () => {
    const spectrum = new Spectrum()
    const step = new Step(spectrum)
    expect(spectrum.thinking).toBe(1)
    step.hear({ kind: 'text', text: 'Hi' })
    expect(spectrum.thinking).toBe(0)
    step.hear({ kind: 'thinking', text: 'hmm' })
    expect(spectrum.thinking).toBe(1)
    step.hear({ kind: 'tool', name: 'Bash' })
    expect(spectrum.thinking).toBe(0)
    step.end()
    expect(spectrum.thinking).toBe(0)

    // Two at once: one cut off while thinking stops its own thinking alone, once.
    const first = new Step(spectrum)
    const second = new Step(spectrum)
    first.end()
    first.end()
    expect(spectrum.thinking).toBe(1)
    second.end()
    expect(spectrum.thinking).toBe(0)
  })

  test("its chunks play their bands: text the bass, a call its tool's band, the arguments hats; a subagent's softer", () => {
    const played = (chunk: Chunk, isSubagent = false) => {
      const spectrum = new Spectrum()
      new Step(spectrum, isSubagent).hear(chunk)
      spectrum.step()
      return spectrum
    }
    expect(levelOf(played({ kind: 'text', text: 'x'.repeat(18) }), 'text')).toBeGreaterThan(0.5)
    expect(levelOf(played({ kind: 'tool', name: 'Edit' }), 'edit')).toBeGreaterThan(0.8)
    expect(levelOf(played({ kind: 'input', json: '{"command":"ls -la /tmp"}' }), 'args')).toBeGreaterThan(0.3)
    expect(levelOf(played({ kind: 'tool', name: 'Edit' }, true), 'edit')).toBeLessThan(levelOf(played({ kind: 'tool', name: 'Edit' }), 'edit') - 0.1)
    // Thinking text makes the thinking restless.
    expect(played({ kind: 'thinking', text: 'x'.repeat(60) }).restless).toBeGreaterThan(0.2)
  })
})

describe('the end of a turn', () => {
  const ended = (reason: string, isSubagent = false) => {
    const spectrum = new Spectrum()
    spectrum.ended(reason, isSubagent)
    spectrum.step()
    return spectrum
  }

  test('an answer crashes a cymbal, heavier in the highs, a subagent’s softer', () => {
    const answered = ended('answer')
    expect(answered.at(0.9)).toBeGreaterThan(answered.at(0.1) + 0.2)
    expect(ended('answer', true).at(0.9)).toBeLessThan(answered.at(0.9) - 0.2)
    expect(answered.flash).toBe(0)
  })

  test('an interrupt sweeps from the top of the spectrum down; an error or a refusal flashes red', () => {
    const aborted = ended('aborted')
    expect(aborted.flash).toBe(0)
    expect(aborted.at(0.95)).toBeGreaterThan(aborted.at(0.3) + 0.5)
    for (let i = 0; i < 10; i++) aborted.step()
    expect(aborted.at(0.5)).toBeGreaterThan(aborted.at(0.95) + 0.5)
    expect(ended('error').flash).toBeGreaterThan(0.5)
    expect(ended('refusal').flash).toBeGreaterThan(0.5)
  })
})

describe('cells', () => {
  test('the base64 written by hand, for a runtime without its own, is the standard one', () => {
    for (let n = 0; n <= 6; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255)
      expect(encodeBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
    }
    const every = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(encodeBase64(every)).toBe(btoa(String.fromCharCode(...every)))
  })
})

describe('a turn, through the plugin', () => {
  const braille = /[⠁-⣿]/

  test('the prompt sweeps up, thinking draws the brainwave until the text comes, and the answer crashes a cymbal', async ($, on) => {
    let speak = () => {}
    on('turn.step', async function* ($, e) {
      yield { kind: 'thinking' as const, index: 0, text: 'Let me see.' }
      await new Promise<void>(resolve => (speak = resolve))
      yield { kind: 'text' as const, index: 1, text: 'Here it is.' }

      return { turnId: e.turnId, index: e.index, answer: 'Here it is.', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    const { clock, ui, label, cells } = await staged($, on)

    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    await clock.advance(150)
    const [left, , right] = thirds(cells())
    expect(left).toBeGreaterThan(right!)

    const reading = (async () => {
      for await (const _ of $.turn.step({ turnId: 'u1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      }
    })()
    await clock.advance(600)
    expect(label()).toContain('thinking')
    expect(text(cells(), 80).join('')).toMatch(braille)
    speak()
    await reading
    await clock.advance(3000)
    expect(label()).not.toContain('thinking')
    expect(text(cells(), 80).join('')).not.toMatch(braille)

    await $.turn.complete({ reason: 'answer', answer: 'Here it is.', durationMs: 1000, isAborted: false, turnId: 'u1' })
    await clock.advance(100)
    const [low, , high] = thirds(cells())
    expect(high).toBeGreaterThan(low!)
    await ui.unmount()
  })

  test('a stream cut off while thinking stops the thinking', async ($, on) => {
    on('turn.step', async function* () {
      yield { kind: 'thinking' as const, index: 0, text: 'Let me' }
      throw new Error('connection lost')
    })
    const { clock, ui, label, cells } = await staged($, on)
    await (async () => {
      try {
        for await (const _ of $.turn.step({ turnId: 'u1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
        }
      } catch {}
    })()
    await clock.advance(3000)
    expect(label()).not.toContain('thinking')
    expect(text(cells(), 80).join('')).not.toMatch(braille)
    await ui.unmount()
  })

  test('an interrupted turn sweeps back down; one that errs flashes red', async ($, on) => {
    const { clock, ui, cells } = await staged($, on)
    const end = (reason: 'aborted' | 'error') =>
      $.turn.complete({ reason, answer: '', durationMs: 1000, isAborted: reason === 'aborted', turnId: 'u1' })
    await clock.advance(200)
    const calm = redness(cells())

    await end('aborted')
    await clock.advance(100)
    const [left, , right] = thirds(cells())
    expect(right).toBeGreaterThan(left!)
    expect(redness(cells())).toBeLessThan(calm + 15)
    await clock.advance(3000)

    // Red even on bars that have fallen: the floor flashes too.
    await end('error')
    await clock.advance(100)
    expect(redness(cells())).toBeGreaterThan(calm + 40)
    await ui.unmount()
  })
})
