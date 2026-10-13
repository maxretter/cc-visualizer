// The names the drawings show, and their colors: what is going on (a wait, a
// compaction, the idle), the thinking, each tool call, the context's fill, and
// each subagent with what it is doing.

import type { VizTheme } from '../../types'
import { cycle } from './math'
import { INDEX, SOURCES } from './sources'
import type { SourceId } from './sources'
import { AMBER_AT, CUE, ERROR, GROUND, LEGEND_GRAY, legible, mix, paletteOf, RED_AT } from './color'
import type { Tone } from './color'
import { SPIN, SPINNER, write } from './cells'
import type { Call, Spectrum } from './spectrum'
import type { Voice } from './ensemble'

/** A tool's name in the color of the theme, as strong as the call's name shows, faded into the background. */
export function nameColor(theme: VizTheme, source: SourceId, strength: number, tone: Tone): number {
  const color = theme === 'instrument' ? legible(SOURCES[INDEX[source]]!.color, tone) : paletteOf(theme, tone).peak(0)
  return mix(GROUND[tone], color, strength)
}

const label = (call: Call) => (call.count > 1 ? `${call.name}\u00d7${call.count}` : call.name)

/** A name the trail or the labels draw: a tool call, the thinking, a wait, a compaction, or the idle. */
export type Named = { text: string; source: SourceId; strength: number; isRunning: boolean; color?: number }

