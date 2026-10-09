import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  USAGE,
  changes,
  command,
  doctorReport,
  factsOf,
  groundText,
  inputKey,
  isAmbient,
  isBandShown,
  isKeyed,
  measuredFrom,
  pace,
  percentOf,
  prefsFrom,
  requestFor,
  toneFor,
} from '../hooks/viz'
import type { Beat, Check, Prefs, Situation, View } from '../hooks/viz'

const closed: Situation = { isPaneOpen: false, backdrop: {} }
const open: Situation = { isPaneOpen: true, backdrop: {} }
const as = (prefs: Partial<Prefs>): Prefs => ({ ...DEFAULTS, ...prefs })

describe('prefs', () => {
  test('restored from the store: each value checked, the defaults for the rest', () => {
    expect(prefsFrom(undefined)).toEqual(DEFAULTS)
    expect(prefsFrom('junk')).toEqual(DEFAULTS)
    const saved = { mode: 'always', theme: 'claude', size: 'mini', place: 'below', idle: false, ground: 'light' }
    expect(prefsFrom(saved)).toEqual(saved)
    expect(prefsFrom({ mode: 'loud', theme: 'neon', size: 'huge', place: 'top', idle: 'yes', ground: 'blue' })).toEqual(DEFAULTS)
  })

  test("0.2's `full` comes back as the bar", () => {
    expect(prefsFrom({ size: 'full' }).size).toBe('bar')
  })

  test('a command saves only what it changed', () => {
    expect(changes(DEFAULTS, DEFAULTS)).toEqual({})
    expect(changes(DEFAULTS, as({ theme: 'classic', idle: false }))).toEqual({ theme: 'classic', idle: false })
  })
})

describe('the background', () => {
  test('/viz ground wins; else the theme; else COLORFGBG; else dark', () => {
    expect(toneFor('light', { theme: 'dark' })).toBe('light')
    expect(toneFor('auto', { theme: 'light-ansi' })).toBe('light')
    expect(toneFor('auto', { theme: 'auto', colorfgbg: '0;15' })).toBe('light')
    expect(toneFor('auto', {})).toBe('dark')
  })

  test('says where it came from', () => {
    expect(groundText('dark', { theme: 'light' })).toBe('dark, as /viz ground set it')
    expect(groundText('auto', { theme: 'light' })).toBe("light, from Claude Code's light theme")
    expect(groundText('auto', { theme: 'auto', colorfgbg: '15;0' })).toBe("dark, from the terminal's COLORFGBG (15;0)")
    expect(groundText('auto', { theme: 'auto' })).toBe("dark, assumed: Claude Code's theme is auto and the terminal doesn't say")
  })
})

