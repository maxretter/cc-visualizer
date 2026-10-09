// The plugin's decisions, apart from the hooks that act on them: what the
// person has set, what /viz does with it, when the band shows, how fast the
// frames run, which call a permission request is for, and what the doctor
// says. Pure: no `$` and no clock, so each is tested alone; register.tsx
// reads the world, asks these, and does what they say.

import type { VizMode, VizPlace, VizSize, VizTheme } from '../types'
import { THEME_NAMES, toneOf } from './engine'
import type { Tone } from './engine'

/** The terminal's background as the person set it: `auto` follows Claude Code's theme. */
export type Ground = 'auto' | Tone

export const MODES: readonly VizMode[] = ['auto', 'always', 'off']
export const SIZES: readonly VizSize[] = ['bar', 'mini']
export const PLACES: readonly VizPlace[] = ['above', 'below']
export const GROUNDS: readonly Ground[] = ['auto', 'light', 'dark']

export const isMode = (v: unknown): v is VizMode => MODES.includes(v as VizMode)
export const isTheme = (v: unknown): v is VizTheme => THEME_NAMES.includes(v as VizTheme)
export const isSize = (v: unknown): v is VizSize => SIZES.includes(v as VizSize)
export const isPlace = (v: unknown): v is VizPlace => PLACES.includes(v as VizPlace)
export const isGround = (v: unknown): v is Ground => GROUNDS.includes(v as Ground)

// Prefs --------------------------------------------------------------------

/** What the person has set with /viz, saved across sessions. */
export type Prefs = { mode: VizMode; theme: VizTheme; size: VizSize; place: VizPlace; idle: boolean; ground: Ground }

export const DEFAULTS: Prefs = { mode: 'auto', theme: 'instrument', size: 'bar', place: 'above', idle: true, ground: 'auto' }

/** What the store holds under `prefs`, or nothing: whatever an older version, or another session, left there. */
export const savedOf = (saved: unknown): Record<string, unknown> =>
  typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {}

/** The prefs as saved, each value checked, the defaults for the rest. `full` is what 0.2 called the bar. */
export function prefsFrom(saved: unknown): Prefs {
  const s = savedOf(saved)
  return {
    mode: isMode(s.mode) ? s.mode : DEFAULTS.mode,
    theme: isTheme(s.theme) ? s.theme : DEFAULTS.theme,
    size: isSize(s.size) ? s.size : s.size === 'full' ? 'bar' : DEFAULTS.size,
    place: isPlace(s.place) ? s.place : DEFAULTS.place,
    idle: typeof s.idle === 'boolean' ? s.idle : DEFAULTS.idle,
    ground: isGround(s.ground) ? s.ground : DEFAULTS.ground,
  }
}

/** The prefs that differ from `before` in `after`: all a command saves, so it never overwrites another session's newer ones. */
export function changes(before: Prefs, after: Prefs): Partial<Prefs> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => before[key as keyof Prefs] !== value))
}

// The background -----------------------------------------------------------

/** What the terminal's background is read from, beside /viz ground: Claude Code's theme setting, and the terminal's COLORFGBG. */
export type Backdrop = { theme?: unknown; colorfgbg?: string }

/** The tone the drawings paint for: the one /viz ground set, or as the backdrop reads. */
export const toneFor = (ground: Ground, backdrop: Backdrop): Tone =>
  ground === 'auto' ? toneOf(backdrop.theme, backdrop.colorfgbg) : ground

/** The tone and where it came from, as /viz ground and the doctor say it. */
export function groundText(ground: Ground, backdrop: Backdrop): string {
  const tone = toneFor(ground, backdrop)
  if (ground !== 'auto') return `${tone}, as /viz ground set it`
  if (typeof backdrop.theme === 'string' && backdrop.theme !== 'auto') return `${tone}, from Claude Code's ${backdrop.theme} theme`
  if (backdrop.colorfgbg) return `${tone}, from the terminal's COLORFGBG (${backdrop.colorfgbg})`
  return `${tone}, assumed: Claude Code's theme is auto and the terminal doesn't say`
}

// /viz ---------------------------------------------------------------------

/** The verbs alone: a verb's own options nested in the list read as the next verb's. */
export const HINT = '[auto|always|off|bar|mini|pos|pane|demo|idle|theme|ground|doctor|help]'

