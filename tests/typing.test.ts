import type { PromptEditInput, PromptEditResult } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { FRAME_MS } from '../hooks/engine/math'
import { placeOf } from '../hooks/engine/sources'
import { IDLE_DELAY, Spectrum } from '../hooks/engine/spectrum'
import { band, staged } from './support'

describe('typing', () => {
  /** Plays `ms` of music, a frame at a time. */
  const play = (spectrum: Spectrum, ms: number) => {
    for (let t = 0; t < ms; t += FRAME_MS) spectrum.step()
  }

  test('a key plays where it sits on the keyboard: the left hand low, the right high', () => {
    expect(placeOf('a')).toBeLessThan(0.2)
    expect(placeOf('l')).toBeGreaterThan(0.8)
    expect(placeOf('A')).toBe(placeOf('a'))
    const left = new Spectrum()
    left.typed('a')
    left.step()
    const right = new Spectrum()
    right.typed('l')
    right.step()
    expect(left.at(placeOf('a'))).toBeGreaterThan(left.at(placeOf('l')) + 0.4)
    expect(right.at(placeOf('l'))).toBeGreaterThan(right.at(placeOf('a')) + 0.4)
  })

  test('a paste plays as a run, a key at a time, and the notes fade', () => {
    const spectrum = new Spectrum()
    spectrum.typed('qwertyuiop')
    spectrum.step()
    // The run has begun at the left; the right hand is still to come.
    expect(spectrum.at(placeOf('q'))).toBeGreaterThan(0.4)
    expect(spectrum.at(placeOf('p'))).toBeLessThan(0.1)
    play(spectrum, 250)
    expect(spectrum.at(placeOf('p'))).toBeGreaterThan(0.4)
    expect(spectrum.isCalm()).toBe(false)
    play(spectrum, 1500)
    expect(spectrum.isCalm()).toBe(true)
  })

  test('a long paste plays 32 of its characters, spread over it as they are, a pair of surrogates one', () => {
    const paste = Array.from({ length: 100_000 }, (_, i) => (i % 7 === 3 ? '\u{1F600}' : String.fromCharCode(33 + (i % 90)))).join('')
    for (const text of [paste, paste.replace(/\u{1F600}/gu, 'é'), 'a\u{1F600}B']) {
      for (const isErased of [false, true]) {
        // The run as the text spread out into its characters plays it: the one
        // each note takes, put where a run as long as itself plays it.
        const chars = [...text]
        const count = Math.min(chars.length, 32)
        const run: string[] = []
        for (let n = 0; n < count; n++) {
          const i = Math.floor((n * chars.length) / count)
          run[isErased ? count - 1 - n : n] = chars[isErased ? chars.length - 1 - i : i]!
        }
        const played = new Spectrum()
        played.typed(text, isErased)
        const expected = new Spectrum()
        expected.typed(run.join(''), isErased)
        for (let t = 0; t < 1000; t += FRAME_MS) {
          played.step()
          expected.step()
          for (let x = 0; x <= 1; x += 0.01) expect(played.at(x)).toBe(expected.at(x))
        }
      }
    }
  })

  test('typing holds off the idle show, which waits for a quiet spell to come back', () => {
    const spectrum = new Spectrum()
    spectrum.ambient = true
    play(spectrum, IDLE_DELAY - 1000)
    expect(spectrum.idle).toBe(0)
    play(spectrum, 6000)
    expect(spectrum.idle).toBeGreaterThan(0.95)

    spectrum.typed('hello')
    play(spectrum, 700)
    expect(spectrum.idle).toBeLessThan(0.05)
    // A pause to think is not idle.
    play(spectrum, 5000)
    expect(spectrum.idle).toBe(0)
    play(spectrum, IDLE_DELAY)
    expect(spectrum.idle).toBeGreaterThan(0.5)
  })

  test('the keys play on a band that is up, and never raise one', async ($, on) => {
    const { clock, ui, blits } = await staged($, on, { mode: 'auto' })
    // The test engine raises prompt.edit as the composer does, though its
    // typings (a plugin's own calls) leave it out.
    const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }
    const edit = (inputText: string) => prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText })
    try {
      // Claude works: the band is up, and the keys play on it.
      await clock.advance(3000)
      const before = blits()
      await edit('hi')
      await clock.advance(200)
      expect(blits()).toBeGreaterThan(before)

      // Claude is done and the band has gone: typing does not bring it back.
      await ui.redraw(band(false).props)
      await clock.advance(5000)
      const after = blits()
      await edit('there')
      await clock.advance(1000)
      expect(blits()).toBe(after)
    } finally {
      await ui.unmount()
    }
  })
})

describe('edits to the prompt', () => {
  test('play what went in, else, quieter, what went out, else a faint tick where the caret went', () => {
    const edit = (text: string, start: number, end: number, inputText: string) => {
      const spectrum = new Spectrum()
      spectrum.edited(text, start, end, inputText)
      spectrum.step()
      return spectrum
    }
    const typed = edit('', 0, 0, 'p')
    const erased = edit('p', 0, 1, '')
    expect(typed.at(placeOf('p'))).toBeGreaterThan(erased.at(placeOf('p')) + 0.2)
    expect(erased.at(placeOf('p'))).toBeGreaterThan(0.2)
    // The caret to the end of the text: a tick at the right, none at the left.
    const moved = edit('abcd', 4, 4, '')
    expect(moved.at(0.94)).toBeGreaterThan(0.15)
    expect(moved.at(0.1)).toBeLessThan(0.05)
  })
})