describe('/viz', () => {
  test('bare, or toggle, turns it off and back on: off closes the pane and every drawing', () => {
    for (const verb of ['', 'toggle']) {
      const off = command(verb, DEFAULTS, closed)
      expect(off).toMatchObject({ prefs: as({ mode: 'off' }), text: 'Visualizer off.', pane: 'close', isOff: true })
      const back = command(verb, off.prefs, closed)
      expect(back).toMatchObject({ prefs: as({ mode: 'auto' }), text: 'Visualizer on: it plays while Claude works.' })
      expect(back.isOff).toBeUndefined()
    }
  })

  test('auto, always, off and on set the mode; on keeps one that is on', () => {
    expect(command('always', DEFAULTS, closed)).toMatchObject({ prefs: as({ mode: 'always' }), text: 'Visualizer on, always shown.' })
    expect(command('auto', as({ mode: 'always' }), closed).prefs.mode).toBe('auto')
    expect(command('off', as({ mode: 'off' }), closed)).toMatchObject({ isOff: true, pane: 'close' })
    expect(command('on', as({ mode: 'off' }), closed).prefs.mode).toBe('auto')
    expect(command('on', as({ mode: 'always' }), closed)).toMatchObject({ prefs: as({ mode: 'always' }), text: 'Visualizer on.' })
  })

  test('bar and mini set the size, turn it on, and close the pane they step aside for', () => {
    expect(command('mini', DEFAULTS, closed)).toEqual({ prefs: as({ size: 'mini' }), text: 'Visualizer: mini, at the right edge.', pane: undefined })
    expect(command('bar', as({ mode: 'off', size: 'mini' }), closed)).toMatchObject({
      prefs: as({ mode: 'auto' }),
      text: 'Visualizer on, a bar across the whole width.',
    })
    expect(command('bar', DEFAULTS, open).pane).toBe('close')
  })

  test('pos sets the place, or swaps it, and says where it cannot go', () => {
    expect(command('pos below', DEFAULTS, closed)).toMatchObject({ prefs: as({ place: 'below' }), text: 'Visualizer below the prompt.' })
    expect(command('pos', as({ place: 'below' }), closed).prefs.place).toBe('above')
    expect(command('pos', DEFAULTS, open).pane).toBe('close')
    expect(command('pos top', DEFAULTS, closed)).toMatchObject({ prefs: DEFAULTS, isReplyOnly: true })
    expect(command('pos top', DEFAULTS, closed).text).toContain('/viz pane')
    expect(command('pos sideways', DEFAULTS, closed)).toMatchObject({ text: 'Usage: /viz pos [above|below]', isReplyOnly: true })
  })

  test('pane opens it; demo plays, turning it on', () => {
    expect(command('pane', DEFAULTS, closed)).toMatchObject({ prefs: DEFAULTS, pane: 'open' })
    expect(command('demo', DEFAULTS, closed)).toMatchObject({ prefs: DEFAULTS, isDemo: true, text: 'Playing a demo for a few seconds.' })
    expect(command('demo', as({ mode: 'off' }), closed)).toMatchObject({ prefs: DEFAULTS, text: 'Visualizer on, playing a demo.' })
  })

  test('idle toggles the show, or sets it; its reply says where it plays', () => {
    expect(command('idle', DEFAULTS, closed)).toMatchObject({ prefs: as({ idle: false }), text: 'Idle animation off: the bars rest flat.' })
    expect(command('idle on', as({ idle: false }), closed).text).toContain('/viz always')
    expect(command('idle on', as({ mode: 'always', idle: false }), closed).text).toContain('a swell, rain and a scanner')
    expect(command('idle off', DEFAULTS, closed).prefs.idle).toBe(false)
    expect(command('idle maybe', DEFAULTS, closed)).toMatchObject({ text: 'Usage: /viz idle [on|off]', isReplyOnly: true })
  })

  test('theme sets one by name, or cycles through them, round again', () => {
    expect(command('theme synthwave', DEFAULTS, closed)).toMatchObject({ prefs: as({ theme: 'synthwave' }), text: 'Visualizer theme: synthwave.' })
    expect(command('theme', DEFAULTS, closed).prefs.theme).toBe('claude')
    expect(command('theme', as({ theme: 'classic' }), closed).prefs.theme).toBe('instrument')
    expect(command('theme neon', DEFAULTS, closed)).toMatchObject({ isReplyOnly: true, prefs: DEFAULTS })
  })

  test('ground sets the background, or says which it is using', () => {
    const backdrop = { theme: 'light' }
    expect(command('ground dark', DEFAULTS, { isPaneOpen: false, backdrop })).toMatchObject({
      prefs: as({ ground: 'dark' }),
      text: 'Visualizer background: dark, as /viz ground set it.',
    })
    expect(command('ground', DEFAULTS, { isPaneOpen: false, backdrop }).text).toBe("Visualizer background: light, from Claude Code's light theme.")
    expect(command('ground beige', DEFAULTS, closed)).toMatchObject({ text: 'Usage: /viz ground [auto|light|dark]', isReplyOnly: true })
  })

  test('doctor reports; help, or anything else, lists the commands, changing nothing', () => {
    expect(command('doctor', DEFAULTS, closed)).toMatchObject({ prefs: DEFAULTS, isDoctor: true })
    for (const args of ['help', 'sing']) {
      expect(command(args, as({ mode: 'always' }), closed)).toEqual({ prefs: as({ mode: 'always' }), text: USAGE, isReplyOnly: true })
    }
  })

  test('takes its verb in any case, and spaces around it', () => {
    expect(command('  ALWAYS ', DEFAULTS, closed).prefs.mode).toBe('always')
    expect(command('Pos  Below', DEFAULTS, closed).prefs.place).toBe('below')
  })
})

