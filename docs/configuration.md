# Configuration

Options go in the `options` field of the plugin's `cli.json` entry.

The plugin always loads. An unknown key, or a value of the wrong type, falls back to the default; a number outside its range is clamped to the nearest limit.

| Option | Default | Range | Description |
|---|---|---|---|
| `display` | `"both"` | `both` \| `tokens` \| `tps` | Which parts of the label to show. |
| `refreshHz` | `8` | 1–60 | How often the label updates while a session streams. |
| `sampleWindowMs` | `5000` | 1000–60000 | Length of the rolling window behind the live rate. |
| `liveStaleMs` | `1500` | 250–30000 | How long output can stay silent before the label falls back to the run average. |
| `gapCapMs` | `2000` | 100–30000 | Most that a single gap between two outputs can add to active time. |
| `tailMaxMs` | `1000` | 0–10000 | Most that the time after the last output can add to active time. |
| `singleSampleMinMs` | `250` | 50–5000 | Floor on the duration a rate is divided by. |
| `singleSampleMaxMs` | `1000` | 50–10000 | Ceiling on that duration when the window holds a single sample. |
| `debug` | `false` | — | Writes a debug log. |

Two extra rules:

- `singleSampleMaxMs` is never allowed below `singleSampleMinMs`. Set it lower and `singleSampleMinMs` wins.
- `debug` only accepts `true`. Anything else leaves logging off.

## Example

```json
{
  "plugins": [
    { "package": "opencode2-tps", "options": { "display": "tps", "refreshHz": 12 } }
  ]
}
```

For where the debug log lands, see [Debug logging](development.md#debug-logging).
