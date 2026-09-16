# opencode2-tps

Live token-throughput indicator for the OpenCode 2 TUI prompt composer.

While a session streams, the top right of the composer shows estimated observable tokens and throughput: `~1712 tok · ~51.5 t/s`

When OpenCode reports terminal usage, the token count becomes exact while TPS remains approximate, for example `1715 tok · ~51.5 t/s`. The result freezes until the next run starts. Nothing is shown on the home screen, or before the first observable output.

<p align="center">
  <img src="docs/screenshots/opencode2_tps.png" width="750" alt="Composer showing live token-throughput indicator" />
</p>

## Install

Built against the OpenCode 2 preview. The earliest known compatible beta is `0.0.0-beta-17595`. The TUI plugin API is still moving, so a much newer or older build may drop the indicator without an error. If the figure never appears, check your version first, then [open an issue](https://github.com/P-Theo/opencode2-tps/issues).

Install it with the CLI's plugin command, which adds the entry to `~/.config/opencode/cli.json` for you:

```sh
opencode2 plugin add opencode2-tps
```

Or add the package to `~/.config/opencode/cli.json` yourself:

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

A running TUI picks up `cli.json` changes immediately. On first use it installs the package into its own cache under `~/.cache/opencode/npm/` on Linux — one millisecond-timestamped generation per spec, for example `opencode2-tps@latest/<generation>/`, with the newest generation winning.

The host reuses the newest installed generation without contacting the registry, so a restart alone may not pick up a new release. Delete the spec's cache directory and restart to upgrade:

```sh
rm -rf ~/.cache/opencode/npm/opencode2-tps@latest
```

Put the range in the entry to pin a version instead — `"opencode2-tps@0.1.0"`. Every distinct entry gets its own cache directory.

The plugin ID is `opencode2.tps`. Add `"-opencode2.tps"` after it to switch it off without losing the entry and its options:

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

The plugin estimates tokens from observable UTF-8 bytes at a default of 4.75 bytes per token and calculates a bounded rolling delivery rate while output streams. Complete text, reasoning, and tool-input events reconcile buffered or missed deltas without creating artificial live-rate spikes.

OpenCode's reported output and reasoning usage replaces the byte estimate at the end of each model step. Settled TPS divides those exact tokens by observed step spans ending at `session.step.streamed`, the host's authoritative end of the model stream, published before local tools join. Hosts that do not publish the event fall back to the final model-content boundary. Either way, local tool execution and time between model calls are excluded.

OpenCode's built-in assistant-footer t/s divides visible output tokens by the same step spans, leaving hidden reasoning out of its numerator. This plugin counts output plus reasoning, so on reasoning models its settled figure reads higher than the built-in one — those tokens were generated too.

TPS is always approximate (`~`) because OpenCode does not expose token-level timestamps. Proprietary reasoning may be encrypted or represented only by a short summary, and some providers buffer tool arguments until completion. During those opaque intervals the live rate holds or becomes unavailable instead of continuously falling. Opaque provider state is never counted by byte length.

For more detail, see [Architecture](docs/development.md#architecture).

## Sub-agents

Every output event carries the ID of the session that produced it, so each session is measured on its own.

A sub-agent streams under its own child session ID. The orchestrator's number stops moving while it works and holds the average of the output the orchestrator produced before delegating. Open the sub-agent's session to watch its live throughput.

<p align="center">
  <img src="docs/screenshots/subagent_tps.png" width="750" alt="Sub-agent session showing its own live throughput indicator" />
</p>

## Development

To work on the plugin, see [Development](docs/development.md). To publish a new version, see [Release](docs/release.md).

## License

MIT — see [LICENSE](LICENSE).
