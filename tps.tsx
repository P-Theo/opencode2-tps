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
    const safeLine = line.replace(/\p{Cc}/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    appendFileSync(debugState.file, `${new Date().toISOString()} ${safeLine}\n`)
  } catch {
    // debug only; never break the host
  }
}

// ---------------------------------------------------------------------------
// tuning

export interface TpsConfig {
  readonly bytesPerToken: number // live and partial-output estimate only
}

export const DEFAULT_CONFIG: TpsConfig = {
  bytesPerToken: 4.75,
}
// The frozen final average stays visible until the next prompt starts a new run.

const BYTES_PER_TOKEN_MIN = 1
const BYTES_PER_TOKEN_MAX = 16
const LIVE_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const LIVE_MIN_DURATION_MS = 250

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
  readonly tps: number | null
  readonly tokens: number
  readonly tokensEstimated: boolean
  readonly partial: boolean
}

interface LiveSample {
  readonly bytes: number
  readonly timestamp: number
}

interface OutputBlock {
  streamedBytes: number
  finalBytes: number | null
}

interface StepState {
  readonly assistantMessageID: string
  readonly startedAt: number
  lastBoundaryAt: number | null
  observableBytes: number
  readonly blocks: Map<string, OutputBlock>
  readonly samples: LiveSample[]
}

interface RunState {
  phase: "running" | "ended"
  settledTokens: number
  settledDurationMs: number
  tokensEstimated: boolean
  partial: boolean
  activeStep: StepState | null
  readonly settledSteps: Set<string>
  frozen: Frozen | null
}