export const USAGE = [
  '/viz                    toggle the band',
  '/viz auto               show it while Claude works (default)',
  '/viz always             keep it up, with an idle show while quiet',
  '/viz off                hide it, and close the pane',
  '/viz bar                the band across the whole width',
  '/viz mini               a small spectrum at the right edge',
  '/viz pos [above|below]  the band above the prompt (default), or below it',
  '/viz pane               a big view with a legend',
  '/viz demo               play a few bars without a turn',
  '/viz idle [on|off]      the idle show (with always, or in the pane)',
  `/viz theme [name]       ${THEME_NAMES.join(', ')}`,
  "/viz ground [auto|light|dark]  your terminal's background (auto follows Claude Code's theme)",
  "/viz doctor             check your terminal's colors and glyphs against what the band expects",
  '/viz help               this list',
].join('\n')

/** What /viz says when the pane cannot be placed yet, in place of its usual reply. */
export const PANE_WAITS = 'The visualizer pane opens once the terminal is wide enough.'

/** What /viz does: the prefs it leaves, its reply, and what the hooks do besides. */
export type Outcome = {
  prefs: Prefs
  text: string
  /** Open the pane, or close it: the band was asked for, which it steps aside for, or all is off. */
  pane?: 'open' | 'close'
  /** All is off: every drawing goes. */
  isOff?: boolean
  isDemo?: boolean
  /** The doctor's report, which reads the terminal's environment first (`doctorReport`). */
  isDoctor?: boolean
  /** A reply alone (help, a usage line): nothing changes, and the frames are left as they are. */
  isReplyOnly?: boolean
}

/** What /viz reads besides the prefs: whether the pane is open, and the backdrop the background is read from. */
export type Situation = { isPaneOpen: boolean; backdrop: Backdrop }

/** Turns the band on, if it was off: a command that asks for it means to see it. */
const on = (prefs: Prefs): Prefs => (prefs.mode === 'off' ? { ...prefs, mode: 'auto' } : prefs)

/** /viz `args` with the person's prefs: what it does. */
export function command(args: string, prefs: Prefs, situation: Situation): Outcome {
  const [verb = '', arg = ''] = args.trim().toLowerCase().split(/\s+/)
  const same = (text: string): Outcome => ({ prefs, text, isReplyOnly: true })
  // Asked for the band: the pane, which it steps aside for, closes.
  const band = (next: Prefs, text: string): Outcome => ({ prefs: next, text, pane: situation.isPaneOpen ? 'close' : undefined })
  // The band goes off: so does the pane, and every drawing.
  const mode = (next: Prefs, text: string): Outcome =>
    next.mode === 'off' && (prefs.mode !== 'off' || verb === 'off') ? { prefs: next, text, pane: 'close', isOff: true } : { prefs: next, text }

  switch (verb) {
    case '':
    case 'toggle':
      return prefs.mode === 'off'
        ? mode({ ...prefs, mode: 'auto' }, 'Visualizer on: it plays while Claude works.')
        : mode({ ...prefs, mode: 'off' }, 'Visualizer off.')
    case 'on':
      return mode(on(prefs), 'Visualizer on.')
    case 'auto':
      return mode({ ...prefs, mode: 'auto' }, 'Visualizer on: it plays while Claude works.')
    case 'always':
      return mode({ ...prefs, mode: 'always' }, 'Visualizer on, always shown.')
    case 'off':
      return mode({ ...prefs, mode: 'off' }, 'Visualizer off.')
    case 'bar':
    case 'mini': {
      const shape = verb === 'mini' ? 'mini, at the right edge' : 'a bar across the whole width'
      return band({ ...on(prefs), size: verb }, prefs.mode === 'off' ? `Visualizer on, ${shape}.` : `Visualizer: ${shape}.`)
    }
    case 'pos': {
      if (arg === 'top') return same('Claude Code has no spot at the top of the screen that stays put. The closest is the pane: /viz pane.')
      if (arg !== '' && !isPlace(arg)) return same('Usage: /viz pos [above|below]')
      const place = isPlace(arg) ? arg : prefs.place === 'above' ? 'below' : 'above'
      return band({ ...on(prefs), place }, `Visualizer ${place} the prompt.`)
    }
    case 'pane':
      return { prefs, text: 'Visualizer pane open. Close it with ctrl+x x or /viz off.', pane: 'open' }
    case 'demo':
      return {
        prefs: on(prefs),
        text: prefs.mode === 'off' ? 'Visualizer on, playing a demo.' : 'Playing a demo for a few seconds.',
        isDemo: true,
      }
    case 'idle': {
      const idle = arg === '' ? !prefs.idle : arg === 'on' ? true : arg === 'off' ? false : undefined
      if (idle === undefined) return same('Usage: /viz idle [on|off]')
      return {
        prefs: { ...prefs, idle },
        text: !idle
          ? 'Idle animation off: the bars rest flat.'
          : prefs.mode === 'always'
            ? 'Idle animation on: a swell, rain and a scanner, in turn.'
            : 'Idle animation on. It plays on a band that stays up: /viz always, or the pane.',
      }
    }
    case 'theme': {
      if (arg !== '' && !isTheme(arg)) return same(`No theme "${arg}". Themes: ${THEME_NAMES.join(', ')}.`)
      const theme = isTheme(arg) ? arg : THEME_NAMES[(THEME_NAMES.indexOf(prefs.theme) + 1) % THEME_NAMES.length]!
      return { prefs: { ...prefs, theme }, text: `Visualizer theme: ${theme}.` }
    }
    case 'ground': {
      if (arg !== '' && !isGround(arg)) return same('Usage: /viz ground [auto|light|dark]')
      const ground = isGround(arg) ? arg : prefs.ground
      return { prefs: { ...prefs, ground }, text: `Visualizer background: ${groundText(ground, situation.backdrop)}.` }
    }
    case 'doctor':
      return { prefs, text: '', isDoctor: true }
    default:
      return same(USAGE)
  }
}

