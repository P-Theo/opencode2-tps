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
  "plugins": [{ "package": "/absolute/path/to/tps.tsx", "options": { "debug": true } }]
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
- It counts the output bytes of a run and estimates tokens from the byte total, at 5 bytes per token.
- Each gap between two outputs is capped, so time spent in a tool call never counts as active time.
- The live rate comes from a rolling window. When the window holds nothing recent, the label shows the average of the run so far.
- A single timer draws the label, and it only runs while a session streams.
- A finished run keeps its state until the next run replaces it, and the number of tracked sessions is bounded. See `MAX_TRACKED_RUNS` in `tps.tsx`.
- A generation guard makes sure only the newest generation of the plugin counts tokens and renders.

For the event names and the formulas, read `tps.tsx`.

## Release

Publishing is a separate flow. See [Release](release.md).
