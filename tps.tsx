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

export interface TpsConfig {
  readonly bytesPerToken: number // fallback ratio until a session calibrates its own
}

export const DEFAULT_CONFIG: TpsConfig = {
  bytesPerToken: 4.75,
}
// The frozen final average stays visible until the next prompt starts a new run.

// Step completion events carry the generated-token count for that model call.
// Pairing it with deltas from the same assistant message avoids contamination
// from concurrent title generation and other session-level usage updates.
export const CALIBRATION_MIN_BYTES = 2_048
export const CALIBRATION_MIN_TOKENS = 50
// Bounds shared by the option clamp and the calibration sanity check: a ratio
// outside them means the report does not describe the bytes the plugin watched.
const BYTES_PER_TOKEN_MIN = 1
const BYTES_PER_TOKEN_MAX = 16

function estimateTokens(bytes: number, bytesPerToken: number): number {
  return Math.ceil(bytes / bytesPerToken)
}

function formatTps(value: number): string {
  if (value < 10) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return Math.round(value).toString()
}

// ---------------------------------------------------------------------------
// tracker (UI-free)

interface Frozen {
  readonly tps: number
  readonly tokens: number
}

interface RunState {
  phase: "running" | "ended"
  bytes: number // raw output bytes this run (tokens are derived from the total)
  activeMs: number // time from first output to completion within model steps
  activeAssistantMessageID: string | null
  lastSampleAt: number | null
  activeTools: Set<string>
  toolPauseStartedAt: number | null
  toolPausedMs: number
  frozen: Frozen | null
}

interface CalibrationStep {
  readonly assistantMessageID: string
  bytes: number
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
  // Calibrated bytes/token and the currently observed model step. Both share
  // the bounded lifecycle of `runs`.
  private readonly ratios = new Map<string, number>()
  private readonly calibrationSteps = new Map<string, CalibrationStep>()
  private readonly config: TpsConfig

  constructor(config: TpsConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  private state(sessionID: string): RunState {
    let st = this.runs.get(sessionID)
    if (!st) {
      st = {
        phase: "ended",
        bytes: 0,
        activeMs: 0,
        activeAssistantMessageID: null,
        lastSampleAt: null,
        activeTools: new Set(),
        toolPauseStartedAt: null,
        toolPausedMs: 0,
        frozen: null,
      }
      this.runs.set(sessionID, st)
    }
    return st
  }

  beginRun(sessionID: string): void {
    const st = this.state(sessionID)
    this.calibrationSteps.delete(sessionID)
    st.phase = "running"
    st.bytes = 0
    st.activeMs = 0
    st.activeAssistantMessageID = null
    st.lastSampleAt = null
    st.activeTools.clear()
    st.toolPauseStartedAt = null
    st.toolPausedMs = 0
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
      this.dropSession(sessionID)
    }
  }

  private advanceTiming(st: RunState, now: number): void {
    if (st.lastSampleAt === null) return
    const currentPause = st.toolPauseStartedAt === null ? 0 : Math.max(0, now - st.toolPauseStartedAt)
    st.activeMs += Math.max(0, now - st.lastSampleAt - st.toolPausedMs - currentPause)
    st.lastSampleAt = now
    st.toolPausedMs = 0
    if (st.toolPauseStartedAt !== null) st.toolPauseStartedAt = now
  }

  push(sessionID: string, delta: string, now: number, assistantMessageID?: string): void {
    if (!delta) return
    const st = this.state(sessionID)
    if (st.phase !== "running") this.beginRun(sessionID) // execution.started missed
    st.frozen = null
    // Bytes accumulate; tokens are derived from the run total, so providers
    // that emit 1-3 byte deltas are not rounded up on every single one.
    const bytes = Buffer.byteLength(delta, "utf8")
    st.bytes += bytes
    const calibration = this.calibrationSteps.get(sessionID)
    if (calibration && calibration.assistantMessageID === assistantMessageID) calibration.bytes += bytes
    const stepID = assistantMessageID ?? ""
    if (st.activeAssistantMessageID !== stepID) {
      st.activeAssistantMessageID = stepID
      st.lastSampleAt = null
      st.activeTools.clear()
      st.toolPauseStartedAt = null
      st.toolPausedMs = 0
    }
    if (st.lastSampleAt === null) {
      st.lastSampleAt = now
      if (st.activeTools.size > 0) st.toolPauseStartedAt = now
    } else {
      this.advanceTiming(st, now)
    }
  }