// The doctor ---------------------------------------------------------------

/** What each of the doctor's swatch rows checks. */
export const DOCTOR_HINTS = [
  'ramp: smooth where the terminal shows 24-bit color; stripes mean it rounds to 256 colors.',
  'ground: the halves should be close (near-black beside a dark terminal is fine); white on dark, or black on light, means try /viz ground light or dark.',
  'fade: its faint end should vanish into the background.',
  'glyphs: a box or a gap means the font lacks that glyph.',
]

/** The terminal's own say: its TERM, COLORTERM and TERM_PROGRAM. */
export type Terminal = { term?: string; colorterm?: string; program?: string }

/** /viz doctor's report, for the model and any surface: what the terminal and the visualizer say, a line each, then the hints. */
export function doctorReport(terminal: Terminal, prefs: Prefs, backdrop: Backdrop): string {
  const { term, colorterm, program } = terminal
  const isTrue = colorterm === 'truecolor' || colorterm === '24bit'
  const color = isTrue ? '24-bit color' : `COLORTERM ${colorterm ?? 'unset'}, so perhaps 256 colors`
  const facts = [
    `Terminal: ${term ?? 'TERM unset'}${program ? ` (${program})` : ''}, ${color}`,
    `Claude Code theme: ${typeof backdrop.theme === 'string' ? backdrop.theme : 'unknown'}`,
    `Background: ${groundText(prefs.ground, backdrop)}`,
    `Visualizer: ${prefs.mode}, ${prefs.size} ${prefs.place} the prompt, theme ${prefs.theme}, idle ${prefs.idle ? 'on' : 'off'}`,
  ]
  return ['Visualizer doctor', ...facts.map(fact => `- ${fact}`), '', ...DOCTOR_HINTS].join('\n')
}

/** The facts of a doctor's report, as its text lists them. */
export const factsOf = (report: string) =>
  report
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2))

// Where and when it draws --------------------------------------------------

/** What a site of the prompt is told: the surface, whether Claude works, a survey holds the band, and what plays. */
export type View = { surface: string; isWorking: boolean; hasSurvey?: boolean; isPlaying: boolean; isPaneOpen: boolean }

/**
 * Whether the band draws at the prompt's `at` side: on the terminal, the side
 * the person put it, unless a survey holds the band or the pane is open (the
 * band steps aside for it); always, or while Claude works or the music plays.
 */
export function isBandShown(prefs: Pick<Prefs, 'mode' | 'place'>, view: View, at: VizPlace): boolean {
  const isWanted = prefs.mode === 'always' || (prefs.mode === 'auto' && (view.isWorking || view.isPlaying))
  return view.surface === 'terminal' && view.hasSurvey !== true && !view.isPaneOpen && isWanted && prefs.place === at
}