/** How long Claude has been idle, as its label says it: `idle`, `idle 4m`, `idle 1h 5m`. */
export function idleText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'idle'
  if (minutes < 60) return `idle ${minutes}m`
  return `idle ${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A stretch of time as a clock reads it: `0:42`, `12:05`, `1:02:03`. */
export function clockText(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const s = String(seconds % 60).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}:${s}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
}

/** While the person is waited on: how long, in amber, pulsing with the metronome. */
const waitingName = (spectrum: Spectrum): Named | undefined => {
  const waited = spectrum.waitedFor()
  return waited !== undefined && spectrum.cue > 0.05
    ? {
        text: `waiting on you \u00b7 ${clockText(waited)}`,
        source: 'think',
        strength: spectrum.cue * (0.65 + 0.35 * spectrum.tick()),
        isRunning: false,
        color: CUE,
      }
    : undefined
}

/** While the conversation is compacted. */
const compactingName = (spectrum: Spectrum): Named | undefined =>
  spectrum.isRewinding()
    ? { text: 'compacting', source: 'think', strength: 0.8 + 0.2 * Math.sin(cycle(spectrum.now, 2_070)), isRunning: true, color: LEGEND_GRAY }
    : undefined

/** The context's fill as its label says it, colored as the meter is at its top. */
export const contextName = (spectrum: Spectrum): Named | undefined =>
  spectrum.contextPercent === undefined
    ? undefined
    : {
        text: `context ${Math.round(spectrum.contextPercent)}%`,
        source: 'think',
        strength: 0.85,
        isRunning: false,
        color: spectrum.gauge >= RED_AT ? ERROR : spectrum.gauge >= AMBER_AT ? CUE : LEGEND_GRAY,
      }

/** The label at the left: waiting on the person, else compacting, else idle. */
export const statusName = (spectrum: Spectrum): Named | undefined =>
  waitingName(spectrum) ?? compactingName(spectrum) ?? idleName(spectrum)

/** While the idle show plays: its label, gray, breathing slowly. */
const idleName = (spectrum: Spectrum): Named | undefined =>
  spectrum.idle > 0.05
    ? {
        text: idleText(spectrum.quietFor),
        source: 'think',
        strength: spectrum.idle * (0.7 + 0.2 * Math.sin(cycle(spectrum.now, 5_180))),
        isRunning: false,
        color: LEGEND_GRAY,
      }
    : undefined

export const nameColorOf = (theme: VizTheme, name: Named, strength: number, tone: Tone) =>
  name.color === undefined
    ? nameColor(theme, name.source, strength, tone)
    : mix(GROUND[tone], legible(name.color, tone), strength)

export const thinkingName = (spectrum: Spectrum): Named | undefined =>
  spectrum.mind > 0.05 ? { text: 'thinking', source: 'think', strength: spectrum.mind, isRunning: spectrum.thinking > 0 } : undefined

export const callName = (spectrum: Spectrum, call: Call): Named => ({
  text: label(call),
  source: call.source,
  strength: spectrum.strength(call),
  isRunning: spectrum.isRunning(call),
})

/**
 * What a subagent is doing, as its label says it: waiting on the person, a
 * call running, thinking, how it ended, else its last call while the name lingers.
 */
function doing(voice: Voice): Named | undefined {
  const { spectrum } = voice
  if (spectrum.waitedFor() !== undefined) {
    return { text: 'waiting', source: 'think', strength: 0.65 + 0.35 * spectrum.tick(), isRunning: false, color: CUE }
  }
  const ended = outcomeName(voice)
  if (ended !== undefined) return ended
  for (let i = spectrum.calls.length - 1; i >= 0; i--) {
    const call = spectrum.calls[i]!
    if (spectrum.isRunning(call)) return callName(spectrum, call)
  }
  const last = spectrum.calls.at(-1)
  return thinkingName(spectrum) ?? (last === undefined ? undefined : callName(spectrum, last))
}

/** How a subagent's loop ended, as its label says it: red when it failed; none while it works. */
const outcomeName = (voice: Voice): Named | undefined =>
  voice.outcome === undefined
    ? undefined
    : { text: voice.outcome, source: 'think', strength: 0.85, isRunning: false, color: voice.outcome === 'failed' ? ERROR : LEGEND_GRAY }

/** A subagent on wide bars, as the names leading their labels say it: its name in its color, and how it ended once it has. */
export const focusLead = (voice: Voice): Named[] => {
  const ended = outcomeName(voice)
  const name: Named = { text: voice.name, source: 'agent', strength: 1, isRunning: false, color: voice.color }
  return ended === undefined ? [name] : [name, ended]
}

/** `text` cut to `width`, at the end of a word where one fits: a task's first words, not a word cut off. */
export const fit = (text: string, width: number): string => {
  if (text.length <= width) return text
  const cut = text.lastIndexOf(' ', width)
  return cut > 0 ? text.slice(0, cut) : text.slice(0, width)
}

/** A subagent in the trail beside a mini spectrum: its name and what it is doing, in its color, amber while it waits. */
export const voiceName = (voice: Voice): Named => {
  const act = doing(voice)
  return {
    text: act === undefined ? fit(voice.name, 16) : `${fit(voice.name, 12)} ${act.text}`,
    source: 'agent',
    strength: voice.outcome === undefined ? 1 : 0.9,
    isRunning: act?.isRunning ?? false,
    color: act?.color === CUE ? CUE : voice.color,
  }
}

/**
 * A subagent's label over its channel, `width` wide from `start`: its name in
 * its color, then what it is doing, a spinner before a call that runs; all of
 * it as far faded in as the channel is `shown`.
 */
export function voiceLabel(words: Uint32Array, columns: number, start: number, width: number, voice: Voice, shown: number, theme: VizTheme, tone: Tone) {
  const act = doing(voice)
  const spin = act?.isRunning === true ? 2 : 0
  const room = act === undefined ? width : Math.max(4, width - act.text.length - spin - 1)
  const name = fit(voice.name, Math.min(room, width))
  write(words, columns, 0, start, name, mix(GROUND[tone], legible(voice.color, tone), shown))
  if (act === undefined) return
  let at = start + name.length + 1
  const left = start + width - at - spin
  if (left < 3) return
  if (spin > 0) {
    const cell = at * 3
    words[cell] = SPINNER[Math.floor(voice.spectrum.now / SPIN) % SPINNER.length]!
    words[cell + 1] = nameColorOf(theme, act, shown, tone)
    at += spin
  }
  write(words, columns, 0, at, act.text.slice(0, left), nameColorOf(theme, act, act.strength * shown, tone))
}