export interface TpsValue {
  readonly tps: number | null
  readonly tokens: number
  readonly frozen: boolean
  readonly tokensEstimated: boolean
  readonly tpsEstimated: true
  readonly partial: boolean
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
      st = {
        phase: "ended",
        settledTokens: 0,
        settledDurationMs: 0,
        tokensEstimated: false,
        partial: false,
        activeStep: null,
        settledSteps: new Set(),
        frozen: null,
      }
      this.runs.set(sessionID, st)
    }
    return st
  }

  beginRun(sessionID: string): void {
    const st = this.state(sessionID)
    st.phase = "running"
    st.settledTokens = 0
    st.settledDurationMs = 0
    st.tokensEstimated = false
    st.partial = false
    st.activeStep = null
    st.settledSteps.clear()
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

  private ensureStep(sessionID: string, assistantMessageID: string, now: number, replace = false): StepState | null {
    const st = this.state(sessionID)
    if (st.settledSteps.has(assistantMessageID) || (st.phase === "ended" && st.frozen !== null)) return null
    if (st.phase !== "running") this.beginRun(sessionID)
    const running = this.state(sessionID)
    if (running.activeStep?.assistantMessageID === assistantMessageID) return running.activeStep
    if (running.activeStep && !replace) return null
    if (running.activeStep) this.settleActiveStep(running, undefined)
    const step: StepState = {
      assistantMessageID,
      startedAt: now,
      lastBoundaryAt: null,
      observableBytes: 0,
      blocks: new Map(),
      samples: [],
    }
    running.activeStep = step
    running.frozen = null
    return step
  }

  beginStep(sessionID: string, assistantMessageID: string, now = Date.now()): void {
    const st = this.state(sessionID)
    if (st.phase !== "running") {
      if (st.settledSteps.has(assistantMessageID)) return
      this.beginRun(sessionID)
    }
    if (st.activeStep?.assistantMessageID === assistantMessageID) return
    this.ensureStep(sessionID, assistantMessageID, now, true)
  }

  beginBlock(sessionID: string, assistantMessageID: string, blockID: string, now: number): void {
    const step = this.ensureStep(sessionID, assistantMessageID, now)
    if (!step) return
    if (!step.blocks.has(blockID)) step.blocks.set(blockID, { streamedBytes: 0, finalBytes: null })
  }

  push(
    sessionID: string,
    delta: string,
    now: number,
    assistantMessageID = "implicit",
    blockID = "implicit",
  ): void {
    if (!delta) return
    const step = this.ensureStep(sessionID, assistantMessageID, now)
    if (!step) return
    let block = step.blocks.get(blockID)
    if (!block) {
      block = { streamedBytes: 0, finalBytes: null }
      step.blocks.set(blockID, block)
    }
    if (block.finalBytes !== null) return
    const bytes = Buffer.byteLength(delta, "utf8")
    block.streamedBytes += bytes
    step.observableBytes += bytes
    step.samples.push({ bytes, timestamp: now })
    const oldest = now - LIVE_WINDOW_MS
    while (step.samples[0] && step.samples[0].timestamp < oldest) step.samples.shift()
  }

  finishBlock(
    sessionID: string,
    assistantMessageID: string,
    blockID: string,
    text: string,
    now: number,
  ): void {
    const st = this.runs.get(sessionID)
    const step = st?.activeStep
    if (!step || step.assistantMessageID !== assistantMessageID) return
    let block = step.blocks.get(blockID)
    if (!block) {
      block = { streamedBytes: 0, finalBytes: null }
      step.blocks.set(blockID, block)
    }
    if (block.finalBytes !== null) return
    block.finalBytes = Buffer.byteLength(text, "utf8")
    step.observableBytes += block.finalBytes - block.streamedBytes
    step.lastBoundaryAt = Math.max(step.lastBoundaryAt ?? now, now)
  }

  private settleActiveStep(st: RunState, generatedTokens: number | undefined): void {
    const step = st.activeStep
    if (!step) return
    const exact = generatedTokens !== undefined && Number.isFinite(generatedTokens) && generatedTokens >= 0
    st.settledTokens += exact ? generatedTokens : estimateTokens(step.observableBytes, this.config.bytesPerToken)
    if (!exact) {
      st.tokensEstimated = true
      st.partial = true
    }
    if (step.lastBoundaryAt !== null) st.settledDurationMs += Math.max(0, step.lastBoundaryAt - step.startedAt)
    st.settledSteps.add(step.assistantMessageID)
    st.activeStep = null
  }

  finishStep(sessionID: string, assistantMessageID: string, generatedTokens: number | undefined, _now: number): void {
    const st = this.runs.get(sessionID)
    if (st?.activeStep?.assistantMessageID !== assistantMessageID) return
    this.settleActiveStep(st, generatedTokens)
  }

  finish(sessionID: string, _now: number): void {
    const st = this.runs.get(sessionID)
    if (!st || st.phase === "ended") return
    if (st.activeStep) this.settleActiveStep(st, undefined)
    st.phase = "ended"
    const tokens = st.settledTokens
    if (tokens <= 0) {
      this.evictStale()
      return
    }
    const tps = st.settledDurationMs > 0 ? tokens / (st.settledDurationMs / 1000) : null
    st.frozen = { tps, tokens, tokensEstimated: st.tokensEstimated, partial: st.partial }
    mark(`finish sid=${sessionID} tokens=${tokens} observedMs=${st.settledDurationMs} tps=${tps?.toFixed(1) ?? "n/a"}`)
    this.evictStale()
  }

  private dropSession(sessionID: string): void {
    this.runs.delete(sessionID)
  }

  evict(sessionID: string): void {
    this.dropSession(sessionID)
  }

  hasRunning(now = Date.now()): boolean {
    for (const st of this.runs.values()) {
      const last = st.activeStep?.samples.at(-1)
      if (st.phase === "running" && last && now < last.timestamp + LIVE_STALE_MS) return true
    }
    return false
  }

  private liveTps(step: StepState, now: number): number | null {
    const last = step.samples.at(-1)
    if (!last) return null
    const effectiveNow = Math.min(now, last.timestamp + LIVE_STALE_MS)
    const oldest = effectiveNow - LIVE_WINDOW_MS
    const samples = step.samples.filter((sample) => sample.timestamp >= oldest)
    const first = samples[0]
    if (!first) return null
    const bytes = samples.reduce((total, sample) => total + sample.bytes, 0)
    const durationMs = Math.max(effectiveNow - first.timestamp, LIVE_MIN_DURATION_MS)
    return estimateTokens(bytes, this.config.bytesPerToken) / (durationMs / 1000)
  }

  value(sessionID: string, now: number): TpsValue | null {
    const st = this.runs.get(sessionID)
    if (!st) return null
    if (st.frozen)
      return {
        ...st.frozen,
        frozen: true,
        tpsEstimated: true,
      }
    if (st.phase !== "running") return null
    const active = st.activeStep
    const activeTokens = active ? estimateTokens(active.observableBytes, this.config.bytesPerToken) : 0
    const tokens = st.settledTokens + activeTokens
    if (tokens <= 0) return null
    const settledTps = st.settledDurationMs > 0 ? st.settledTokens / (st.settledDurationMs / 1000) : null
    return {
      tps: active ? (this.liveTps(active, now) ?? settledTps) : settledTps,
      tokens,
      frozen: false,
      tokensEstimated: st.tokensEstimated || active !== null,
      tpsEstimated: true,
      partial: st.partial,
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
  const tokens = `${value.tokensEstimated ? "~" : ""}${value.tokens} tok`
  const tps = value.tps === null ? null : `~${formatTps(value.tps)} t/s`
  if (display === "tokens") return tokens
  if (display === "tps") return tps ?? "— t/s"
  return tps === null ? tokens : `${tokens} · ${tps}`
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
type BlockStartedEvent = EventOf<
  "session.text.started" | "session.reasoning.started" | "session.tool.input.started"
>
type BlockEndedEvent = EventOf<"session.text.ended" | "session.reasoning.ended" | "session.tool.input.ended">
type FinishEvent = EventOf<
  "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted" | "session.idle"
>
type StepStartedEvent = EventOf<"session.step.started">
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
