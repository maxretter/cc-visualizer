// `/viz demo`: a few seconds of thinking and drums played on a spectrum
// without a turn, two subagents joining it in channels of their own.

import { cycle, FRAME_MS } from './math'
import type { Call, Spectrum } from './spectrum'
import type { Ensemble, Voice } from './ensemble'

const DEMO_TOOLS = ['Grep', 'Read', 'Read', 'Edit', 'Bash', 'WebFetch', 'Agent', 'Write']

/** How long the demo plays, and how long it thinks before the drums come in. */
export const DEMO = 11_400
const DEMO_THINK = 2_500
/** The demo's drum machine: a sixteenth note (113 bpm), and how long each tool it calls runs. */
const SIXTEENTH = 132
const DEMO_CALL = 230

/**
 * One of the demo's subagents, on the drums' clock: when it joins and ends,
 * and the calls it makes between, each when, to which tool, and for how long.
 * It thinks until its first call, and writes its answer before it ends.
 */
type DemoAgent = { name: string; joins: number; ends: number; calls: readonly (readonly [at: number, tool: string, ms: number])[] }

/** The demo's subagents: one looking around, one running the tests; each done, and its channel closed, before the demo ends. */
const DEMO_AGENTS: readonly DemoAgent[] = [
  {
    name: 'scout',
    joins: 300,
    ends: 4_400,
    calls: [
      [900, 'Grep', 350],
      [1_400, 'Read', 300],
      [1_850, 'Read', 250],
      [2_300, 'Glob', 300],
      [2_850, 'Read', 400],
      [3_400, 'Grep', 300],
    ],
  },
  {
    name: 'tests',
    joins: 1_300,
    ends: 5_400,
    calls: [
      [1_900, 'Read', 300],
      [2_400, 'Edit', 400],
      [3_000, 'Bash', 900],
      [4_100, 'Edit', 350],
      [4_550, 'Bash', 300],
    ],
  },
]
/** How long a demo subagent's answer streams before it ends. */
const DEMO_ANSWER = 500
/**
 * When the demo opens its subagents' transcripts, on the drums' clock, as the
 * person would from the tasks list: each in turn, once both channels are open,
 * its channel growing into the band; then the main conversation's again,
 * before either is done.
 */
const DEMO_VIEWS: readonly (readonly [at: number, agent: string | undefined])[] = [
  [2_100, 'scout'],
  [3_200, 'tests'],
  [4_700, undefined],
]

/** A demo subagent as it plays: its voice once it has joined, its next call, the calls still running, and whether it thinks or is done. */
type DemoPart = { agent: DemoAgent; voice?: Voice; next: number; running: { call: Call; endAt: number }[]; isThinking: boolean; isDone: boolean }

/**
 * The demo, played on a spectrum without a turn: a spell of thinking, then a
 * drum machine of tool calls; with an ensemble, two subagents join it, each in
 * a channel of its own, and their transcripts are opened in turn. It plays
 * its part at each of the spectrum's steps it is handed to, and draws on the
 * spectrum's chances.
 */
export class Demo {
  /** How long it has left, how long it is, and the next sixteenth its drums play. */
  private left = 0
  private length = 0
  private next = 0
  private isThinking = false
  private call: { call: Call; endAt: number } | undefined
  /** Its subagents, and how far along each is. */
  private parts: DemoPart[] = []
  /**
   * The subagent whose transcript it has opened, by its voice's id, which the
   * drawings put in focus as they do the one the person opens; none for the
   * main conversation's. And the next of its views.
   */
  view: string | undefined
  private views = 0

  /** `spectrum`: what it plays on; `ensemble`: what its subagents join, and without one, it plays without them. */
  constructor(
    private readonly spectrum: Spectrum,
    private readonly ensemble?: Ensemble,
  ) {}

  /** Whether it is playing. */
  get isPlaying(): boolean {
    return this.left > 0
  }

  /** Plays it from the start, `ms` long, sweeping up the spectrum as a prompt sent does; with an ensemble, its subagents join it. */
  play(ms = DEMO) {
    // A demo played again over one still playing: its drum call and its
    // subagents end first, as that call's end is on the old demo's clock.
    if (this.call !== undefined) this.spectrum.endCall(this.call.call)
    this.call = undefined
    this.finishParts()
    this.left = ms
    this.length = ms
    this.next = 0
    this.parts = this.ensemble === undefined ? [] : DEMO_AGENTS.map(agent => ({ agent, next: 0, running: [], isThinking: false, isDone: false }))
    this.view = undefined
    this.views = 0
    this.spectrum.kick()
  }

