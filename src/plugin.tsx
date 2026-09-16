/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Show } from "solid-js"
import { configureDebug, isEnvEnabled, mark } from "./debug.js"
import { TpsTracker } from "./tracker.js"
import { formatLabel, resolveOptions } from "./options.js"

// ---------------------------------------------------------------------------
// plugin

// Event payloads are taken from the SDK's own union (via the non-generic
// `data.listen` signature) rather than restated structurally: handlers are
// contravariant, so hand-written shapes keep typechecking after a field rename.
type PluginContext = Parameters<Plugin.Definition["setup"]>[0]

type AnyEvent = Parameters<Parameters<PluginContext["data"]["listen"]>[0]>[0]["details"]

type EventOf<Type extends AnyEvent["type"]> = Extract<AnyEvent, { type: Type }>

type DeltaEvent = EventOf<"session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta">

type BlockStartedEvent = EventOf<
  "session.text.started" | "session.reasoning.started" | "session.tool.input.started"
>

type BlockEndedEvent = EventOf<"session.text.ended" | "session.reasoning.ended" | "session.tool.input.ended">

type FinishEvent = EventOf<
  "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted" | "session.idle"
>

type StepStartedEvent = EventOf<"session.step.started">

type StepStreamedEvent = EventOf<"session.step.streamed">

type StepFinishedEvent = EventOf<"session.step.ended" | "session.step.failed">

function blockID(e: DeltaEvent | BlockStartedEvent | BlockEndedEvent): string {
  if (e.type === "session.tool.input.delta" || e.type === "session.tool.input.started" || e.type === "session.tool.input.ended")
    return `tool:${e.data.id}`

  return `${e.type.startsWith("session.text.") ? "text" : "reasoning"}:${e.data.ordinal}`
}

const definition: Plugin.Definition = {
  id: "opencode2.tps",
  setup(ctx) {
    // Generation guard: the host may start a new generation of this plugin
    // without disposing the previous one (observed on server (re)attach), and
    // hot reload shares `storage.memory` across generations. Only the newest
    // generation may count tokens or render.
    const [gen, setGen] = ctx.storage.memory("generation", { initial: { active: 0 } })
    const mine = gen.active + 1
    setGen((d) => {
      d.active = mine
    })
    const isActive = () => gen.active === mine

    const options = resolveOptions(ctx.options)
    configureDebug(options.debug || isEnvEnabled(process.env["TPS_DEBUG"]))

    const tracker = new TpsTracker(options)
    const [version, setVersion] = createSignal(0)
    const seenEventIDs = new Set<string>()

    const isNewEvent = (e: AnyEvent): boolean => {
      if (seenEventIDs.has(e.id)) return false
      seenEventIDs.add(e.id)

      if (seenEventIDs.size > 4_096) {
        const oldest = seenEventIDs.values().next().value

        if (oldest !== undefined) seenEventIDs.delete(oldest)
      }

      return true
    }

    mark(`setup ok app=${ctx.app.version} gen=${mine} display=${options.display} refreshHz=${options.refreshHz}`)

    // Rendering is throttled: deltas arrive at 100-200/s, and every bump costs
    // a memo recompute plus a terminal repaint to move a number no one can read
    // faster than ~10 Hz. Handlers only set a flag; the timer does the work,
    // and it only runs while a session is actually streaming.
    let dirty = false
    let timer: ReturnType<typeof setInterval> | undefined

    const flush = () => {
      // A superseded generation stops ticking even if its cleanup never ran.
      if (!isActive()) {
        stopTimer()

        return
      }

      const running = tracker.hasRunning(Date.now())

      // The observable live rate decays only through a short stale tail. Opaque
      // provider work after that is not charged to a numerator we cannot see.
      if (dirty || running) {
        dirty = false
        setVersion((v) => v + 1)
      }

      if (!running) stopTimer()
    }

    function stopTimer(): void {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }

    const touch = () => {
      dirty = true

      if (timer !== undefined) return
      timer = setInterval(flush, Math.round(1000 / options.refreshHz))
      timer.unref?.()
    }

    const onDelta = (e: DeltaEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.push(e.data.sessionID, e.data.delta, e.created, e.data.assistantMessageID, blockID(e))
      touch()
    }

    const onBlockStarted = (e: BlockStartedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.beginBlock(e.data.sessionID, e.data.assistantMessageID, blockID(e), e.created)
    }

    const onBlockEnded = (e: BlockEndedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.finishBlock(e.data.sessionID, e.data.assistantMessageID, blockID(e), e.data.text, e.created)
      touch()
    }

    const onFinish = (e: FinishEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.finish(e.data.sessionID, e.created)
      touch()
    }

    const onStepStarted = (e: StepStartedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.beginStep(e.data.sessionID, e.data.assistantMessageID, e.created)
      touch()
    }

    const onStepStreamed = (e: StepStreamedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.markStreamed(e.data.sessionID, e.data.assistantMessageID, e.created)
      touch()
    }

    const onStepFinished = (e: StepFinishedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      const tokens = e.data.tokens

      const generatedTokens =
        tokens !== undefined &&
        Number.isFinite(tokens.output) &&
        tokens.output >= 0 &&
        Number.isFinite(tokens.reasoning) &&
        tokens.reasoning >= 0
          ? tokens.output + tokens.reasoning
          : undefined

      tracker.finishStep(
        e.data.sessionID,
        e.data.assistantMessageID,
        generatedTokens,
        e.created,
      )
      touch()
    }

    const unsubs = [
      ctx.data.on("session.execution.started", (e) => {
        if (!isActive() || !isNewEvent(e)) return
        tracker.beginRun(e.data.sessionID)
        touch()
      }),
      ctx.data.on("session.text.delta", onDelta),
      ctx.data.on("session.reasoning.delta", onDelta),
      ctx.data.on("session.tool.input.delta", onDelta),
      ctx.data.on("session.text.started", onBlockStarted),
      ctx.data.on("session.reasoning.started", onBlockStarted),
      ctx.data.on("session.tool.input.started", onBlockStarted),
      ctx.data.on("session.text.ended", onBlockEnded),
      ctx.data.on("session.reasoning.ended", onBlockEnded),
      ctx.data.on("session.tool.input.ended", onBlockEnded),
      ctx.data.on("session.step.started", onStepStarted),
      ctx.data.on("session.step.streamed", onStepStreamed),
      ctx.data.on("session.step.ended", onStepFinished),
      ctx.data.on("session.step.failed", onStepFinished),
      ctx.data.on("session.execution.succeeded", onFinish),
      ctx.data.on("session.execution.failed", onFinish),
      ctx.data.on("session.execution.interrupted", onFinish),
      ctx.data.on("session.idle", onFinish),
      ctx.data.on("session.deleted", (e) => {
        if (!isActive() || !isNewEvent(e)) return
        tracker.evict(e.data.sessionID)
        touch()
      }),
    ]

    const unslot = ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        const label = createMemo(() => {
          version()

          if (!isActive()) return null
          const v = tracker.value(input.sessionID, Date.now())

          if (!v) return null

          return formatLabel(v, options.display)
        })

        return (
          <Show when={label()}>
            {(text: () => string) => (
              <box width="100%" flexDirection="row" justifyContent="flex-end">
                <text fg={ctx.theme.text.subdued}>{`${text()} `}</text>
              </box>
            )}
          </Show>
        )
      },
    })

    return () => {
      for (const unsub of unsubs) unsub()
      unslot()
      stopTimer()

      if (gen.active === mine)
        setGen((d) => {
          d.active = 0
        })
      mark(`cleanup ok gen=${mine}`)
    }
  },
}

export default definition
