/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, Show } from "solid-js"
import { appendFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// debug

// setup/cleanup lines are unconditional (rare, useful); verbose probes require TPS_DEBUG=1.
const DEBUG = !!process.env.TPS_DEBUG
const DEBUG_LOG = "/tmp/tps-debug.log"

function mark(line: string, verbose = false): void {
  if (verbose && !DEBUG) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // debug only; never break the host
  }
}

// ---------------------------------------------------------------------------
// tuning

const SAMPLE_WINDOW_MS = 5_000 // rolling window for live TPS
const LIVE_STALE_MS = 1_500 // no delta for this long => not live
const SINGLE_SAMPLE_MIN_MS = 250
const SINGLE_SAMPLE_MAX_MS = 1_000
const TAIL_MAX_MS = 1_000 // capped trailing gap after the last sample
const GAP_CAP_MS = 2_000 // inter-delta gaps count at most this long (excludes tool time)
// The frozen final average stays visible until the next prompt starts a new run.

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 5))
}

function formatTps(value: number): string {
  if (value < 10) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return Math.round(value).toString()
}

// ---------------------------------------------------------------------------
// tracker (UI-free)

interface StreamSample {
  readonly tokens: number
  readonly timestamp: number
}

interface Frozen {
  readonly tps: number
  readonly tokens: number
}

interface RunState {
  phase: "running" | "ended"
  samples: StreamSample[]
  tokens: number // estimated output tokens this run
  activeMs: number // accumulated streaming wall-clock (gaps capped)
  lastSampleAt: number | null
  usageStart: number | null // exact cumulative output+reasoning tokens at run start
  usageEnd: number | null // latest exact cumulative during the run
  frozen: Frozen | null
}

interface TpsValue {
  readonly tps: number
  readonly tokens: number
  readonly frozen: boolean
}

export class TpsTracker {
  private readonly runs = new Map<string, RunState>()
  private readonly usage = new Map<string, number>() // last known exact cumulative per session

  private state(sessionID: string): RunState {
    let st = this.runs.get(sessionID)
    if (!st) {
      st = {
        phase: "ended",
        samples: [],
        tokens: 0,
        activeMs: 0,
        lastSampleAt: null,
        usageStart: null,
        usageEnd: null,
        frozen: null,
      }
      this.runs.set(sessionID, st)
    }
    return st
  }

  beginRun(sessionID: string): void {
    const st = this.state(sessionID)
    st.phase = "running"
    st.samples = []
    st.tokens = 0
    st.activeMs = 0
    st.lastSampleAt = null
    st.usageStart = this.usage.get(sessionID) ?? null
    st.usageEnd = null
    st.frozen = null
  }

  push(sessionID: string, delta: string, now: number): void {
    if (!delta) return
    const st = this.state(sessionID)
    if (st.phase !== "running") this.beginRun(sessionID) // execution.started missed
    st.frozen = null
    const tokens = estimateTokens(delta)
    st.samples.push({ tokens, timestamp: now })
    st.tokens += tokens
    if (st.lastSampleAt === null) st.activeMs += SINGLE_SAMPLE_MIN_MS
    else st.activeMs += Math.min(Math.max(0, now - st.lastSampleAt), GAP_CAP_MS)
    st.lastSampleAt = now
  }

  // Tool execution starts: text pauses, so reset the live window (not the run
  // totals) — post-tool streaming then resumes with fresh samples.
  clearLive(sessionID: string): void {
    const st = this.runs.get(sessionID)
    if (!st) return
    st.samples = []
    st.lastSampleAt = null
  }

  noteUsage(sessionID: string, cumulativeOutputTokens: number): void {
    this.usage.set(sessionID, cumulativeOutputTokens)
    const st = this.runs.get(sessionID)
    if (st && st.phase === "running") st.usageEnd = cumulativeOutputTokens
  }

  finish(sessionID: string, now: number): void {
    const st = this.runs.get(sessionID)
    if (!st || st.phase === "ended") return
    st.phase = "ended"
    if (st.lastSampleAt !== null) {
      st.activeMs += Math.min(Math.max(0, now - st.lastSampleAt), TAIL_MAX_MS)
      st.lastSampleAt = null
    }
    const exact =
      st.usageStart !== null && st.usageEnd !== null && st.usageEnd > st.usageStart
        ? st.usageEnd - st.usageStart
        : null
    // Display uses the estimate even when exact usage exists: providers (esp.
    // routers) report counts that diverge wildly from what actually streamed
    // on screen, and the frozen average should be continuous with the live one.
    const tokens = st.tokens
    if (tokens <= 0) {
      this.runs.delete(sessionID)
      return
    }
    const seconds = Math.max(st.activeMs, SINGLE_SAMPLE_MIN_MS) / 1000
    st.frozen = { tps: tokens / seconds, tokens }
    st.samples = []
    mark(
      `finish sid=${sessionID} est=${st.tokens} exact=${exact ?? "n/a"} activeMs=${st.activeMs} tps=${st.frozen.tps.toFixed(1)}`,
      true,
    )
  }

