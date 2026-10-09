/** When the band above the prompt shows: while Claude works, always, or never. */
export type VizMode = 'auto' | 'always' | 'off'

/** How the bars are colored. `instrument` colors each bar by the activity it tracks. */
export type VizTheme = 'instrument' | 'claude' | 'synthwave' | 'classic'

/** The band's size: a bar across the whole width, or a small spectrum at its right edge. */
export type VizSize = 'bar' | 'mini'

/** Where the band is drawn: above the prompt, or below it, over the hint line. */
export type VizPlace = 'above' | 'below'

declare module 'claude-code' {
  interface PluginState {
    visualizer: {
      mode: VizMode
      theme: VizTheme
      size: VizSize
      place: VizPlace
      /** True while the music plays (activity, or bars still falling); not the idle show. */
      isPlaying: boolean
      /** True while the big pane is open; the band steps aside for it. */
      isPaneOpen: boolean
    }
  }
}
