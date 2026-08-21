# Configuration

Options go in the `options` field of the plugin's `cli.json` entry.

The plugin always loads. An unknown key, or a value of the wrong type, falls back to the default; a number outside its range is clamped to the nearest limit.

| Option          | Default  | Range                       | Description                                                                                                              |
| --------------- | -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `display`       | `"both"` | `both` \| `tokens` \| `tps` | Which parts of the label to show.                                                                                        |
| `refreshHz`     | `8`      | 1–60                        | How often the label updates while a session streams.                                                                     |
| `bytesPerToken` | `4.75`   | 1–16                        | Bytes per token used for live and partial-output estimates. Completed steps use OpenCode's reported token usage instead. |
| `debug`         | `false`  | —                           | Writes a debug log.                                                                                                      |

One extra rule:

- `debug` only accepts `true`. Anything else leaves logging off.

## Example

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

For where the debug log lands, see [Debug logging](development.md#debug-logging).