  private live(sessionID: string, now: number): number {
    const st = this.runs.get(sessionID)
    if (!st || st.phase !== "running") return -1
    const cutoff = now - SAMPLE_WINDOW_MS
    const active = st.samples.filter((s) => s.timestamp >= cutoff)
    const last = active.at(-1)
    if (!last || now - last.timestamp > LIVE_STALE_MS) return -1
    const totalTokens = active.reduce((sum, s) => sum + s.tokens, 0)
    let durationMs: number
    const first = active[0]
    if (!first) return -1
    if (active.length < 2) {
      durationMs = Math.max(SINGLE_SAMPLE_MIN_MS, Math.min(now - first.timestamp, SINGLE_SAMPLE_MAX_MS))
    } else {
      let gaps = 0
      let prev: StreamSample | undefined = first
      for (const s of active.slice(1)) {
        if (prev) gaps += Math.max(0, s.timestamp - prev.timestamp)
        prev = s
      }
      gaps += Math.min(now - last.timestamp, TAIL_MAX_MS)
      durationMs = Math.max(gaps, SINGLE_SAMPLE_MIN_MS)
    }
    return (totalTokens / durationMs) * 1000
  }

  value(sessionID: string, now: number): TpsValue | null {
    const st = this.runs.get(sessionID)
    if (!st) return null
    if (st.frozen) return { tps: st.frozen.tps, tokens: st.frozen.tokens, frozen: true }
    const tps = this.live(sessionID, now)
    if (tps < 0) return null
    return { tps, tokens: st.tokens, frozen: false }
  }

  prune(now: number): boolean {
    let changed = false
    const cutoff = now - SAMPLE_WINDOW_MS
    for (const [, st] of this.runs) {
      const pruned = st.samples.filter((s) => s.timestamp >= cutoff)
      if (pruned.length !== st.samples.length) {
        st.samples = pruned
        changed = true
      }
      // Finished runs keep their frozen average until the next run replaces
      // them, so there is nothing else to prune here.
    }
    return changed
  }
}

// ---------------------------------------------------------------------------
// plugin

const definition: Plugin.Definition = {
  id: "toolbox.tps",
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

    const tracker = new TpsTracker()
    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)

    mark(`setup ok app=${ctx.app.version} gen=${mine}`)

    const onDelta = (e: { data: { sessionID: string; delta: string } }) => {
      if (!isActive()) return
      tracker.push(e.data.sessionID, e.data.delta, Date.now())
      bump()
    }
    const onFinish = (e: { data: { sessionID: string } }) => {
      if (!isActive()) return
      tracker.finish(e.data.sessionID, Date.now())
      bump()
    }

    const unsubs = [
      ctx.data.on("session.execution.started", (e) => {
        if (!isActive()) return
        tracker.beginRun(e.data.sessionID)
        bump()
      }),
      ctx.data.on("session.text.delta", onDelta),
      ctx.data.on("session.reasoning.delta", onDelta),
      ctx.data.on("session.tool.input.started", (e) => {
        if (!isActive()) return
        tracker.clearLive(e.data.sessionID)
        bump()
      }),
      ctx.data.on("session.usage.updated", (e) => {
        if (!isActive()) return
        const exact = e.data.tokens.output + e.data.tokens.reasoning
        mark(`usage sid=${e.data.sessionID} output=${e.data.tokens.output} reasoning=${e.data.tokens.reasoning}`, true)
        tracker.noteUsage(e.data.sessionID, exact)
      }),
      ctx.data.on("session.execution.succeeded", onFinish),
      ctx.data.on("session.execution.failed", onFinish),
      ctx.data.on("session.execution.interrupted", onFinish),
      ctx.data.on("session.idle", onFinish),
    ]

    const timer = setInterval(() => {
      if (!isActive()) return
      tracker.prune(Date.now())
      bump()
    }, 1_000)

    const unslot = ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        const label = createMemo(() => {
          version()
          if (!isActive()) return null
          const v = tracker.value(input.sessionID, Date.now())
          if (!v) return null
          return `${v.tokens} tok · ${formatTps(v.tps)} t/s`
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
      clearInterval(timer)
      if (gen.active === mine)
        setGen((d) => {
          d.active = 0
        })
      mark(`cleanup ok gen=${mine}`)
    }
  },
}

export default definition
