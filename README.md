# cc-visualizer

A music visualizer for [Claude Code](https://claude.com/claude-code). A spectrum analyzer above your prompt that moves with what Claude is doing: thinking, streaming its reply, calling tools.

```
                          Grep        Write      Bash      WebFetch      Agent
▔▔ ▂▂ ▂▂ ▃▃ ▂▂ ▅▅ ▄▄ ▁▁ ▁▁ ██ ▇▇ ▁▁ ▔▔ ▔▔ ▔▔ ▔▔ ▔▔    ▔▔             ▁▁    ── ── ▁▁
▆▆ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ▅▅ ▆▆ ▂▂ ▂▂ ▁▁       ▔▔ ── ── ▔▔    ▔▔ ▁▁ ▅▅ ██
██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ▆▆ ▅▅ ▃▃ ▃▃ ▄▄ ▄▄ ▆▆ ██ ██ ██
```

While Claude thinks, a brainwave rolls above the bars:

```
thinking⢤⣀  ⢀⣠⠖⠋⠉⠉⠳⢤⡀     ⢀⣀⣀        ⢀⣀⣀                ⣠⠖⠒⠲⢤⡀    ⢀⣠⠤⠤⣄⡀
  ⣠⠞⠁    ⠈⠉⠉⠉       ⠙⠦⢤⡤⠴⠚⠉ ⠈⠙⠲⣄⡀ ⢀⡤⠞⠉ ⠈⠙⠦⣄   ⢀⣠⠤⠤⢤⡀   ⢀⡴⠚⠁    ⠙⠲⠤⠴⠚⠉
──⠁▔▔ ── ▁▁                     ⠉⠉⠉       ⠈⠙⠒⠚⠉    ⠉⠳⣄⣀⣀⣠⠴⠋    ⠈⠉⠉⠉
▅▅ ██ ▆▆ ▃▃ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁ ▁▁
```

Or keep it small with `/viz mini`, a strip at the right edge with the latest tools beside it:

```
                        ▁ ▁ ▃ ▂ ▁ ▄ ▁ ─ ─       ▁ ─ ▁ ▁
Bash · WebFetch · ⠴ Grep  █ █ █ █ █ █ ▇ ▆ ▄ ▄ ▃ ▂ ▂ ▄ █ ▇
```

(In the terminal it's in color: each band has its own color, and the bars have falling peak caps.)

## What drives it

Each kind of activity is an instrument with its own place on the spectrum, low to high:

| Band | Driven by |
| --- | --- |
| think | thinking tokens, plus a slow pulse while waiting for the model |
| text | the reply as it streams |
| read | Read, Grep, Glob |
| edit | Edit, Write, NotebookEdit |
| bash | Bash and background shells |
| web/mcp | WebFetch, WebSearch, any MCP tool |
| agents | Agent, Skill and other tools |
| args | tool arguments as the model writes them |

- **Tool calls:** a hit on the tool's band, then a held note while it runs. Its name shows over the band and fades a few seconds after it finishes.
- **Prompts and turns:** sending a prompt sweeps up the spectrum. Finishing a turn crashes a cymbal, and interrupting one sweeps back down.
- **Errors:** a tool error flashes the bars red.
- **Idle:** a band that stays up (`/viz always`, or the pane) plays a low show while nothing happens, labeled `idle` with how long it's been: a rolling swell, rain, and a scanner sweeping back and forth, 20 seconds each, drawn at half the frame rate. Otherwise the animation stops once the bars have fallen.

## Install

In a Claude Code terminal session:

```
/plugin install visualizer --marketplace maxretter/cc-visualizer
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). Then try `/viz demo`.

This needs a Claude Code build with plugin function hooks: it was built against 2.1.294, and that API is early access, so a later release may need changes. The visualizer draws in the terminal. On other surfaces the band stays out of the way.

## Commands

| Command | |
| --- | --- |
| `/viz` | toggle the visualizer on or off |
| `/viz auto` | show it while Claude works (default) |
| `/viz always` | keep it up, with an idle show while quiet |
| `/viz off` | hide it, and close the pane |
| `/viz mini` | a small spectrum at the right edge, with tool names beside it |
| `/viz full` | the band across the whole width |
| `/viz pane` | a big view with a legend (docked beside the transcript in fullscreen) |
| `/viz demo` | play a few seconds of thinking and drums without a turn |
| `/viz idle [on\|off]` | the idle show (on by default); off leaves the bars flat |
| `/viz theme [name]` | `instrument` (default), `claude`, `synthwave`, `classic`; no name cycles |

Your mode, size, theme and idle setting are remembered across sessions.

## Development

```
claude --plugin-dir .          # run it from this folder; saving a file reloads it
claude plugin validate .       # what the engine sees and would refuse
claude plugin test .           # tests/*.test.tsx against the engine
```

- `hooks/engine.ts`: the simulation and drawing. It's pure, so it's easy to test.
- `hooks/register.tsx`: the hooks that feed the engine, the drawing sites and `/viz`.
- `types/index.d.ts`: the plugin's state contract.

Claude Code generates the API typings in `.claude-plugin/types/` when it loads the plugin (they're git-ignored). After that, `tsc -p .` type-checks the plugin.

## License

MIT
