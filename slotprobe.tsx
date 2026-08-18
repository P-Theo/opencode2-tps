// Temporary slot-probe: inspect candidate placements for the TPS indicator.
// NOT installed by the toolbox installer; linked manually into
// ~/.config/opencode/plugins/tui/ and deleted (with the link) when done.
/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

const definition: Plugin.Definition = {
  id: "toolbox.tps.slotprobe",
  setup(ctx) {
    const subdued = ctx.theme.text.subdued
    const green = ctx.theme.text.feedback.success.default
    const info = ctx.theme.text.feedback.info.default

    const unslots = [
      // Priority candidate: far right of the composer top edge.
      ctx.ui.slot({
        append: "session.composer.top",
        render: () => (
          <box width="100%" flexDirection="row" justifyContent="flex-end">
            <text fg={green}>{`◆ session.composer.top (right) `}</text>
          </box>
        ),
      }),

      // Fallback: own line above the footer (kept for reference).
      ctx.ui.slot({
        before: "prompt.footer",
        render: () => <text fg={info}>{`◆ prompt.footer BEFORE`}</text>,
      }),

      // Fallback experiment: take over the status row, dropping the built-in
      // "tab switch agents" / "ctrl+p commands" reminders, and re-render the
      // directory + cost ourselves so nothing the user wants is lost.
      ctx.ui.slot({
        replace: "prompt.footer.status",
        render: (input) => {
          const text = createMemo(() => {
            const sid = input.sessionID
            if (!sid) return `◆ status (home)`
            const info = ctx.data.session.get(sid)
            const dir = info?.location?.directory ?? "?"
            const cost = ctx.data.session.cost(sid)
            return `${dir}  ·  $${cost.toFixed(2)}`
          })
          return <text fg={subdued}>{` ${text()}`}</text>
        },
      }),
    ]

    return () => {
      for (const unslot of unslots) unslot()
    }
  },
}

export default definition
