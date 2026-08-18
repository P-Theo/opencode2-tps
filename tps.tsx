/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, Show } from "solid-js"
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// debug
//
// Off unless asked for: an unconfigured install must never touch disk.
//
// The log goes inside an owner-only directory instead of straight into the
// shared temp directory. A guessable path there (the PID is a small, enumerable
// number) can be pre-created by another local user as a symlink, which
// appendFileSync would happily follow into a file of their choosing; a
// world-readable log would also hand them the session IDs it records.

export const DEBUG_DIR_PREFIX = "tps-debug-"

const debugState = { enabled: false, file: "" }

/** True only for a real directory that belongs to us and to no one else. */
function isOwnPrivateDir(path: string): boolean {
  try {
    const stats = lstatSync(path) // lstat, not stat: a planted symlink must not pass
    if (!stats.isDirectory()) return false
    const uid = process.getuid?.()
    // Windows has no uid and a per-user temp directory, so there is nothing to check.
    if (uid === undefined) return true
    return stats.uid === uid && (stats.mode & 0o777) === 0o700
  } catch {
    return false
  }
}

/**
 * The 0700 directory to log into. Named after the PID so the process's own hot
 * reloads keep appending to one file, and only reused when it really is ours —
 * anything else squatting on the name gets sidestepped via mkdtemp.
 */
function debugDir(): string {
  const preferred = join(tmpdir(), `${DEBUG_DIR_PREFIX}${process.pid}`)
  try {
    mkdirSync(preferred, { mode: 0o700 })
    return preferred
  } catch {
    if (isOwnPrivateDir(preferred)) return preferred
    return mkdtempSync(`${preferred}-`)
  }
}

function configureDebug(enabled: boolean): void {
  debugState.enabled = enabled
  if (!enabled || debugState.file) return
  try {
    debugState.file = join(debugDir(), "tps.log")
  } catch {
    debugState.enabled = false // no usable temp directory: stay silent
  }
}

/** Truthy spellings only: `TPS_DEBUG=0` must not start writing to disk. */
export function isEnvEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true"
}

function mark(line: string): void {
  if (!debugState.enabled) return
  try {
    appendFileSync(debugState.file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // debug only; never break the host
  }
}

// ---------------------------------------------------------------------------
// tuning

const BYTES_PER_TOKEN = 5

export interface TpsConfig {
  readonly sampleWindowMs: number // rolling window for live TPS
  readonly liveStaleMs: number // no delta for this long => fall back to the run average
  readonly singleSampleMinMs: number
  readonly singleSampleMaxMs: number
  readonly tailMaxMs: number // capped trailing gap after the last sample
  readonly gapCapMs: number // inter-delta gaps count at most this long (excludes tool time)
}

export const DEFAULT_CONFIG: TpsConfig = {
  sampleWindowMs: 5_000,
  liveStaleMs: 1_500,
  singleSampleMinMs: 250,
  singleSampleMaxMs: 1_000,
  tailMaxMs: 1_000,
  gapCapMs: 2_000,
}
// The frozen final average stays visible until the next prompt starts a new run.

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN)
}

function formatTps(value: number): string {
  if (value < 10) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return Math.round(value).toString()
}

// ---------------------------------------------------------------------------
// tracker (UI-free)

interface StreamSample {
  readonly bytes: number
  readonly timestamp: number
}

interface Frozen {
  readonly tps: number
  readonly tokens: number
}

interface RunState {
  phase: "running" | "ended"
  samples: StreamSample[]
  bytes: number // raw output bytes this run (tokens are derived from the total)
  activeMs: number // accumulated streaming wall-clock (gaps capped)
  lastSampleAt: number | null
  frozen: Frozen | null
}

export interface TpsValue {
  readonly tps: number
  readonly tokens: number
  readonly frozen: boolean
}

// A finished run keeps its frozen average indefinitely (it is what the composer
// still shows), so the map is bounded instead: past this many tracked sessions,
// the least recently started *finished* runs are dropped. Running ones are never
// touched. Entries are tiny, so this is hygiene for a long-lived TUI, not a
// memory fix.
const MAX_TRACKED_RUNS = 64

export class TpsTracker {
  // Insertion order is kept equal to run-start recency (see beginRun), which is
  // what makes eviction from the front drop the stalest session.
  private readonly runs = new Map<string, RunState>()
  private readonly config: TpsConfig

