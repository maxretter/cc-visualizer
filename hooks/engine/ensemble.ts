// The subagents at work, each a voice playing on a spectrum of its own.

import { FRAME_MS } from './math'
import { Spectrum } from './spectrum'

/** What is known of a subagent from its spawn: the name it was given, its task in a few words, its type. */
export type VoiceInfo = { name?: string; description?: string; type?: string }

/** A subagent at work: its own music on a spectrum of its own, its name and color, and how its loop ended. */
export type Voice = {
  id: string
  name: string
  color: number
  spectrum: Spectrum
  /** How its loop ended, and when, on its own clock; none while it works. */
  outcome?: 'done' | 'failed' | 'stopped'
  endedAt?: number
}

/** The subagents' colors, in the order they join: apart from each other, and from the amber of a wait and the red of an error. */
const VOICE_COLORS = [0x60a5fa, 0xfb923c, 0xa3e635, 0xe879f9, 0x22d3ee, 0xfb7185, 0x818cf8, 0x34d399]
/** How long a finished subagent's channel stays, saying how it went, before it closes. */
const VOICE_LINGER = 3_000
/** The main loop's color, where it is named as a voice: over its bars narrowed for a subagent in focus, and in the trail. */
const MAIN_COLOR = 0xe5e7eb

/** The main loop as a voice, named `main`, labeled as a channel is while a subagent is in focus. */
export const mainVoice = (spectrum: Spectrum): Voice => ({ id: '', name: 'main', color: MAIN_COLOR, spectrum })

/** A subagent's name as drawn: the one it was given, else its task, else its type; printable, on one line. */
export const voiceNameOf = (info: VoiceInfo): string =>
  (info.name || info.description || info.type || 'agent').replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim() || 'agent'

/**
 * The subagents at work, each a voice: its events play on its own spectrum,
 * drawn in a channel of its own beside the main loop's. A voice ends with its
 * loop, says how it went for a while, and leaves.
 */
export class Ensemble {
  /** The voices at work or saying how it went, in the order they joined. */
  readonly voices: Voice[] = []
  /** Every subagent heard of: one that works again after it ended (a teammate woken, an agent resumed) plays again. */
  private readonly known = new Map<string, VoiceInfo>()
  /** How many have joined: the next one's color. */
  private joined = 0

  /** A subagent heard of, not at work: it plays if it works again. */
  know(id: string, info: VoiceInfo) {
    this.known.set(id, info)
  }

  /** A subagent starts: its voice. One still on stage keeps its own, at work again. */
  join(id: string, info: VoiceInfo): Voice {
    this.known.set(id, info)
    const had = this.find(id)
    if (had !== undefined) {
      had.outcome = undefined
      had.endedAt = undefined
      return had
    }
    const color = VOICE_COLORS[this.joined++ % VOICE_COLORS.length]!
    const voice = { id, name: voiceNameOf(info), color, spectrum: new Spectrum() }
    this.voices.push(voice)
    return voice
  }

  /** The voice of subagent `id` on stage, at work or fading. */
  find(id: string | undefined): Voice | undefined {
    return id === undefined ? undefined : this.voices.find(voice => voice.id === id)
  }

  /**
   * The voice an event of loop `id` plays on: its own, at work again if it had
   * ended; none for the main loop, or a loop never heard of (the engine's own forks).
   */
  voiceOf(id: string | undefined): Voice | undefined {
    if (id === undefined) return undefined
    const voice = this.find(id)
    if (voice !== undefined && voice.outcome === undefined) return voice
    const info = this.known.get(id)
    return info === undefined ? undefined : this.join(id, info)
  }

  /**
   * Subagent `id`'s loop ended, for `reason`: its channel plays the end, says
   * how it went, and fades. False for a loop never heard of, which is not a voice's.
   */
  end(id: string, reason: string): boolean {
    if (!this.known.has(id)) return false
    const voice = this.find(id)
    if (voice === undefined || voice.outcome !== undefined) return true
    voice.spectrum.ended(reason)
    voice.outcome = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
    voice.endedAt = voice.spectrum.now
    return true
  }

  /** Moves every voice on by `elapsed`; one that has said how it went long enough leaves. */
  step(elapsed = FRAME_MS) {
    for (const voice of this.voices) voice.spectrum.step(elapsed)
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const { endedAt, spectrum } = this.voices[i]!
      if (endedAt !== undefined && spectrum.now - endedAt >= VOICE_LINGER) this.voices.splice(i, 1)
    }
  }

  /** No subagent at work or saying how it went. */
  isCalm(): boolean {
    return this.voices.length === 0
  }
}
