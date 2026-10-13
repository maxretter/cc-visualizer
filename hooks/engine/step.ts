// A model request as it streams, played on a spectrum a chunk at a time.

import { sourceOf } from './sources'
import type { Spectrum } from './spectrum'

/**
 * A piece of a model's response as it streams, as much of it as the music
 * needs, by its kind: text, thinking, a tool call's start and its arguments,
 * and the rest (the stop, the engine's own), which play nothing.
 */
export type Chunk = { kind: 'text' | 'thinking'; text?: string } | { kind: 'tool'; name?: string } | { kind: 'input'; json?: string } | { kind: 'stop' | 'engine' }

/**
 * One model request as it streams. It thinks from the request until its
 * first text or tool call, and again whenever it thinks anew: the sub-bass
 * and the brainwave. Its text is the bass, a tool call it writes a hit on
 * that tool's band, the call's arguments hats. A subagent's plays softer.
 */
export class Step {
  private isThinking = true
  private readonly gain: number

  constructor(
    private readonly spectrum: Spectrum,
    isSubagent = false,
  ) {
    this.gain = isSubagent ? 0.6 : 1
    spectrum.beginThinking()
  }

  /** A chunk of the response came in. */
  hear(chunk: Chunk) {
    const { spectrum, gain } = this
    const isThought = chunk.kind === 'thinking'
    if (isThought !== this.isThinking && (isThought || chunk.kind === 'text' || chunk.kind === 'tool')) {
      this.isThinking = isThought
      if (isThought) spectrum.beginThinking()
      else spectrum.endThinking()
    }
    if (chunk.kind === 'text') spectrum.stream('text', chunk.text?.length ?? 0, gain)
    else if (chunk.kind === 'thinking') spectrum.stream('think', chunk.text?.length ?? 0, gain)
    else if (chunk.kind === 'tool') spectrum.hit(sourceOf(chunk.name ?? ''), 0.8 * gain)
    else if (chunk.kind === 'input') spectrum.stream('args', chunk.json?.length ?? 0, gain)
  }

  /** The stream is over, however it ended: the thinking stops with it. */
  end() {
    if (this.isThinking) this.spectrum.endThinking()
    this.isThinking = false
  }
}
