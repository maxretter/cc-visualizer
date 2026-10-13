// The idle show: what a band that stays up plays once all has been quiet a
// while, its scenes in turn, each crossfading into the next. It goes at the
// first sound.

import { bump, cycle, ease, fade } from './math'

/** The idle show's scenes, in turn: a rolling swell, rain, a scanner sweeping back and forth. */
export const SCENES = ['swell', 'rain', 'scanner'] as const
export type Scene = (typeof SCENES)[number]
/** How long each scene plays, the end of it crossfading into the next. */
const SCENE = 20_000
const SCENE_FADE = 2_000
/** The scanner's sweep there and back. */
const SCAN = 8_000
/** Drops a second at the height of the rain, and how fast a drop dies away: it halves every 100 ms. */
const RAIN = 6
const DROP = 100
/** How long all must be quiet before the idle show starts: a pause in typing, or a reply being read, is not idle. */
export const IDLE_DELAY = 8_000
/** How fast the show comes in (half the way every 900 ms), and goes at the first sound. */
const IDLE_IN = 900
const IDLE_OUT = 140

/** The idle show's swell at a point of the spectrum, `ms` into the show: a low wave rolling up it, breathing. */
function drift(x: number, ms: number): number {
  const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.4 * x - cycle(ms, 5_900))
  const ripple = 0.7 + 0.3 * Math.sin(2 * Math.PI * 2.6 * x + cycle(ms, 9_400) + 1)
  const breath = 0.8 + 0.2 * Math.sin(cycle(ms, 10_900))
  return 0.34 * swell * ripple * breath
}

/** The idle show of a spectrum, played while its music rests, drawing on its chances. */
export class IdleShow {
  /** How present it is: fades in once all is quiet, out at the first sound. */
  presence = 0
  /** How long since the music stopped: how long Claude has been idle. */
  quietFor = 0
  /** How long it has played, across rests: where it is in its scenes. */
  private played = 0
  /** How much each scene plays now. */
  private readonly scene: Record<Scene, number> = { swell: 0, rain: 0, scanner: 0 }
  /** The rain's drops: where each fell, and how much of it is left. */
  private readonly drops: { x: number; energy: number }[] = []

  constructor(private readonly rand: () => number) {}

  /**
   * Moves it on by `passed`, its animation by `ms`: the quiet grows while the
   * music `isResting`, and once it has been quiet long enough, the show comes
   * in if it `isAmbient`, wanted on a band that stays up.
   */
  step(passed: number, ms: number, isResting: boolean, isAmbient: boolean) {
    this.quietFor = isResting ? this.quietFor + passed : 0
    const idle = isAmbient && isResting && this.quietFor >= IDLE_DELAY ? 1 : 0
    this.presence = ease(this.presence, idle, idle > this.presence ? IDLE_IN : IDLE_OUT, ms)
    if (idle === 0 && this.presence < 0.01) this.presence = 0
    if (this.presence > 0) this.play(ms)
    else this.drops.length = 0
  }

  /** The show moves on by `ms`: its scenes, and the rain while it falls. */
  private play(ms: number) {
    this.played += ms
    const t = this.played % (SCENE * SCENES.length)
    const turn = Math.floor(t / SCENE)
    const crossfade = Math.max(0, (t % SCENE) - (SCENE - SCENE_FADE)) / SCENE_FADE
    for (const scene of SCENES) this.scene[scene] = 0
    this.scene[SCENES[turn]!] = 1 - crossfade
    this.scene[SCENES[(turn + 1) % SCENES.length]!] = crossfade
    const left = fade(DROP, ms)
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i]!
      drop.energy *= left
      if (drop.energy < 0.01) this.drops.splice(i, 1)
    }
    const falls = 1 - Math.exp((-RAIN * this.scene.rain * ms) / 1000)
    if (this.rand() < falls) this.drops.push({ x: this.rand(), energy: 0.4 + 0.45 * this.rand() })
  }

  /** The scene it plays most now; the first of them, the swell, before it has played. */
  sceneNow(): Scene {
    return SCENES.reduce((most, scene) => (this.scene[scene] > this.scene[most] ? scene : most))
  }

  /** Its energy at a point of the spectrum: its scenes, crossfading, as present as it is. */
  at(x: number): number {
    if (this.presence === 0) return 0
    const { swell, rain, scanner } = this.scene
    let energy = 0
    if (swell > 0) energy += swell * drift(x, this.played)
    if (rain > 0) energy += 0.15 * rain * drift(x, this.played)
    for (const drop of this.drops) energy += drop.energy * bump(x - drop.x, 0.022)
    if (scanner > 0) energy += 0.5 * scanner * bump(x - (0.5 - 0.5 * Math.cos(cycle(this.played, SCAN))), 0.035)
    return this.presence * energy
  }

  /** Not playing, and nothing of it left to fade. */
  isQuiet(): boolean {
    return this.presence === 0
  }
}
