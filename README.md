# toolbox.tps (OpenCode V2 TUI plugin)

Live token-throughput indicator for the OpenCode 2 prompt composer.

While a session streams, the composer top edge (far right) shows estimated
output throughput and accumulated output tokens for the current run:

```text
41 tok · 6.97 t/s
```

When the run finishes (or is interrupted), the display freezes to the run's
average and keeps it on screen until the next prompt starts a new run (same
label, no suffix):

```text
112 tok · 3.83 t/s
```

It renders nothing while a session is generating its very first tokens and on
the home screen. It claims the `session.composer.top` slot, right-anchored, so
it stays clear of the crowded prompt-footer status row.

## How it works

- Subscribes to the V2 event stream: `session.text.delta`,
  `session.reasoning.delta` and `session.tool.input.delta` feed a five-second
  rolling window; `session.execution.*` and `session.idle` bracket a run;
  `session.deleted` drops a session's state. Tool arguments are counted because
  they are model output too — the indicator stays live throughout a large
  `write`/`edit` call.
- Tokens are estimated as UTF-8 bytes / 5 over the run's byte total, so
  providers that emit one- to three-byte deltas are not rounded up on each one.
- Pauses do not drag the number down: every inter-delta gap counts for at most
  `gapCapMs` (2 s), both in the rolling window and in the run total, so tool
  execution time is excluded from throughput.
- When the rolling window has nothing recent (long tool call, sub-agent turn)
  the display falls back to the run-so-far average instead of blanking. It uses
  the same elapsed-time formula as the frozen value, so the number does not
  jump when the run ends.
- The average is always the estimate, never provider-reported usage: observed
  routers report output counts that diverge heavily from what actually streamed
  on screen.
- Rendering is throttled to `refreshHz` (8 Hz by default) via a single timer
  that only runs while a session is streaming; event handlers just set a dirty
  flag.
- Generation guard via `ctx.storage.memory`: the host may start a new plugin
  generation without disposing the previous one; only the newest counts and
  renders.

Single self-contained file (`tps.tsx`): V2 TUI discovery loads direct files
from `plugins/tui/`, so the tracker, slot claim, and plugin definition all live
together. The SDK is used type-only; the default export is structural.

### Known limitation

Sub-agent (task tool) output streams under the child session's ID, so during a
sub-agent turn the parent session shows its run-so-far average rather than live
throughput.

## Install

Install it as a symlink leaf:

```sh
mkdir -p ~/.config/opencode/plugins/tui
ln -sfn "$PWD/tps.tsx" ~/.config/opencode/plugins/tui/tps.tsx
```

The V2 TUI discovers `~/.config/opencode/plugins/tui/tps.tsx` on start and
hot-reloads it on edit.

## Configuration

Discovered files receive no options — the host only passes `options` for an
explicit `cli.json` entry. To configure the plugin, replace the symlink with a
`plugins` entry in `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    { "package": "/absolute/path/to/tps.tsx", "options": { "display": "tps", "refreshHz": 12 } }
  ]
}
```

| Option | Default | Range | Meaning |
|---|---|---|---|
| `display` | `"both"` | `both` \| `tokens` \| `tps` | Which halves of the label to render |
| `refreshHz` | `8` | 1–60 | Visible update rate while streaming |
| `sampleWindowMs` | `5000` | 1000–60000 | Rolling window for the live rate |
| `liveStaleMs` | `1500` | 250–30000 | Silence after which the run average is shown instead |
| `gapCapMs` | `2000` | 100–30000 | Longest inter-delta gap charged to throughput |
| `tailMaxMs` | `1000` | 0–10000 | Longest trailing gap after the last delta |
| `singleSampleMinMs` | `250` | 50–5000 | Duration floor (also the single-sample floor) |
| `singleSampleMaxMs` | `1000` | 50–10000 | Single-sample duration ceiling |
| `debug` | `false` | — | Write a debug log (see below) |

Unknown, non-numeric or out-of-range values fall back to the default; the
plugin never fails to load because of a bad option.

## Development

```sh
npm ci          # pinned dev/runtime deps (typecheck + JSX runtime resolution)
npm run check   # tsc --noEmit, including the test file
npm test        # bun test: tracker, option parsing, setup wiring
```

`slotprobe.tsx` is a dev-only utility (not linked by the installer): it renders
labeled markers into candidate slots so placements can be inspected visually.
Link it manually into `~/.config/opencode/plugins/tui/` to use it, and remove
the link afterwards.

Debug logging is off by default — an unconfigured install writes nothing to
disk. Enable it with the `debug` option, or with `TPS_DEBUG=1` in the TUI
process's environment when running from the symlink install. The log goes to
`<tmpdir>/tps-debug-<pid>.log`.
