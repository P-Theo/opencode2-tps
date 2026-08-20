# Configuration

Options go in the `options` field of the plugin's `cli.json` entry.

The plugin always loads. An unknown key, or a value of the wrong type, falls back to the default; a number outside its range is clamped to the nearest limit.

| Option | Default | Range | Description |
|---|---|---|---|
| `display` | `"both"` | `both` \| `tokens` \| `tps` | Which parts of the label to show. |
| `refreshHz` | `8` | 1–60 | How often the label updates while a session streams. |
| `bytesPerToken` | `4.75` | 1–16 | Bytes per token used to estimate tokens from output bytes, until a session calibrates its own ratio (see below). |
| `debug` | `false` | — | Writes a debug log. |

One extra rule:

- `debug` only accepts `true`. Anything else leaves logging off.

## Calibration

The token count is an estimate: output bytes divided by `bytesPerToken`. When a model step completes, the host reports that step's real generated-token count. The plugin pairs it with output deltas carrying the same assistant-message ID and uses the first sufficiently large, plausible pair to calibrate a per-session ratio. Afterwards the estimate for that session uses its own measured ratio instead of `bytesPerToken`. If the step start was missed, the usage never arrives, or the implied ratio is implausible, that step is ignored and the configured fallback remains in use.

## Example

```json
{
  "plugins": [
    { "package": "opencode2-tps", "options": { "display": "tps", "refreshHz": 12 } }
  ]
}
```

For where the debug log lands, see [Debug logging](development.md#debug-logging).
