// The hooks that play the music as Claude works: the person's keys and
// prompts, the response as it streams, tool calls and the asks they put to
// the person, failures, the ends of turns, and subagents starting and
// stopping. Each plays on the stage's spectrum, or a subagent's own, and wakes
// the frames. None reaches for `$`: they watch, and pass each event on as it came.

import type { On } from 'claude-code'

import type { VoiceInfo } from './engine/ensemble'
import { sourceOf } from './engine/sources'
import type { SourceId } from './engine/sources'
import type { Ask, Call, Spectrum } from './engine/spectrum'
import { Step } from './engine/step'
import type { Stage } from './stage'
import { argumentsOf, isKeyed, requestFor } from './viz'
import type { Check } from './viz'

/** Tools whose whole call waits on the person: a question, a plan to approve. */
const PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** A call running, the spectrum it plays on (the main loop's, or its subagent's own), and the loop it runs in. */
type Running = { call: Call; owner: Spectrum; agentId?: string }

/**
 * A spawn not yet answered: what its subagent was given, the type its start
 * names it by (a teammate's is its name), and the loop whose start took it.
 */
type Spawning = { info: VoiceInfo; type?: string; agentId?: string }

export function music(on: On, stage: Stage) {
  const { spectrum, ensemble, sites } = stage
  // Tool calls by their id while they run, the ones that may yet be put to the
  // person, and the ones put to the person until answered, on each spectrum
  // the ask plays on.
  const calls = new Map<string, Running>()
  const checks = new Map<string, Check>()
  const asks = new Map<string, [Spectrum, Ask][]>()
  // The main loop's model requests while they stream.
  const steps = new Set<Step>()
  // Spawns not yet answered, and the loops never heard of that ended
  // meanwhile: one may be a spawn's, its end come before its answer.
  const spawning = new Set<Spawning>()
  const early = new Set<string>()

  // A call decided, its ask answered; `answer` wakes the frames too, which a
  // drawing may not do (it writes state), so a drawing settles it and the frames notice.
  const settle = (id: string): boolean => {
    checks.delete(id)
    const asked = asks.get(id)
    if (asked === undefined) return false
    asks.delete(id)
    for (const [owner, ask] of asked) owner.answer(ask)
    return true
  }
  // A call put to the person: the vamp on the main spectrum, which the whole
  // band hears, and a subagent's on its own channel too.
  const ask = (owner: Spectrum, source: SourceId, call: Call | undefined, grace?: number): [Spectrum, Ask][] =>
    owner === spectrum
      ? [[spectrum, spectrum.ask(source, call, grace)]]
      : [
          [spectrum, spectrum.ask(source, undefined, grace)],
          [owner, owner.ask(source, call, grace)],
        ]
  const answer = (id: string) => {
    if (!settle(id)) return
    // The dialog that asked is gone: try the drawings it covered at once.
    for (const site of sites.values()) if (site.retryAt !== undefined) site.retryAt = 0
    stage.wake()
  }
  // A call returns: its ask is answered and its held note ends, unless the end
  // of the main loop's turn has taken them already.
  const end = (id: string | undefined, running: Running) => {
    if (id !== undefined) {
      if (calls.get(id) !== running) return
      calls.delete(id)
      answer(id)
    }
    running.owner.endCall(running.call)
  }
  // A loop never heard of ended: if a spawn waits for its answer, the loop may be its.
  const endedEarly = (id: string) => {
    if (spawning.size > 0) early.add(id)
  }

  // The person types: the keys play on a drawing that is up anyway.
  on('prompt.edit', (_, e, next) => {
    if (isKeyed(stage.prefs.mode, { ...stage.drawn(), isWorking: stage.isWorking })) {
      spectrum.edited(e.text, e.start, e.end, e.inputText)
      stage.wake()
    }

    return next(e)
  })

  // A prompt sent: a sweep up the spectrum.
  on('prompt.submit', (_, e, next) => {
    spectrum.kick()
    stage.wake()

    return next(e)
  }).catch((_, e, next) => next(e))

  // The model's response as it streams, played a chunk at a time: a
  // subagent's on its own voice, one never heard of softer on the main spectrum.
  on('turn.step', async function* (_, e, next) {
    const voice = ensemble.voiceOf(e.agentId)
    const step = voice !== undefined ? new Step(voice.spectrum) : new Step(spectrum, e.agentId !== undefined)
    if (e.agentId === undefined) steps.add(step)
    stage.wake()
    try {
      for await (const chunk of next(e)) {
        step.hear(chunk)
        // The frames may have stopped in a lull mid-stream.
        stage.wake()
        yield chunk
      }
    } finally {
      step.end()
      steps.delete(step)
    }
  })

  // A tool runs: a hit, its name, a held note until it returns; a subagent's in its own channel.
  on('tool.call', async (_, e, next) => {
    const owner = ensemble.voiceOf(e.agentId)?.spectrum ?? spectrum
    const running: Running = { call: owner.startCall(String(e.tool)), owner, agentId: e.agentId }
    const id = e.tool_use_id
    if (id !== undefined) {
      calls.set(id, running)
      if (PERSON.has(String(e.tool))) asks.set(id, ask(owner, running.call.source, running.call, 0))
      // Its arguments as they came: a permission request keys them only to tell it from another call.
      else checks.set(id, { tool: e.tool, agentId: e.agentId, input: argumentsOf(e) })
    }
    stage.wake()
    try {
      return await next(e)
    } finally {
      end(id, running)
    }
  }).catch((_, e, next) => next(e))

  // A tool that ran and failed flashes red. A call refused (at the dialog, by a
  // rule or by auto mode) or cut by an interrupt never ran: core marks it an
  // error too, but this is not raised for it.
  on('classic.PostToolUseFailure', (_, e, next) => {
    if (e.is_interrupt !== true) {
      const owner = ensemble.find(e.agent_id)?.spectrum ?? spectrum
      owner.error()
      stage.wake()
    }

    return next(e)
  })

  // The person is asked to allow a call: unless an answer comes within the grace,
  // its held note rests and the vamp plays until it is answered. Only asks that
  // reach the person raise this, not the ones auto mode's classifier settles. A
  // settings hook beneath may answer it, and its answer is not read here: a call
  // it refuses ends at once, one it lets run vamps if it runs past the grace.
  // It watches, and passes the request on unchanged.
  on('classic.PermissionRequest', (_, e, next) => {
    const id = requestFor(checks, e.tool_name, e.agent_id, e.tool_input)
    if (id !== undefined) {
      checks.delete(id)
      const running = calls.get(id)
      asks.set(id, ask(running?.owner ?? spectrum, running?.call.source ?? sourceOf(e.tool_name), running?.call))
      stage.wake()
    }

    return next(e)
  })

  // The run-in-background pill shows under a call once it runs: the ask was answered.
  on('ui.render', { component: 'ToolProgress', props: { kind: 'background_hint' } }, (_, e, next) => {
    settle(e.props.tool_use_id)

    return next(e)
  })

  // The turn ends: a cymbal, a sweep down when interrupted, red on an error. A
  // subagent's ends in its own channel, which says how it went and fades. The
  // main loop's takes what is left of it with it, never a subagent's: a call
  // whose return never came, its ask, its thinking.
  on('turn.complete', (_, e, next) => {
    if (e.agentId === undefined) {
      for (const [id, running] of calls) if (running.agentId === undefined) end(id, running)
      for (const step of steps) step.end()
      steps.clear()
      spectrum.ended(e.reason)
    } else if (!ensemble.end(e.agentId, e.reason)) {
      spectrum.ended(e.reason, true)
      endedEarly(e.agentId)
    }
    stage.wake()

    return next(e)
  })

  // A subagent's loop starts: its channel opens now, for the spawn of its type
  // still unanswered, so that its first steps play there; one heard of before
  // plays again. It watches, and passes the start on unchanged.
  on('classic.SubagentStart', (_, e, next) => {
    let voice = ensemble.voiceOf(e.agent_id)
    const spawn = voice === undefined ? [...spawning].find(spawn => spawn.agentId === undefined && spawn.type === e.agent_type) : undefined
    if (spawn !== undefined) {
      spawn.agentId = e.agent_id
      voice = ensemble.join(e.agent_id, spawn.info)
    }
    if (voice !== undefined) stage.wake()

    return next(e)
  })

  // A subagent stops: its channel says it's done and fades, unless a hook
  // beneath sends it back to work. Its turn's end may not come after: this
  // ends it all the same. It watches, and passes the stop on unchanged.
  on('classic.SubagentStop', async (_, e, next) => {
    const stopped = await next(e)
    if (stopped.block === undefined) {
      if (ensemble.end(e.agent_id, 'answer')) stage.wake()
      else endedEarly(e.agent_id)
    }

    return stopped
  })

  // A subagent starts: a channel of its own beside the main spectrum, unless
  // its loop runs elsewhere: a teammate in a terminal pane of its own, whose id
  // is its address, sends nothing here. It watches, and passes the spawn on unchanged.
  on('agent.spawn', async (_, e, next) => {
    const spawn: Spawning = { info: { name: e.name, description: e.description, type: e.subagentType }, type: e.isTeammate ? e.name : e.subagentType }
    spawning.add(spawn)
    try {
      const spawned = await next(e)
      const id = spawned.agentId
      if (id !== undefined && id !== spawned.teammateId) {
        // Its loop ended before its spawn was answered, never heard of, its end
        // heard on the main spectrum: no channel, which nothing would close; it
        // plays if it works again.
        if (early.has(id)) ensemble.know(id, spawn.info)
        else ensemble.spawned(id, spawn.info)
        stage.wake()
      }

      return spawned
    } finally {
      spawning.delete(spawn)
      if (spawning.size === 0) early.clear()
    }
  }).catch((_, e, next) => next(e))
}
