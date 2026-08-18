# opencode2-tps

Live token-throughput indicator for the OpenCode 2 TUI prompt composer.

While a session streams, the top right of the composer shows the estimated tokens and the throughput of the current run:

```text
1712 tok · 51.5 t/s
```

When the run ends, the number freezes at the run average and stays there until the next run starts. Nothing is shown on the home screen, or before the first token of a run.

## Install

Built against the OpenCode 2 preview. The earliest known compatible beta is `0.0.0-beta-17595`; the latest tested beta is `0.0.0-beta-17595`. The TUI plugin API is still moving, so a much newer or older build may drop the indicator without an error: a renamed event stops arriving, and an unknown composer slot gets quietly rerouted. If the figure never appears, check your CLI version first.

Add the package to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode2-tps"]
}
```

To set options, use the object form:

```json
{
  "plugins": [
    {
      "package": "opencode2-tps",
      "options": { "display": "tps", "refreshHz": 12 }
    }
  ]
}
```

A running TUI picks up `cli.json` changes immediately. On first use it installs the package into its own cache, `~/.cache/opencode/packages/opencode2-tps/` on Linux.

That cache is keyed on the entry text and is never refreshed once it exists, so a restart alone will not pick up a new release. To upgrade, delete the directory and restart:

```sh
rm -rf ~/.cache/opencode/packages/opencode2-tps
```

To pin a version instead, put the range in the entry — `"opencode2-tps@0.1.0"`. Every distinct entry gets its own cache directory.

The plugin ID is `opencode2.tps`. To switch it off without losing the entry and its options, add `"-opencode2.tps"` after it:

```json
{
  "plugins": [
    {
      "package": "opencode2-tps",
      "options": { "display": "tps", "refreshHz": 12 }
    },
    "-opencode2.tps"
  ]
}
```

## Configuration

The defaults are usable as they are. For the full option list, the ranges and more examples, see [Configuration](docs/configuration.md).

## How it works

The plugin counts the output bytes of a run and estimates tokens from the byte total. It also accumulates the run's active time, capping each gap between two outputs, so time spent in a tool call is not charged to the model's rate.

The live figure comes from a rolling window over recent output. When that window holds nothing recent, the indicator falls back to the average of the run so far.

For more detail, see [Architecture](docs/development.md#architecture).

## Sub-agents

Every output event carries the ID of the session that produced it, so each session is measured on its own.

A sub-agent streams under its own child session ID. While it works, the orchestrator's number stops moving and holds the average of the output the orchestrator produced before delegating. Open the sub-agent's session to watch its live throughput.

## Development

To work on the plugin, see [Development](docs/development.md). To publish a new version, see [Release](docs/release.md).

## License

MIT — see [LICENSE](LICENSE).