/** Whether a drawing stays up once all is quiet, for the idle show: the pane, or the band shown always. */
export const isAmbient = (prefs: Pick<Prefs, 'mode' | 'idle'>, drawn: { hasPane: boolean; hasBand: boolean }) =>
  prefs.idle && (drawn.hasPane || (prefs.mode === 'always' && drawn.hasBand))

/**
 * Whether the person's typing plays: on a drawing that is up anyway (always,
 * the pane, or while Claude works), never one it would raise, which would
 * move the prompt they type in.
 */
export const isKeyed = (mode: VizMode, drawn: { hasPane: boolean; hasBand: boolean; isWorking: boolean }) =>
  (drawn.hasPane || drawn.hasBand) && (drawn.isWorking || mode === 'always' || drawn.hasPane)

/** The music as the frames see it after a frame, for `pace`. */
export type Beat = {
  /** Nothing moving but the shows. */
  isCalm: boolean
  /** A drawing stays up for the idle show. */
  isAmbient: boolean
  /** Nothing waits on the person either. */
  isResting: boolean
  /** Nothing left to fade. */
  isQuiet: boolean
  /** Every drawing's bars have fallen. */
  isSettled: boolean
  /** A glint is partway up a meter with something in it. */
  isGlinting: boolean
  /** A drawing waits for a frame to land, which a dialog refused. */
  isHeld: boolean
}

/** What the frames do next: run at the full rate, at a show's, go on as they are, or stop. */
export type Pace = 'full' | 'show' | 'same' | 'stop'

/**
 * How fast the frames run: full while something plays; a show's rate for the
 * vamp, or the idle show on a drawing that stays up; and once the music has
 * stopped, the bars fallen and nothing faded, a show's rate still for a glint
 * partway up the meter or a frame yet to land, else they stop.
 */
export function pace(beat: Beat): Pace {
  if (!beat.isCalm) return 'full'
  if (beat.isAmbient || !beat.isResting) return 'show'
  if (!beat.isQuiet || !beat.isSettled) return 'same'
  if (beat.isGlinting || beat.isHeld) return 'show'
  return 'stop'
}

// Permission requests ------------------------------------------------------

/** A tool call put to the mode's decider: its tool, its loop and its input, to know its permission request by. */
export type Check = { tool: string; agentId?: string; input?: string }

/** A tool's input as text, to tell calls of one tool apart by. */
export function inputKey(input: unknown): string | undefined {
  try {
    return JSON.stringify(input)
  } catch {
    return undefined
  }
}

/**
 * The call a permission request is for. It names none, so the oldest checked
 * with its tool, loop and input, else the oldest with its tool and loop.
 */
export function requestFor(checks: ReadonlyMap<string, Check>, tool: string, agentId: string | undefined, input: unknown) {
  const key = inputKey(input)
  let id: string | undefined
  for (const [checked, check] of checks) {
    if (check.tool !== tool || check.agentId !== agentId) continue
    id ??= checked
    if (check.input === key) return checked
  }
  return id
}

// The context window -------------------------------------------------------

/** The context window as a measurement reports it: the tokens in it, its size, its share, and, asked for, its breakdown. */
export type Context = {
  tokens?: number
  window: number
  percent?: number
  breakdown?: { totalTokens: number; isAutoCompactEnabled: boolean; autoCompactThreshold?: number }
}

/** The context window, and where auto-compact runs in it as a share of it (1 when it is off): the top of the meter. */
export type Measured = { tokens?: number; window: number; percent?: number; limit: number }

/** A context measured with its breakdown: before the window's first response (a cleared or resumed conversation), the breakdown's estimate. */
export function measuredFrom(context: Context): Measured {
  const { breakdown } = context
  const limit =
    breakdown?.isAutoCompactEnabled === true && breakdown.autoCompactThreshold !== undefined && context.window > 0
      ? breakdown.autoCompactThreshold / context.window
      : 1
  return { tokens: context.tokens ?? breakdown?.totalTokens, window: context.window, percent: context.percent, limit }
}

/** The share of the window in use, 0 to 100, finer than the whole percent when the tokens are known. */
export const percentOf = (context: Pick<Context, 'tokens' | 'window' | 'percent'>) =>
  context.tokens !== undefined && context.window > 0 ? (100 * context.tokens) / context.window : context.percent