  /**
   * The demo, `ms` on: a spell of thinking, then the drum machine: kick, snare,
   * hats, a melody, fills. Streams come in as a rate, so as much over `ms` as a
   * frame's worth for each frame it spans.
   */
  step(ms: number) {
    const { spectrum } = this
    this.left = Math.max(0, this.left - ms)
    const elapsed = this.length - this.left
    const frames = ms / FRAME_MS
    if (elapsed < DEMO_THINK && this.left > 0) {
      if (!this.isThinking) {
        this.isThinking = true
        spectrum.beginThinking()
      }
      spectrum.stream('think', 12 * spectrum.rand() * frames)
      return
    }
    if (this.isThinking) {
      this.isThinking = false
      spectrum.endThinking()
    }
    const drums = elapsed - DEMO_THINK
    // The melody plays through the first ten sixteenths of each bar.
    if (drums >= 0 && drums % (16 * SIXTEENTH) < 10 * SIXTEENTH) spectrum.stream('text', (6 + 6 * Math.sin(cycle(drums, 690))) * frames)
    if (this.call !== undefined && (elapsed >= this.call.endAt || this.left === 0)) {
      spectrum.endCall(this.call.call)
      this.call = undefined
    }
    // Each sixteenth the step reached: hats on every one, the kick on the beat,
    // the snare halfway through it, and a tool between.
    for (; this.next * SIXTEENTH <= drums; this.next++) {
      const n = this.next
      spectrum.hit('args', 0.21)
      if (n % 4 === 0) spectrum.hit('think')
      if (n % 4 === 2) spectrum.hit('bash', 0.8)
      if (n % 2 === 1 && this.call === undefined && this.left > 2 * SIXTEENTH) {
        const call = spectrum.startCall(DEMO_TOOLS[Math.floor(n / 2) % DEMO_TOOLS.length]!)
        this.call = { call, endAt: elapsed + DEMO_CALL }
      }
    }
    for (const part of this.parts) this.playPart(part, drums, frames)
    // Each view the step reached: a subagent's transcript opened, or the main conversation's again.
    for (; this.views < DEMO_VIEWS.length && DEMO_VIEWS[this.views]![0] <= drums; this.views++) {
      const name = DEMO_VIEWS[this.views]![1]
      this.view = this.parts.find(part => part.agent.name === name)?.voice?.id
    }
    if (this.left === 0) {
      this.finishParts()
      this.view = undefined
      spectrum.cymbal()
    }
  }

  /**
   * A demo subagent, `drums` into the drums: it joins, thinks, makes its calls
   * (each its arguments written, then a held note), writes its answer, and ends.
   */
  private playPart(part: DemoPart, drums: number, frames: number) {
    const { agent } = part
    if (part.isDone || this.ensemble === undefined) return
    if (part.voice === undefined) {
      if (drums < agent.joins) return
      part.voice = this.ensemble.join(`demo:${agent.name}`, { name: agent.name })
      part.voice.spectrum.beginThinking()
      part.isThinking = true
    }
    const { spectrum } = part.voice
    for (let i = part.running.length - 1; i >= 0; i--) {
      if (drums < part.running[i]!.endAt) continue
      spectrum.endCall(part.running[i]!.call)
      part.running.splice(i, 1)
    }
    if (part.isThinking) spectrum.stream('think', 10 * this.spectrum.rand() * frames)
    for (; part.next < agent.calls.length && agent.calls[part.next]![0] <= drums; part.next++) {
      const [, tool, ms] = agent.calls[part.next]!
      if (part.isThinking) {
        part.isThinking = false
        spectrum.endThinking()
      }
      spectrum.stream('args', 30)
      part.running.push({ call: spectrum.startCall(tool), endAt: drums + ms })
    }
    if (drums >= agent.ends - DEMO_ANSWER && part.running.length === 0) spectrum.stream('text', (5 + 4 * this.spectrum.rand()) * frames)
    if (drums >= agent.ends) this.finishPart(part)
  }

  /** A demo subagent ends: its calls return, and it answers. */
  private finishPart(part: DemoPart) {
    if (part.voice === undefined || part.isDone) return
    for (const { call } of part.running) part.voice.spectrum.endCall(call)
    part.running.length = 0
    if (part.isThinking) part.voice.spectrum.endThinking()
    part.isThinking = false
    this.ensemble?.end(part.voice.id, 'answer')
    part.isDone = true
  }

  /** Every demo subagent still at work ends: the demo is over, or plays again. */
  private finishParts() {
    for (const part of this.parts) this.finishPart(part)
  }
}