describe('the doctor', () => {
  test('reports the terminal, the theme, the background and the prefs, a fact a line', () => {
    const report = doctorReport({ term: 'xterm-kitty', colorterm: 'truecolor' }, as({ idle: false }), { theme: 'dark' })
    expect(factsOf(report)).toEqual([
      'Terminal: xterm-kitty, 24-bit color',
      'Claude Code theme: dark',
      "Background: dark, from Claude Code's dark theme",
      'Visualizer: auto, bar above the prompt, theme instrument, idle off',
    ])
    expect(report.startsWith('Visualizer doctor\n')).toBe(true)
  })

  test('says when it cannot tell', () => {
    const facts = factsOf(doctorReport({ program: 'Apple_Terminal' }, DEFAULTS, {}))
    expect(facts[0]).toBe('Terminal: TERM unset (Apple_Terminal), COLORTERM unset, so perhaps 256 colors')
    expect(facts[1]).toBe('Claude Code theme: unknown')
  })
})

describe('where and when it draws', () => {
  const view = (over: Partial<View> = {}): View => ({ surface: 'terminal', isWorking: false, isPlaying: false, isPaneOpen: false, ...over })

  test('the band shows always, or in auto while Claude works or the music plays, at its own side', () => {
    expect(isBandShown({ mode: 'always', place: 'above' }, view(), 'above')).toBe(true)
    expect(isBandShown({ mode: 'auto', place: 'above' }, view(), 'above')).toBe(false)
    expect(isBandShown({ mode: 'auto', place: 'above' }, view({ isWorking: true }), 'above')).toBe(true)
    expect(isBandShown({ mode: 'auto', place: 'above' }, view({ isPlaying: true }), 'above')).toBe(true)
    expect(isBandShown({ mode: 'off', place: 'above' }, view({ isWorking: true }), 'above')).toBe(false)
    expect(isBandShown({ mode: 'always', place: 'below' }, view(), 'above')).toBe(false)
    expect(isBandShown({ mode: 'always', place: 'below' }, view(), 'below')).toBe(true)
  })

  test('the band steps aside for the pane and a survey, and draws only on the terminal', () => {
    const always = { mode: 'always', place: 'above' } as const
    expect(isBandShown(always, view({ isPaneOpen: true }), 'above')).toBe(false)
    expect(isBandShown(always, view({ hasSurvey: true }), 'above')).toBe(false)
    expect(isBandShown(always, view({ surface: 'desktop' }), 'above')).toBe(false)
  })

  test('the idle show plays on a drawing that stays up: the pane, or the band shown always', () => {
    expect(isAmbient(as({ mode: 'always' }), { hasPane: false, hasBand: true })).toBe(true)
    expect(isAmbient(as({ mode: 'auto' }), { hasPane: false, hasBand: true })).toBe(false)
    expect(isAmbient(as({ mode: 'auto' }), { hasPane: true, hasBand: false })).toBe(true)
    expect(isAmbient(as({ mode: 'always', idle: false }), { hasPane: true, hasBand: true })).toBe(false)
    expect(isAmbient(as({ mode: 'always' }), { hasPane: false, hasBand: false })).toBe(false)
  })

  test('typing plays on a drawing that is up anyway, and never raises one', () => {
    expect(isKeyed('auto', { hasPane: false, hasBand: true, isWorking: true })).toBe(true)
    expect(isKeyed('auto', { hasPane: false, hasBand: true, isWorking: false })).toBe(false)
    expect(isKeyed('always', { hasPane: false, hasBand: true, isWorking: false })).toBe(true)
    expect(isKeyed('auto', { hasPane: true, hasBand: false, isWorking: false })).toBe(true)
    expect(isKeyed('always', { hasPane: false, hasBand: false, isWorking: true })).toBe(false)
  })
})