  constructor(config: TpsConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  private state(sessionID: string): RunState {
    let st = this.runs.get(sessionID)
    if (!st) {
      st = { phase: "ended", samples: [], bytes: 0, activeMs: 0, lastSampleAt: null, frozen: null }
      this.runs.set(sessionID, st)
    }
    return st
  }

  beginRun(sessionID: string): void {
    const st = this.state(sessionID)
    st.phase = "running"
    st.samples = []
    st.bytes = 0
    st.activeMs = 0
    st.lastSampleAt = null
    st.frozen = null
    // Re-insert so this session becomes the newest in iteration order. Every
    // entry is created through here, so the cap is checked on the one path that
    // can grow the map.
    this.runs.delete(sessionID)
    this.runs.set(sessionID, st)
    this.evictStale()
  }

  private evictStale(): void {
    if (this.runs.size <= MAX_TRACKED_RUNS) return
    for (const [sessionID, st] of this.runs) {
      if (this.runs.size <= MAX_TRACKED_RUNS) return
      if (st.phase === "running") continue
      this.runs.delete(sessionID)
    }
  }

  push(sessionID: string, delta: string, now: number): void {
    if (!delta) return
    const st = this.state(sessionID)
    if (st.phase !== "running") this.beginRun(sessionID) // execution.started missed
    st.frozen = null
    // Bytes accumulate; tokens are derived from the run total, so providers
    // that emit 1-3 byte deltas are not rounded up on every single one.
    const bytes = Buffer.byteLength(delta, "utf8")
    st.samples.push({ bytes, timestamp: now })
    st.bytes += bytes
    // The first sample of a run contributes no elapsed time; the floor is
    // applied once, where the average is computed.
    if (st.lastSampleAt !== null) st.activeMs += Math.min(Math.max(0, now - st.lastSampleAt), this.config.gapCapMs)
    st.lastSampleAt = now
  }

  finish(sessionID: string, now: number): void {
    const st = this.runs.get(sessionID)
    if (!st || st.phase === "ended") return
    st.phase = "ended"
    if (st.lastSampleAt !== null) {
      st.activeMs += Math.min(Math.max(0, now - st.lastSampleAt), this.config.tailMaxMs)
      st.lastSampleAt = null
    }
    const tokens = estimateTokens(st.bytes)
    if (tokens <= 0) {
      this.runs.delete(sessionID)
      return
    }
    const seconds = Math.max(st.activeMs, this.config.singleSampleMinMs) / 1000
    st.frozen = { tps: tokens / seconds, tokens }
    st.samples = []
    mark(`finish sid=${sessionID} tokens=${tokens} activeMs=${st.activeMs} tps=${st.frozen.tps.toFixed(1)}`)
  }

  evict(sessionID: string): void {
    this.runs.delete(sessionID)
  }

  hasRunning(): boolean {
    for (const st of this.runs.values()) if (st.phase === "running") return true
    return false
  }

  // Throughput over the rolling window, or -1 when the window holds nothing
  // recent enough to be called "live".
  private live(st: RunState, now: number): number {
    const cutoff = now - this.config.sampleWindowMs
    const active = st.samples.filter((s) => s.timestamp >= cutoff)
    const last = active.at(-1)
    const first = active[0]
    if (!last || !first || now - last.timestamp > this.config.liveStaleMs) return -1
    let bytes = 0
    for (const s of active) bytes += s.bytes
    const tokens = bytes / BYTES_PER_TOKEN
    let durationMs: number
    if (active.length < 2) {
      durationMs = Math.max(
        this.config.singleSampleMinMs,
        Math.min(now - first.timestamp, this.config.singleSampleMaxMs),
      )
    } else {
      // Gaps are capped exactly as in push(): a pause for tool execution must
      // not be charged to the model's throughput.
      let gaps = 0
      let prev = first.timestamp
      for (const s of active) {
        gaps += Math.min(Math.max(0, s.timestamp - prev), this.config.gapCapMs)
        prev = s.timestamp
      }
      gaps += Math.min(now - last.timestamp, this.config.tailMaxMs)
      durationMs = Math.max(gaps, this.config.singleSampleMinMs)
    }
    return (tokens / durationMs) * 1000
  }

  value(sessionID: string, now: number): TpsValue | null {
    const st = this.runs.get(sessionID)
    if (!st) return null
    if (st.frozen) return { tps: st.frozen.tps, tokens: st.frozen.tokens, frozen: true }
    if (st.phase !== "running") return null
    const tokens = estimateTokens(st.bytes)
    if (tokens <= 0) return null
    const live = this.live(st, now)
    if (live >= 0) return { tps: live, tokens, frozen: false }
    // Live window empty (long tool call, sub-agent turn): keep showing the
    // run-so-far average instead of blanking. It uses the same elapsed-time
    // formula finish() will use, so freezing does not make the number jump.
    const tail = st.lastSampleAt === null ? 0 : Math.min(Math.max(0, now - st.lastSampleAt), this.config.tailMaxMs)
    const seconds = Math.max(st.activeMs + tail, this.config.singleSampleMinMs) / 1000
    return { tps: tokens / seconds, tokens, frozen: false }
  }

  prune(now: number): void {
    const cutoff = now - this.config.sampleWindowMs
    for (const st of this.runs.values()) {
      // Finished runs keep their frozen average until the next run replaces
      // them, so only the live sample window needs trimming.
      const oldest = st.samples[0]
      if (oldest && oldest.timestamp < cutoff) st.samples = st.samples.filter((s) => s.timestamp >= cutoff)
    }
  }
}

// ---------------------------------------------------------------------------
// options
//
// `ctx.options` is host-supplied JSON (Record<string, any>), so this is a real
// parsing boundary: every value is validated and clamped, and anything invalid
// falls back to the default rather than propagating NaN into the arithmetic.

const DISPLAY_MODES = ["both", "tokens", "tps"] as const
export type DisplayMode = (typeof DISPLAY_MODES)[number]

/**
 * A value as it can arrive from `cli.json`: arbitrary JSON, nothing more.
 * Named so the option boundary has a real input contract to validate against.
 */
export type OptionValue = string | number | boolean | null | readonly OptionValue[] | { readonly [key: string]: OptionValue }

/** The option surface, exactly as documented in the README, before validation. */
export interface TpsOptionsInput {
  readonly display?: OptionValue
  readonly refreshHz?: OptionValue
  readonly sampleWindowMs?: OptionValue
  readonly liveStaleMs?: OptionValue
  readonly singleSampleMinMs?: OptionValue
  readonly singleSampleMaxMs?: OptionValue
  readonly tailMaxMs?: OptionValue
  readonly gapCapMs?: OptionValue
  readonly debug?: OptionValue
}

export interface TpsOptions extends TpsConfig {
  readonly display: DisplayMode
  readonly refreshHz: number
  readonly debug: boolean
}

export const DEFAULT_OPTIONS: TpsOptions = {
  ...DEFAULT_CONFIG,
  display: "both",
  refreshHz: 8,
  debug: false,
}

function isFiniteNumber(value: OptionValue | undefined): value is number {
  return Number.isFinite(value)
}

function isDisplayMode(value: OptionValue | undefined): value is DisplayMode {
  return DISPLAY_MODES.some((mode) => mode === value)
}

function clampNumber(value: OptionValue | undefined, fallback: number, min: number, max: number): number {
  if (!isFiniteNumber(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

export function resolveOptions(raw: TpsOptionsInput): TpsOptions {
  const singleSampleMinMs = clampNumber(raw.singleSampleMinMs, DEFAULT_OPTIONS.singleSampleMinMs, 50, 5_000)
  return {
    display: isDisplayMode(raw.display) ? raw.display : DEFAULT_OPTIONS.display,
    refreshHz: clampNumber(raw.refreshHz, DEFAULT_OPTIONS.refreshHz, 1, 60),
    sampleWindowMs: clampNumber(raw.sampleWindowMs, DEFAULT_OPTIONS.sampleWindowMs, 1_000, 60_000),
    liveStaleMs: clampNumber(raw.liveStaleMs, DEFAULT_OPTIONS.liveStaleMs, 250, 30_000),
    singleSampleMinMs,
    // The ceiling can never sit below the floor, whatever the user wrote.
    singleSampleMaxMs: Math.max(
      singleSampleMinMs,
      clampNumber(raw.singleSampleMaxMs, DEFAULT_OPTIONS.singleSampleMaxMs, 50, 10_000),
    ),
    tailMaxMs: clampNumber(raw.tailMaxMs, DEFAULT_OPTIONS.tailMaxMs, 0, 10_000),
    gapCapMs: clampNumber(raw.gapCapMs, DEFAULT_OPTIONS.gapCapMs, 100, 30_000),
    debug: raw.debug === true,
  }
}

export function formatLabel(value: TpsValue, display: DisplayMode): string {
  if (display === "tokens") return `${value.tokens} tok`
  if (display === "tps") return `${formatTps(value.tps)} t/s`
  return `${value.tokens} tok · ${formatTps(value.tps)} t/s`
}

// ---------------------------------------------------------------------------
// plugin

// Event payloads are taken from the SDK's own union (via the non-generic
// `data.listen` signature) rather than restated structurally: handlers are
// contravariant, so hand-written shapes keep typechecking after a field rename.
type PluginContext = Parameters<Plugin.Definition["setup"]>[0]
type AnyEvent = Parameters<Parameters<PluginContext["data"]["listen"]>[0]>[0]["details"]
type EventOf<Type extends AnyEvent["type"]> = Extract<AnyEvent, { type: Type }>

type DeltaEvent = EventOf<"session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta">
type FinishEvent = EventOf<
  "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted" | "session.idle"
>

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
      const now = Date.now()
      tracker.prune(now)
      const running = tracker.hasRunning()
      // While running, the label is a function of `now` (window ageing, tail
      // gap), so it is republished every tick regardless of new deltas.
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
      if (!isActive()) return
      tracker.push(e.data.sessionID, e.data.delta, Date.now())
      touch()
    }
    const onFinish = (e: FinishEvent) => {
      if (!isActive()) return
      tracker.finish(e.data.sessionID, Date.now())
      touch()
    }

    const unsubs = [
      ctx.data.on("session.execution.started", (e) => {
        if (!isActive()) return
        tracker.beginRun(e.data.sessionID)
        touch()
      }),
      ctx.data.on("session.text.delta", onDelta),
      ctx.data.on("session.reasoning.delta", onDelta),
      // Tool arguments are model output too: without this the indicator blanks
      // partway through every large write/edit while generation is at full rate.
      ctx.data.on("session.tool.input.delta", onDelta),
      ctx.data.on("session.execution.succeeded", onFinish),
      ctx.data.on("session.execution.failed", onFinish),
      ctx.data.on("session.execution.interrupted", onFinish),
      ctx.data.on("session.idle", onFinish),
      ctx.data.on("session.deleted", (e) => {
        if (!isActive()) return
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
