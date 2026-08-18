# opencode2-tps (OpenCode V2 TUI plugin)

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

Single self-contained source file (`tps.tsx`): V2 TUI discovery loads direct
files from `plugins/tui/`, so the tracker, slot claim, and plugin definition all
live together. The SDK is used type-only; the default export is structural.

### Known limitation

Sub-agent (task tool) output streams under the child session's ID, so during a
sub-agent turn the parent session shows its run-so-far average rather than live
throughput.

## Install

Add the package to `~/.config/opencode/cli.json` and restart the TUI. There is
no separate install step: OpenCode fetches package entries itself into
`~/.cache/opencode/packages/`.

```json
{
  "plugins": ["opencode2-tps"]
}
```

Use the object form to pass options:

```json
{
  "plugins": [
    { "package": "opencode2-tps", "options": { "display": "tps", "refreshHz": 12 } }
  ]
}
```

A running TUI re-reads `cli.json` when it changes, so adding, removing or
re-pointing the entry takes effect without a restart. Changing the *version* of
an installed package does need one, because no watched file changed.

The plugin id is `opencode2.tps`; disable it without removing the entry by
adding `"-opencode2.tps"` after it.

## Configuration

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
npm ci          # pinned dev deps (typecheck + JSX runtime resolution)
npm run lint    # oxlint + the vendored anti-slop plugin (tools/oxlint/anti-slop)
npm run check   # tsc --noEmit, including the test file
npm test        # bun test: tracker, option parsing, setup wiring
npm run build   # dist/tui.js, the published entrypoint
```

### Running against a live TUI

Point `cli.json` at the source file. `package` accepts an absolute path, a
`file://` URL, or a path relative to `cli.json`, and the host watches the target
even outside its config directory: saving `tps.tsx` runs the plugin's cleanup and
re-runs `setup` in every open TUI, with no restart.

```json
{
  "plugins": [{ "package": "/absolute/path/to/tps.tsx", "options": { "debug": true } }]
}
```

Auto-discovery from `~/.config/opencode/plugins/tui/` (a copy or symlink) also
hot-reloads, but discovered files receive no options — the host only passes
`options` for an explicit `cli.json` entry — so prefer the path entry above.
Discovery is still the simplest way to load `slotprobe.tsx`, which takes none.

### Verifying the published artifact

The path entry above loads `tps.tsx` and lets the host apply its Solid
transform; an installed package instead loads the pre-built `dist/tui.js` from
inside `node_modules`, where the host applies no transform (see below). The two
are different code paths, so a working dev loop says nothing about the tarball.
Install the pack output and point `cli.json` at the result to exercise the real
one:

```sh
npm pack --pack-destination /tmp
mkdir -p /tmp/tps-verify && cd /tmp/tps-verify && npm init -y
npm i /tmp/opencode2-tps-<version>.tgz
# cli.json: { "package": "/tmp/tps-verify/node_modules/opencode2-tps/dist/tui.js" }
```

That covers the bundle. Registry resolution and the `exports` subpath are only
covered by a real install, so publish a prerelease
(`npm publish --tag next` from a `-rc.N` version), install it by specifier, and
promote the release version once it checks out. Prereleases never become
`latest`.

### Why the package ships compiled JS

Solid needs a compile-time transform; JSX left to a runtime `jsx()` factory
renders once and never updates. The host applies that transform (via
`@opentui/solid`'s Bun plugin) only to files **outside** `node_modules`, and an
installed package always lives inside one — so `npm run build` runs the same
Babel presets ahead of time and `dist/tui.js` is what gets published.

`solid-js` and `@opentui/solid` are optional peer dependencies, not
dependencies: the host injects its own copies into external plugins, and the
plugin must share them to stay on one reactive graph and one renderer.
Declaring them as real dependencies would add ~95 MB of never-loaded modules to
every install.

The `overrides` entry lifts `@opentui/solid`'s pinned `@babel/core@7.28.0` past
GHSA-4x5r-pxfx-6jf8. It is dev-only hygiene — the published bundle is built with
this repo's own top-level Babel and the package itself has no runtime
dependencies — but it keeps `npm audit` at zero so a real finding is not lost in
noise.

`slotprobe.tsx` is a dev-only utility, excluded from the tarball: it renders
labeled markers into candidate slots so placements can be inspected visually.
Load it by symlinking it into `~/.config/opencode/plugins/tui/`, and remove the
link afterwards.

Debug logging is off by default — an unconfigured install writes nothing to
disk. Enable it with the `debug` option, or with `TPS_DEBUG=1` in the TUI
process's environment when the plugin was auto-discovered and therefore got no
options (only `1` and `true` count, so `TPS_DEBUG=0` stays off). The log goes to
`<tmpdir>/tps-debug-<pid>/tps.log`, one directory per PID — a process keeps
appending across hot reloads, and a recycled PID appends after the previous
owner, so read the timestamps. The directory is created owner-only: the log
records session IDs, and a predictable path in a shared
temp directory is both readable by other local users and pre-emptable by a
symlink that `appendFileSync` would follow. If the name is already taken by
anything that is not our own private directory, the plugin logs into a fresh
`tps-debug-<pid>-XXXXXX` directory instead.

### Release

```sh
npm pack                  # runs lint + check + test + build via prepack
npm publish --tag next    # prerelease versions only, for install verification
npm publish               # release, after the prerelease checks out
```

The published tarball is `dist/tui.js`, `package.json` and this README —
`exports["./tui"]` is what the host resolves for a package entry.
