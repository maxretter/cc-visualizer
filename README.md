# cc-visualizer

A music visualizer for [Claude Code](https://claude.com/claude-code). A spectrum analyzer above your prompt that moves with what Claude is doing: thinking, streaming its reply, calling tools, and running subagents, each in a channel of its own.

![The band above the Claude Code prompt playing /viz demo: a brainwave while it thinks, then drums, with tool names over their bands, and two subagents opening channels of their own at the right, each in turn growing across the band as the main spectrum shrinks, then closing them once done](docs/demo.gif)

```
                          Grep        Write      Bash      WebFetch      Agent
▔▔ ▂▂ ▂▂ ▃▃ ▂▂ ▅▅ ▄▄ ▁▁ ▁▁ ██ ▇▇ ▁▁ ▔▔ ▔▔ ▔▔ ▔▔ ▔▔    ▔▔             ▁▁    ── ── ▁▁
▆▆ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ▅▅ ▆▆ ▂▂ ▂▂ ▁▁       ▔▔ ── ── ▔▔    ▔▔ ▁▁ ▅▅ ██
██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ▆▆ ▅▅ ▃▃ ▃▃ ▄▄ ▄▄ ▆▆ ██ ██ ██
```

While Claude thinks, a brainwave wanders above the bars, never the same twice, and each spark of thought sends a spike along it, in from either side:

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
| think | thinking tokens, plus a restless wander with sparks while waiting for the model |
| text | the reply as it streams |
| read | Read, Grep, Glob |
| edit | Edit, Write, NotebookEdit |
| bash | Bash and background shells |
| web/mcp | WebFetch, WebSearch, any MCP tool |
| agents | Agent, Skill and other tools |
| args | tool arguments as the model writes them |

- **Tool calls:** a hit on the tool's band, then a held note while it runs. Its name shows over the band and fades a few seconds after it finishes.
- **Prompts and turns:** sending a prompt sweeps up the spectrum. Finishing a turn crashes a cymbal, and interrupting one sweeps back down.
- **Subagents:** each subagent plays in a channel of its own, to the right of the main spectrum, its own small spectrum with a bar for each instrument. Over it are the agent's name, in a color of its own, and what it's doing: the tool it's running, `thinking`, or `waiting` in amber when it asks your permission (the band waits on you too). A channel opens as its agent starts, the main spectrum's bars narrowing to make room; a teammate in a terminal pane of its own gets none, since nothing it does reaches this session. When the agent finishes, the channel says `done`, `failed` or `stopped`, and a few seconds later closes the way it opened, the main spectrum widening back and any channels after it sliding over. An agent at work with nothing to show, waiting on background work of its own, holds no frames: its channel stands still until it plays again. The main spectrum keeps at least half the width; agents beyond what fits wait, counted at the right edge (`+2`), and one still at work opens at the end as the first to finish closes, so the main spectrum holds still. With `/viz mini`, they're named in the trail beside the strip instead.
- **Focus:** open a subagent's transcript from the tasks list and its channel grows to take most of the band as the main spectrum shrinks to a channel's width, the two moving together over half a second. Grown, the channel is labeled the way the main spectrum is: the subagent's name in its color, then its tools over their bands. Shrunk, the main spectrum is labeled the way a channel is, `main` and what it's doing, with the context meter still at its right edge. Other channels hold still. Back on the main transcript, or once the subagent finishes and its channel closes, each goes back to its own size. A subagent with no channel to grow (with `/viz mini`, on a band too narrow for channels, or one waiting for a channel, counted in `+2`) plays on the main spectrum instead, its name leading the labels. With `/viz mini`, the trail names it first, then `main`. `/viz demo` shows it: once both its subagents' channels are open, it opens each one's transcript in turn, then goes back to the main conversation's.
- **Errors:** a tool that fails flashes the bars red, or a subagent's channel when it's the subagent's. A call that's refused or interrupted doesn't, since it never ran.
- **Waiting on you:** when Claude asks your permission, or asks you a question, the bars turn amber and the waiting tool's band pulses in time, labeled `waiting on you` with how long it's been. After half a minute the pulses shrink. In auto mode the pulse only starts if the classifier hands the call to you, never while it's still deciding, and a permission ask waits 1.5 seconds before the pulse starts, so one a hook answers on its own doesn't flash it. The pulse stops once a hook answers, the tool runs (for Bash, when its run-in-background hint shows) or finishes, or Claude's turn ends. Claude Code hides the band above the prompt while a dialog is up, so this shows in the pane (`/viz pane`).
- **Context:** a meter at the right edge fills as the context window does, green, then amber, then red, its top where auto-compact runs. Every 10 seconds, and when a new reading comes in, a glint runs up it. The band and the pane label it `context 72%`, the share of the window in use. Compacting sweeps down the spectrum, labeled `compacting`, until it's done, and the meter drains. After `/clear` it shows an estimate of the fresh conversation until the first reply, and turning auto-compact on or off in `/config` moves its top.
- **Typing:** on a band that's up anyway (`/viz always`, the pane, or while Claude works), your keys play too. Each key is a note where it sits on the keyboard, the left hand low and the right hand high, and capitals play louder. A space is a soft breath across the middle, and a paste plays as a quick run. Deleting plays quieter notes, a run going backward. Typing never brings up a band that's down, so the prompt you're typing in doesn't move.
- **Idle:** a band that stays up (`/viz always`, or the pane) plays a low show once nothing has happened for 8 seconds, labeled `idle` with how long it's been: a rolling swell, rain, and a scanner sweeping back and forth, 20 seconds each, drawn at half the frame rate, and at 8 fps after five minutes idle. Typing stops the show at once, and a pause to think doesn't bring it back. Otherwise the animation stops once the bars have fallen and the last frame has reached the screen.

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
| `/viz bar` | the band across the whole width (default) |
| `/viz mini` | a small spectrum at the right edge, with tool names beside it |
| `/viz pos [above\|below]` | the band above the prompt (default), or below it, over the hint line; no place switches |
| `/viz pane` | a big view with a legend (docked beside the transcript in fullscreen) |
| `/viz demo` | play a few seconds of thinking and drums, with two subagents in their channels, each opened in turn, without a turn |
| `/viz idle [on\|off]` | the idle show (on by default); off leaves the bars flat |
| `/viz theme [name]` | `instrument` (default), `claude`, `synthwave`, `classic`; no name cycles |
| `/viz ground [auto\|light\|dark]` | your terminal's background; `auto` (default) follows Claude Code's theme; no argument says what it's using |
| `/viz doctor` | check your terminal's colors and glyphs against what the band expects |

`/viz bar`, `/viz mini` and `/viz pos` close the pane, since the band steps aside while it's open. Your mode, size, position, theme, idle setting and background are remembered across sessions. There's no position at the top of the screen: Claude Code keeps nothing pinned there for a plugin to draw in. The pane is the closest.

On a light terminal the band paints for the light background: colors fade to white rather than black, and pale ones are darkened until they stand out. It follows Claude Code's theme (`/config`): a light theme means a light background. With the `auto` theme, the band reads the terminal's `COLORFGBG` if it's set, and otherwise assumes dark; `/viz ground light` settles it. `/viz doctor` shows what it found, with a swatch of the background it expects beside your terminal's own.

## What it does in your session

The visualizer watches and draws. It changes nothing Claude Code does: every hook passes its event on unchanged, except `/viz`, which answers its own command. It decides no permission, writes no setting, sends nothing over the network, and runs no programs.

Its hooks, in `hooks/register.tsx` and `hooks/music.ts`:

| Hook | What it does |
| --- | --- |
| `session.start` | registers `/viz`, restores your `/viz` settings, reads Claude Code's theme and `COLORFGBG` to tell a light background, reads the context window's fill, and lists the session's subagents, to give those still at work after a reload their channels back |
| `prompt.edit` | plays your keys on a band that's already up |
| `prompt.submit` | a sweep up the spectrum |
| `turn.step` | plays the response as it streams: thinking, text, tool calls, their arguments; a subagent's in its channel |
| `turn.complete` | a cymbal at the end of a turn, a sweep down on an interrupt, red on an error; a subagent's ends in its channel. The main loop's turn ends any wait, held note or thinking of it left behind |
| `tool.call` | a hit on the tool's band, and a held note while it runs; a subagent's in its channel |
| `agent.spawn` | when a subagent starts, gives it a channel, named as the Agent call named it, unless it's a teammate in a terminal pane of its own. It decides nothing, and passes the spawn on as it came |
| `classic.SubagentStart`, `classic.SubagentStop` | a subagent's channel opens as its loop starts, if that comes before its spawn is answered, and closes as it stops, unless a hook sends it back to work. They decide nothing, and pass each event on as it came |
| `classic.PostToolUseFailure` | a tool that failed flashes the bars red |
| `classic.PermissionRequest` | when Claude Code is about to ask you to allow a tool, the band pulses amber until you or a hook answer. It decides nothing, and passes the request on as it came; the plugin has no hook on the permission decision itself |
| `config.set` (`theme`, `autoCompact`) | when you change Claude Code's theme or auto-compact, it reads the new setting a moment later, to paint for the background or move the meter's top. The change passes on as it came |
| `session.measure`, `session.compact`, `classic.SessionStart` | the context meter: its fill, a rewind while compacting, an estimate after `/clear` |
| `ui.render` (`AbovePrompt`, `PromptHint`, `Pane`, `CommandOutput`, `ToolProgress`) | draws the band, the pane and `/viz doctor`'s swatches, and reads which transcript is in view, to put a subagent in focus; a tool's run-in-background pill means a permission ask was answered |
| `ui.close` | notes that the pane closed |
| `command.run` (`viz`) | answers `/viz` |

- **Reads:** the environment variables `COLORFGBG`, to tell a light background, and, for `/viz doctor`, `TERM`, `COLORTERM` and `TERM_PROGRAM`; Claude Code's theme setting; the session's context usage; the session's subagents, with their names, task descriptions, types and whether they're at work.
- **Writes:** your `/viz` settings in the plugin's own store, and the same settings in its own state with whether it's playing and whether its pane is open.
- **Sends:** nothing.

The scripts in `scripts/` are for development and don't run with the plugin: `scripts/demo-gif/make.sh`, which you run by hand to remake the GIF above, starts `claude` and ffmpeg and installs the Python package pyte into a throwaway virtualenv.

## Development

```
claude --plugin-dir .          # run it from this folder; saving a file reloads it
claude plugin validate .       # what the engine sees and would refuse
claude plugin test .           # tests/*.test.ts and *.test.tsx against the engine
```

- `hooks/engine/`: the music and its drawing, a file for each part. It's pure, so it's easy to test.
  - The music: `spectrum.ts`, each instrument's energy and the shows over it; `step.ts` plays a model request on it as it streams, `demo.ts` plays `/viz demo`, and `ensemble.ts` gives each subagent a spectrum of its own.
  - The drawing: `bars.ts` draws a spectrum as bars, `channels.ts` the subagents' beside them, and `board.ts` the two together; `names.ts` and `trail.ts` draw the names over and beside them, and `doctor.ts` `/viz doctor`'s swatches.
  - What they're made of: `sources.ts`, the instruments; `color.ts`, the themes and backgrounds; `cells.ts`, Raster cells; `math.ts`, fades, waves and noise.
- `hooks/viz.ts`: the plugin's decisions: your saved settings, what each `/viz` command does, when the band shows, how fast the frames run. Also pure.
- `hooks/stage.ts`: what the hooks share: the music, the drawings the frames repaint, and your settings. It paints each frame and says how fast the next should come.
- `hooks/music.ts`: the hooks that play the music as Claude works. None of them use `$`.
- `hooks/register.tsx`: the hooks that use `$`: the session's start and the frames it runs, the context meter, Claude Code's settings, the drawings and `/viz`. They read what Claude Code tells them, ask the modules above, and do what they say. `claude plugin validate` follows `$` only into functions in the same file, and reads a `$.state` atom only in the file that declares it, so these stay together.
- `types/index.d.ts`: the plugin's state contract.
- `tests/`: a file for each topic (`music`, `thinking`, `waiting`, `subagents`, and so on), testing the engine, and the hooks through Claude Code's test harness; `viz.test.ts` tests the decisions on their own, and `support.tsx` holds the helpers the tests share.

Claude Code generates the API typings in `.claude-plugin/types/` when it loads the plugin (they're git-ignored). After that, `tsc -p .` type-checks the plugin.

`scripts/demo-gif/make.sh` remakes `docs/demo.gif`. It starts `claude --plugin-dir .` in a pseudo-terminal, types `/viz demo`, records it, and renders the band and the prompt as a GIF. It needs ffmpeg, and installs pyte in a throwaway virtualenv. The band plays with your saved `/viz` settings, and nothing goes to the model. The renderer looks for the band above the prompt, so with `/viz pos below` saved it draws only the prompt: switch to `/viz pos above` while you record.

## License

MIT
