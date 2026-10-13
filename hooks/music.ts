// The hooks that play the music as Claude works: the person's keys and
// prompts, the response as it streams, tool calls and the asks they put to
// the person, failures, the ends of turns, and subagents starting. Each plays
// on the stage's spectrum, or a subagent's own, and wakes the frames. None
// reaches for `$`: they watch, and pass each event on as it came.

import type { On } from 'claude-code'

import { sourceOf } from './engine/sources'
import type { SourceId } from './engine/sources'
import type { Ask, Call, Spectrum } from './engine/spectrum'
import { Step } from './engine/step'
import type { Stage } from './stage'
import { argumentsOf, inputKey, isKeyed, requestFor } from './viz'
import type { Check } from './viz'

/** Tools whose whole call waits on the person: a question, a plan to approve. */
const PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** A call running, and the spectrum it plays on: the main loop's, or its subagent's own. */
type Running = { call: Call; owner: Spectrum }

export function music(on: On, stage: Stage) {
  const { spectrum, ensemble, sites } = stage
  // Tool calls by their id while they run, the ones that may yet be put to the
  // person, and the ones put to the person until answered, on each spectrum
  // the ask plays on.
  const calls = new Map<string, Running>()
  const checks = new Map<string, Check>()
  const asks = new Map<string, [Spectrum, Ask][]>()

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

  // The person types: the keys play on a drawing that is up anyway.
  on('prompt.edit', ($, e, next) => {
    if (isKeyed(stage.prefs.mode, { ...stage.drawn(), isWorking: stage.isWorking })) {
      spectrum.edited(e.text, e.start, e.end, e.inputText)
      stage.wake()
    }

    return next(e)
  })

  // A prompt sent: a sweep up the spectrum.
  on('prompt.submit', ($, e, next) => {
    spectrum.kick()
    stage.wake()

    return next(e)
  }).catch(($, e, next) => next(e))

  // The model's response as it streams, played a chunk at a time: a
  // subagent's on its own voice, one never heard of softer on the main spectrum.
  on('turn.step', async function* ($, e, next) {
    const voice = ensemble.voiceOf(e.agentId)
    const step = voice !== undefined ? new Step(voice.spectrum) : new Step(spectrum, e.agentId !== undefined)
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
    }
  })

  // A tool runs: a hit, its name, a held note until it returns; a subagent's in its own channel.
  on('tool.call', async ($, e, next) => {
    const owner = ensemble.voiceOf(e.agentId)?.spectrum ?? spectrum
    const call = owner.startCall(String(e.tool))
    const id = e.tool_use_id
    if (id !== undefined) {
      calls.set(id, { call, owner })
      if (PERSON.has(String(e.tool))) asks.set(id, ask(owner, call.source, call, 0))
      else checks.set(id, { tool: e.tool, agentId: e.agentId, input: inputKey(argumentsOf(e)) })
    }
    stage.wake()
    try {
      return await next(e)
    } finally {
      if (id !== undefined) {
        calls.delete(id)
        answer(id)
      }
      owner.endCall(call)
    }
  }).catch(($, e, next) => next(e))

  // A tool that ran and failed flashes red. A call refused (at the dialog, by a
  // rule or by auto mode) or cut by an interrupt never ran: core marks it an
  // error too, but this is not raised for it.
  on('classic.PostToolUseFailure', ($, e, next) => {
    if (e.is_interrupt !== true) {
      const owner = ensemble.find(e.agent_id)?.spectrum ?? spectrum
      owner.error()
      stage.wake()
    }

    return next(e)
  })

  // The person is asked to allow a call: unless an answer comes within the grace
  // (a hook's), its held note rests and the vamp plays until it is answered.
  // Only asks that reach the person raise this, not the ones auto mode's
  // classifier settles. It watches, and passes the request on unchanged.
  on('classic.PermissionRequest', ($, e, next) => {
    const id = requestFor(checks, e.tool_name, e.agent_id, e.tool_input)
    if (id !== undefined) {
      checks.delete(id)
      const running = calls.get(id)
      asks.set(id, ask(running?.owner ?? spectrum, running?.call.source ?? sourceOf(e.tool_name), running?.call))
      stage.wake()
    }

    return next(e)
  })

  // A tool's progress row shows once it runs: the ask was answered.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    settle(e.props.tool_use_id)

    return next(e)
  })

  // The turn ends: a cymbal, a sweep down when interrupted, red on an error. A
  // subagent's ends in its own channel, which says how it went and fades.
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined || !ensemble.end(e.agentId, e.reason)) spectrum.ended(e.reason, e.agentId !== undefined)
    stage.wake()

    return next(e)
  })

  // A subagent starts: a channel of its own beside the main spectrum. It
  // watches, and passes the spawn on unchanged.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      ensemble.join(spawned.agentId, { name: e.name, description: e.description, type: e.subagentType })
      stage.wake()
    }

    return spawned
  }).catch(($, e, next) => next(e))
}