  /** Start observing one model step for a possible one-shot calibration. */
  beginStep(sessionID: string, assistantMessageID: string): void {
    const st = this.runs.get(sessionID)
    if (!st || st.phase !== "running") this.beginRun(sessionID)
    const running = this.runs.get(sessionID)
    if (running) {
      running.activeAssistantMessageID = assistantMessageID
      running.lastSampleAt = null
      running.activeTools.clear()
      running.toolPauseStartedAt = null
      running.toolPausedMs = 0
    }
    if (this.ratios.has(sessionID)) return
    this.calibrationSteps.set(sessionID, { assistantMessageID, bytes: 0 })
  }

  /** Pair a completed step's usage with deltas from that assistant message. */
  finishStep(sessionID: string, assistantMessageID: string, generatedTokens: number | undefined, now: number): void {
    const st = this.runs.get(sessionID)
    if (st?.activeAssistantMessageID === assistantMessageID) {
      this.advanceTiming(st, now)
      st.activeAssistantMessageID = null
      st.lastSampleAt = null
      st.activeTools.clear()
      st.toolPauseStartedAt = null
      st.toolPausedMs = 0
    }
    const calibration = this.calibrationSteps.get(sessionID)
    if (!calibration || calibration.assistantMessageID !== assistantMessageID) return
    this.calibrationSteps.delete(sessionID)
    if (this.ratios.has(sessionID)) return
    if (generatedTokens === undefined || !Number.isFinite(generatedTokens) || generatedTokens < CALIBRATION_MIN_TOKENS)
      return
    const bytes = calibration.bytes
    if (bytes < CALIBRATION_MIN_BYTES) return
    const ratio = bytes / generatedTokens
    if (ratio < BYTES_PER_TOKEN_MIN || ratio > BYTES_PER_TOKEN_MAX) {
      mark(`calibration rejected sid=${sessionID} bytes=${bytes} tokens=${generatedTokens} ratio=${ratio.toFixed(2)}`)
      return
    }
    this.ratios.set(sessionID, ratio)
    mark(`calibrated sid=${sessionID} bytes=${bytes} tokens=${generatedTokens} ratio=${ratio.toFixed(2)}`)
  }

  beginTool(sessionID: string, assistantMessageID: string, toolID: string, now: number): void {
    const st = this.runs.get(sessionID)
    if (!st || st.activeAssistantMessageID !== assistantMessageID || st.activeTools.has(toolID)) return
    if (st.activeTools.size === 0 && st.lastSampleAt !== null) st.toolPauseStartedAt = now
    st.activeTools.add(toolID)
  }

  finishTool(sessionID: string, assistantMessageID: string, toolID: string, now: number): void {
    const st = this.runs.get(sessionID)
    if (st?.activeAssistantMessageID !== assistantMessageID || !st.activeTools.delete(toolID) || st.activeTools.size > 0)
      return
    if (st.toolPauseStartedAt !== null) st.toolPausedMs += Math.max(0, now - st.toolPauseStartedAt)
    st.toolPauseStartedAt = null
  }

  /** The session's calibrated ratio, or the configured fallback. */
  private ratioFor(sessionID: string): number {
    return this.ratios.get(sessionID) ?? this.config.bytesPerToken
  }

  finish(sessionID: string, now: number): void {
    const st = this.runs.get(sessionID)
    if (!st || st.phase === "ended") return
    this.calibrationSteps.delete(sessionID)
    st.phase = "ended"
    this.advanceTiming(st, now)
    st.lastSampleAt = null
    st.activeAssistantMessageID = null
    st.activeTools.clear()
    st.toolPauseStartedAt = null
    st.toolPausedMs = 0
    const tokens = estimateTokens(st.bytes, this.ratioFor(sessionID))
    if (tokens <= 0) {
      this.evictStale()
      return
    }
    const seconds = Math.max(st.activeMs, 1) / 1000
    st.frozen = { tps: tokens / seconds, tokens }
    mark(`finish sid=${sessionID} tokens=${tokens} activeMs=${st.activeMs} tps=${st.frozen.tps.toFixed(1)}`)
    this.evictStale()
  }