describe('the pace of the frames', () => {
  const beat = (over: Partial<Beat> = {}): Beat => ({
    isCalm: true,
    isAmbient: false,
    isResting: true,
    isQuiet: true,
    isSettled: true,
    isGlinting: false,
    isHeld: false,
    ...over,
  })

  test('full while something plays; a show for the vamp or the idle show; stopped once all is done', () => {
    expect(pace(beat({ isCalm: false }))).toBe('full')
    expect(pace(beat({ isAmbient: true }))).toBe('show')
    expect(pace(beat({ isResting: false }))).toBe('show')
    expect(pace(beat())).toBe('stop')
  })

  test('the same while the bars fall; a show for a glint or a frame yet to land', () => {
    expect(pace(beat({ isQuiet: false }))).toBe('same')
    expect(pace(beat({ isSettled: false }))).toBe('same')
    expect(pace(beat({ isGlinting: true }))).toBe('show')
    expect(pace(beat({ isHeld: true }))).toBe('show')
  })
})

describe('permission requests', () => {
  test('find their call by tool, loop and input; else the oldest by tool and loop', () => {
    const checks = new Map<string, Check>([
      ['t1', { tool: 'Bash', input: inputKey({ command: 'ls' }) }],
      ['t2', { tool: 'Bash', input: inputKey({ command: 'rm -r build' }) }],
      ['t3', { tool: 'Bash', agentId: 'a1', input: inputKey({ command: 'ls' }) }],
      ['t4', { tool: 'Edit', input: inputKey({ file_path: 'x' }) }],
    ])
    expect(requestFor(checks, 'Bash', undefined, { command: 'rm -r build' })).toBe('t2')
    expect(requestFor(checks, 'Bash', undefined, { command: 'make' })).toBe('t1')
    expect(requestFor(checks, 'Bash', 'a1', { command: 'make' })).toBe('t3')
    expect(requestFor(checks, 'Write', undefined, {})).toBeUndefined()
  })

  test('an input that is no JSON has no key', () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(inputKey(loop)).toBeUndefined()
    expect(inputKey({ a: 1 })).toBe('{"a":1}')
  })
})

describe('the context window', () => {
  test('the top of the meter is where auto-compact runs, the whole window when it is off', () => {
    const on = { totalTokens: 1, isAutoCompactEnabled: true, autoCompactThreshold: 160_000 }
    expect(measuredFrom({ tokens: 50_000, window: 200_000, breakdown: on }).limit).toBe(0.8)
    expect(measuredFrom({ tokens: 50_000, window: 200_000, breakdown: { ...on, isAutoCompactEnabled: false } }).limit).toBe(1)
    expect(measuredFrom({ tokens: 50_000, window: 200_000 }).limit).toBe(1)
  })

  test('before a response reports the fill, the breakdown estimates it', () => {
    const breakdown = { totalTokens: 20_000, isAutoCompactEnabled: false }
    expect(measuredFrom({ window: 200_000, breakdown }).tokens).toBe(20_000)
    expect(measuredFrom({ tokens: 90_000, window: 200_000, breakdown }).tokens).toBe(90_000)
  })

  test('the share in use, finer than the whole percent when the tokens are known', () => {
    expect(Math.abs(percentOf({ tokens: 50_123, window: 200_000, percent: 25 })! - 25.0615)).toBeLessThan(1e-9)
    expect(percentOf({ window: 200_000, percent: 25 })).toBe(25)
    expect(percentOf({ window: 0, tokens: 10 })).toBeUndefined()
  })
})
