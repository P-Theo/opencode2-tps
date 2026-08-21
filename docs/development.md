# Development

## Setup

```sh
npm ci          # install dependencies
npm run lint    # oxlint
npm run check   # tsc --noEmit
npm test        # bun test
npm run build   # write dist/tui.js
```

## Run from source

Point a path entry in `cli.json` at the source file. The host watches it and reloads the plugin whenever you save `tps.tsx`.

```json
{
  "plugins": [
    { "package": "/absolute/path/to/tps.tsx", "options": { "debug": true } }
  ]
}
```

`package` takes an absolute path, a `file://` URL, or a relative path that starts with `./` or `../` and resolves against the directory holding `cli.json`. Anything else is read as a package name.

The host also picks up plugins from a `plugin` or `plugins` directory in the config directory, but those receive no options, so use a path entry when you need them.

## Build

The host only applies the Solid transform outside `node_modules`, and an installed package lives inside it, so `build.mjs` runs the transform ahead of time and writes `dist/tui.js`. See `build.mjs` and the `exports` and `files` fields in `package.json`.

`solid-js` and `@opentui/solid` are optional peer dependencies; the host supplies its own copies.

## Debug logging

Logging is off by default. Two ways to turn it on:

- `"debug": true` in the options of the `cli.json` entry.
- `TPS_DEBUG=1` or `TPS_DEBUG=true` in the TUI's environment. Use this when the host gives the plugin no options.

The log lands in `<tmpdir>/tps-debug-<pid>/tps.log`. The directory is created with mode 0700, because the log records session IDs. If the name is already taken, the plugin reuses it only when it is a real directory rather than a symlink, has mode 0700, and belongs to your user; otherwise it falls back to `tps-debug-<pid>-XXXXXX`.

That means one directory and one log per PID. Hot reloads append to the same file, and so does a later process that the OS hands the same PID — the timestamps tell them apart.

## Architecture

- The plugin listens to session events to start a run, end a run, and collect the model's output.
- It estimates live tokens from observable UTF-8 bytes at 4.75 bytes per token by default. Complete block values reconcile buffered or missed deltas.
- Live TPS is a bounded rolling rate over observable deltas. Its denominator stops after a short stale tail because silence may be encrypted reasoning or buffered tool input rather than inactivity.
- A completed model step reports exact generated usage as `tokens.output + tokens.reasoning`. This replaces that step's byte estimate.
- Settled TPS sums exact step tokens and divides once by the sum of observed step spans. Each span runs from `session.step.started` to the final `session.text.ended`, `session.reasoning.ended`, or `session.tool.input.ended` boundary. Delayed step settlement, local tool execution, and time between model steps are excluded.
- TPS remains approximate because the host does not expose token-level provider timestamps. Encrypted content, signatures, and other opaque provider state are never byte-counted.
- A single timer draws the label, and it stops after the live stale tail or when a step settles.
- A finished run keeps its state until the next run replaces it, and the number of tracked sessions is bounded. See `MAX_TRACKED_RUNS` in `tps.tsx`.
- A generation guard makes sure only the newest generation of the plugin counts tokens and renders.

For the event names and the formulas, read `tps.tsx`.

## Example run

One user prompt becomes a stream of events; the tracker does the bookkeeping below for each step.

| What happens                                       | Event                                             | Tracker action                                                                                               |
| -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A new user prompt starts a run                     | `session.execution.started`                       | reset settled tokens, observed duration, and partial state                                                   |
| The model begins a step of generation              | `session.step.started` (m1)                       | record the step timestamp and assistant-message ID                                                           |
| An output block begins                             | `session.*.started` (m1)                          | create an idempotent text, reasoning, or tool-input block                                                    |
| Observable output streams                          | `session.*.delta` (m1)                            | add UTF-8 bytes and a rolling-rate sample                                                                    |
| The complete block becomes available               | `session.*.ended` (m1)                            | reconcile its full byte count and record the model-content boundary                                          |
| The model step settles, possibly after a tool runs | `session.step.ended` / `failed` (m1)              | replace the estimate with reported usage when available; add duration only through the last content boundary |
| The whole execution finishes                       | `session.execution.succeeded` / `failed` / `idle` | freeze exact settled tokens plus any explicitly estimated partial output                                     |

OpenCode beta versions may omit `session.tool.input.delta` entirely and provide only the complete `session.tool.input.ended` text. Newer versions may stream both. Ended-value reconciliation supports both without double-counting.

## Release

Publishing is a separate flow. See [Release](release.md).