  private dropSession(sessionID: string): void {
    this.runs.delete(sessionID)
    this.ratios.delete(sessionID)
    this.calibrationSteps.delete(sessionID)
  }

  evict(sessionID: string): void {
    this.dropSession(sessionID)
  }

  hasRunning(): boolean {
    for (const st of this.runs.values()) {
      if (st.phase === "running" && st.activeAssistantMessageID !== null && st.lastSampleAt !== null) return true
    }
    return false
  }

  value(sessionID: string, now: number): TpsValue | null {
    const st = this.runs.get(sessionID)
    if (!st) return null
    if (st.frozen) return { tps: st.frozen.tps, tokens: st.frozen.tokens, frozen: true }
    if (st.phase !== "running") return null
    const tokens = estimateTokens(st.bytes, this.ratioFor(sessionID))
    if (tokens <= 0) return null
    const currentPause = st.toolPauseStartedAt === null ? 0 : Math.max(0, now - st.toolPauseStartedAt)
    const activeTail = st.lastSampleAt === null ? 0 : Math.max(0, now - st.lastSampleAt - st.toolPausedMs - currentPause)
    const seconds = Math.max(st.activeMs + activeTail, 1) / 1000
    return { tps: tokens / seconds, tokens, frozen: false }
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
  readonly bytesPerToken?: OptionValue
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
  return {
    display: isDisplayMode(raw.display) ? raw.display : DEFAULT_OPTIONS.display,
    refreshHz: clampNumber(raw.refreshHz, DEFAULT_OPTIONS.refreshHz, 1, 60),
    bytesPerToken: clampNumber(raw.bytesPerToken, DEFAULT_OPTIONS.bytesPerToken, BYTES_PER_TOKEN_MIN, BYTES_PER_TOKEN_MAX),
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
type StepStartedEvent = EventOf<"session.step.started">
type StepFinishedEvent = EventOf<"session.step.ended" | "session.step.failed">
type ToolStartedEvent = EventOf<"session.tool.called">
type ToolFinishedEvent = EventOf<"session.tool.success" | "session.tool.failed">

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
      const running = tracker.hasRunning()
      // While a model step is running, elapsed generation time changes even
      // without new deltas, so republish every tick to expose provider stalls.
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
      tracker.push(e.data.sessionID, e.data.delta, Date.now(), e.data.assistantMessageID)
      touch()
    }
    const onFinish = (e: FinishEvent) => {
      if (!isActive()) return
      tracker.finish(e.data.sessionID, Date.now())
      touch()
    }
    const onStepStarted = (e: StepStartedEvent) => {
      if (!isActive()) return
      tracker.beginStep(e.data.sessionID, e.data.assistantMessageID)
    }
    const onStepFinished = (e: StepFinishedEvent) => {
      if (!isActive()) return
      const tokens = e.data.tokens
      tracker.finishStep(
        e.data.sessionID,
        e.data.assistantMessageID,
        tokens === undefined ? undefined : tokens.output + tokens.reasoning,
        Date.now(),
      )
      touch()
    }
    const onToolStarted = (e: ToolStartedEvent) => {
      if (!isActive()) return
      tracker.beginTool(e.data.sessionID, e.data.assistantMessageID, e.data.id, Date.now())
    }
    const onToolFinished = (e: ToolFinishedEvent) => {
      if (!isActive()) return
      tracker.finishTool(e.data.sessionID, e.data.assistantMessageID, e.data.id, Date.now())
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
      ctx.data.on("session.step.started", onStepStarted),
      ctx.data.on("session.step.ended", onStepFinished),
      ctx.data.on("session.step.failed", onStepFinished),
      ctx.data.on("session.tool.called", onToolStarted),
      ctx.data.on("session.tool.success", onToolFinished),
      ctx.data.on("session.tool.failed", onToolFinished),
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
