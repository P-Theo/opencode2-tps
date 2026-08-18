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

- Subscribes to the V2 event stream: `session.text.delta` and
  `session.reasoning.delta` feed a five-second rolling window of estimated
  tokens (UTF-8 bytes / 5, minimum 1 per delta); `session.execution.*` and
  `session.idle` bracket a run; `session.tool.input.started` resets the live
  window so tool pauses do not drag the average.
- The frozen average uses the estimate, not provider-reported usage: observed
  routers report output counts that diverge heavily from what actually streamed
  on screen, and the frozen number should be continuous with the live one.
  Provider usage (`session.usage.updated`) is still logged in debug mode for
  comparison.
- Generation guard via `ctx.storage.memory`: the host may start a new plugin
  generation without disposing the previous one; only the newest counts and
  renders.

Single self-contained file (`tps.tsx`): V2 TUI discovery loads direct files
from `plugins/tui/`, so the tracker, slot claim, and plugin definition all live
together. The SDK is used type-only; the default export is structural.

## Install

Install it as a symlink leaf:

```sh
mkdir -p ~/.config/opencode/plugins/tui
ln -sfn "$PWD/tps.tsx" ~/.config/opencode/plugins/tui/tps.tsx
```

The V2 TUI discovers `~/.config/opencode/plugins/tui/tps.tsx` on start and
hot-reloads it on edit.

## Development

```sh
npm ci          # pinned dev/runtime deps (typecheck + JSX runtime resolution)
npm run check   # tsc --noEmit
bun test        # TpsTracker unit tests
```

`slotprobe.tsx` is a dev-only utility (not linked by the installer): it renders
labeled markers into candidate slots so placements can be inspected visually.
Link it manually into `~/.config/opencode/plugins/tui/` to use it, and remove
the link afterwards.

Debug logging: set `TPS_DEBUG=1` for the TUI process. Setup/cleanup lines are
always written; usage and finish probes require the flag. Log file:
`/tmp/tps-debug.log`.
