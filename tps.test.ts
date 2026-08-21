import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import definition, {
  DEBUG_DIR_PREFIX,
  DEFAULT_OPTIONS,
  formatLabel,
  isEnvEnabled,
  resolveOptions,
  TpsTracker,
  type TpsOptionsInput,
} from "./tps.tsx"

// 50 ASCII bytes -> ceil(50/4.75) = 11 estimated tokens at the default ratio
const DELTA = "a".repeat(50)

describe("TpsTracker", () => {
  test("estimates live tokens from accumulated utf-8 bytes", () => {
    const tracker = new TpsTracker()
    for (let i = 0; i < 10; i += 1) tracker.push("s", "€", 1000 + i * 10)
    const value = tracker.value("s", 1090)
    expect(value?.tokens).toBe(7) // 30 bytes / 4.75
    expect(value?.tokensEstimated).toBe(true)
    expect(value?.tps).not.toBeNull()
  })

  test("honours a custom live bytes-per-token ratio", () => {
    const tracker = new TpsTracker({ ...DEFAULT_OPTIONS, bytesPerToken: 5 })
    tracker.push("s", DELTA, 1000)
    expect(tracker.value("s", 1000)?.tokens).toBe(10)
  })

  test("caps silent live-rate decay when output becomes opaque", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 1000)
    expect(tracker.value("s", 2000)?.tps).toBeCloseTo(11)
    expect(tracker.value("s", 3000)?.tps).toBeCloseTo(11 / 1.5)
    expect(tracker.value("s", 30_000)?.tps).toBeCloseTo(11 / 1.5)
  })

  test("reconciles buffered tool input without inventing a live spike", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 1000)
    tracker.beginBlock("s", "m1", "tool:t1", 1100)
    tracker.finishBlock("s", "m1", "tool:t1", "a".repeat(95), 2000)
    const live = tracker.value("s", 2000)
    expect(live?.tokens).toBe(20)
    expect(live?.tps).toBeNull()
    tracker.finishStep("s", "m1", 42, 7000)
    tracker.finish("s", 8000)
    expect(tracker.value("s", 8000)).toMatchObject({ tokens: 42, tokensEstimated: false, partial: false })
    expect(tracker.value("s", 8000)?.tps).toBeCloseTo(42)
  })

  test("does not double-count streamed tool input at its final boundary", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.push("s", "a".repeat(50), 100, "m1", "tool:t1")
    tracker.push("s", "b".repeat(50), 200, "m1", "tool:t1")
    tracker.finishBlock("s", "m1", "tool:t1", "a".repeat(50) + "b".repeat(50), 500)
    expect(tracker.value("s", 500)?.tokens).toBe(22)
  })

  test("reconciles missing and excess streamed bytes to the final value", () => {
    const short = new TpsTracker()
    short.beginStep("s", "m1", 0)
    short.push("s", "a".repeat(50), 100, "m1", "text:0")
    short.finishBlock("s", "m1", "text:0", "a".repeat(100), 500)
    expect(short.value("s", 500)?.tokens).toBe(22)

    const long = new TpsTracker()
    long.beginStep("s", "m1", 0)
    long.push("s", "a".repeat(100), 100, "m1", "text:0")
    long.finishBlock("s", "m1", "text:0", "a".repeat(50), 500)
    expect(long.value("s", 500)?.tokens).toBe(11)
  })

  test("uses exact terminal usage for hidden-only reasoning", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 1000)
    tracker.beginBlock("s", "m1", "reasoning:0", 1200)
    tracker.finishBlock("s", "m1", "reasoning:0", "", 3000)
    tracker.finishStep("s", "m1", 300, 9000)
    tracker.finish("s", 10_000)
    const value = tracker.value("s", 10_000)
    expect(value).toMatchObject({ tokens: 300, tokensEstimated: false, frozen: true })
    expect(value?.tps).toBeCloseTo(150)
  })

  test("terminal usage replaces both upward and downward estimates", () => {
    for (const exact of [5, 100]) {
      const tracker = new TpsTracker()
      tracker.beginStep("s", "m1", 0)
      tracker.push("s", "a".repeat(95), 100, "m1", "text:0")
      tracker.finishBlock("s", "m1", "text:0", "a".repeat(95), 1000)
      expect(tracker.value("s", 1000)?.tokens).toBe(20)
      tracker.finishStep("s", "m1", exact, 5000)
      expect(tracker.value("s", 5000)?.tokens).toBe(exact)
      expect(tracker.value("s", 5000)?.tokensEstimated).toBe(false)
    }
  })

  test("weights multiple steps by total tokens and observed duration", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", "first", 1000)
    tracker.finishStep("s", "m1", 100, 9000)
    tracker.beginStep("s", "m2", 20_000)
    tracker.finishBlock("s", "m2", "text:0", "second", 23_000)
    tracker.finishStep("s", "m2", 50, 30_000)
    tracker.finish("s", 40_000)
    expect(tracker.value("s", 40_000)?.tps).toBeCloseTo(150 / 4)
  })

  test("excludes delayed step settlement, tool execution, and time between steps", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "tool:t1", "{}", 500)
    tracker.finishStep("s", "m1", 50, 10_000)
    tracker.beginStep("s", "m2", 30_000)
    tracker.finishBlock("s", "m2", "text:0", "done", 31_000)
    tracker.finishStep("s", "m2", 50, 40_000)
    tracker.finish("s", 50_000)
    expect(tracker.value("s", 50_000)?.tps).toBeCloseTo(100 / 1.5)
  })

  test("holds the settled average while a new step has no live samples", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", "done", 1000)
    tracker.finishStep("s", "m1", 20, 2000)
    tracker.beginStep("s", "m2", 3000)

    expect(tracker.value("s", 3500)?.tps).toBeCloseTo(20)
    tracker.finishBlock("s", "m2", "tool:t1", "a".repeat(95), 4000)
    expect(tracker.value("s", 10_000)?.tps).toBeCloseTo(20)
  })

  test("failed steps without usage remain estimated and partial", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.finishStep("s", "m1", undefined, 2000)
    tracker.finish("s", 3000)
    expect(tracker.value("s", 3000)).toMatchObject({ tokens: 11, tokensEstimated: true, partial: true })
  })

  test("failed steps with usage settle exactly", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.finishStep("s", "m1", 17, 2000)
    tracker.finish("s", 3000)
    expect(tracker.value("s", 3000)).toMatchObject({ tokens: 17, tokensEstimated: false, partial: false })
  })

  test("an interrupted active step freezes a partial estimate", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.finish("s", 2000)
    expect(tracker.value("s", 2000)).toMatchObject({ tokens: 11, tokensEstimated: true, partial: true, frozen: true })
  })

  test("reports unavailable TPS rather than inventing a zero-duration denominator", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 1000)
    tracker.finishStep("s", "m1", 80, 5000)
    tracker.finish("s", 6000)
    expect(tracker.value("s", 6000)).toMatchObject({ tokens: 80, tps: null, tokensEstimated: false })
  })

  test("step and boundary settlement are idempotent", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.beginStep("s", "m1", 500)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.finishBlock("s", "m1", "text:0", DELTA + DELTA, 2000)
    tracker.finishStep("s", "m1", 20, 3000)
    tracker.finishStep("s", "m1", 20, 4000)
    tracker.finish("s", 5000)
    expect(tracker.value("s", 5000)?.tokens).toBe(20)
    expect(tracker.value("s", 5000)?.tps).toBeCloseTo(20)
  })

  test("ignores late and mismatched deltas", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.push("s", DELTA, 500, "other", "text:0")
    tracker.beginBlock("s", "other", "text:0", 600)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.push("s", DELTA, 1100, "m1", "text:0")
    tracker.finishBlock("s", "other", "text:0", DELTA + DELTA, 1200)
    expect(tracker.value("s", 1200)?.tokens).toBe(11)
  })

  test("does not resurrect or double-settle a completed step", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.finishStep("s", "m1", 20, 2000)
    tracker.push("s", DELTA, 3000, "m1", "text:1")
    tracker.finishBlock("s", "m1", "text:1", DELTA, 4000)
    tracker.finishStep("s", "m1", 20, 5000)
    tracker.finish("s", 6000)
    expect(tracker.value("s", 6000)?.tokens).toBe(20)
    expect(tracker.value("s", 6000)?.tps).toBeCloseTo(20)

    tracker.beginStep("s", "m1", 6500)
    tracker.push("s", DELTA, 7000, "other", "text:0")
    expect(tracker.value("s", 7000)?.frozen).toBe(true)
  })

  test("renders nothing before any output or usage", () => {
    const tracker = new TpsTracker()
    tracker.beginRun("s")
    expect(tracker.value("s", 1000)).toBeNull()
  })

  test("keeps the frozen average until the next run", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 100)
    tracker.finishStep("s", "m1", 12, 200)
    tracker.finish("s", 200)
    const frozen = tracker.value("s", 201)
    expect(frozen?.frozen).toBe(true)
    expect(frozen?.tokens).toBe(12)
    // still frozen long after finishing — no time-based expiry
    expect(tracker.value("s", 200 + 60_000)?.frozen).toBe(true)
    // next prompt starts a new run and clears the frozen average
    tracker.beginRun("s")
    expect(tracker.value("s", 200 + 60_001)).toBeNull()
  })

  test("starts a run and step implicitly when lifecycle events were missed", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 1000)
    expect(tracker.value("s", 1000)).not.toBeNull()
  })

  test("a new run clears the frozen snapshot", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.finish("s", 100)
    expect(tracker.value("s", 101)?.frozen).toBe(true)
    tracker.beginRun("s")
    expect(tracker.value("s", 102)).toBeNull()
  })

  test("isolates sessions", () => {
    const tracker = new TpsTracker()
    tracker.push("a", DELTA, 1000)
    expect(tracker.value("b", 1000)).toBeNull()
    tracker.finish("a", 1100)
    expect(tracker.value("a", 60_000)?.frozen).toBe(true)
    expect(tracker.value("b", 60_000)).toBeNull()
  })

  test("evicts a session's state", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.finish("s", 100)
    expect(tracker.value("s", 101)).not.toBeNull()
    tracker.evict("s")
    expect(tracker.value("s", 101)).toBeNull()
  })

  test("reports streaming only while the live stale tail can change", () => {
    const tracker = new TpsTracker()
    expect(tracker.hasRunning()).toBe(false)
    tracker.push("s", DELTA, 0)
    expect(tracker.hasRunning(1000)).toBe(true)
    expect(tracker.hasRunning(2500)).toBe(false)
    tracker.finish("s", 100)
    expect(tracker.hasRunning()).toBe(false)
  })

  test("ignores empty deltas", () => {
    const tracker = new TpsTracker()
    tracker.push("s", "", 1000)
    expect(tracker.value("s", 1000)).toBeNull()
  })

  test("caps how many finished runs it remembers, keeping the recent ones", () => {
    const tracker = new TpsTracker()
    // 65 sessions, each one run: the first started is the first forgotten.
    for (let i = 0; i < 65; i += 1) {
      tracker.push(`s${i}`, DELTA, i * 10)
      tracker.finish(`s${i}`, i * 10 + 100)
    }
    expect(tracker.value("s0", 10_000)).toBeNull()
    expect(tracker.value("s1", 10_000)?.frozen).toBe(true)
    expect(tracker.value("s64", 10_000)?.frozen).toBe(true)
  })

  test("never evicts a streaming run to stay under the cap", () => {
    const tracker = new TpsTracker()
    tracker.push("live", DELTA, 0) // oldest entry, still running
    for (let i = 0; i < 100; i += 1) {
      tracker.push(`s${i}`, DELTA, 1000 + i * 10)
      tracker.finish(`s${i}`, 1000 + i * 10 + 10)
    }
    expect(tracker.value("live", 1000)?.frozen).toBe(false)
    expect(tracker.hasRunning(1000)).toBe(true)
  })

  test("re-applies the session cap when an oversized running set finishes", () => {
    const tracker = new TpsTracker()
    for (let i = 0; i < 65; i += 1) tracker.push(`s${i}`, DELTA, i)
    expect(tracker.value("s0", 100)).not.toBeNull()
    tracker.finish("s0", 100)
    expect(tracker.value("s0", 100)).toBeNull()
  })
})

describe("formatLabel", () => {
  const value = {
    tps: 6.5,
    tokens: 41,
    frozen: false,
    tokensEstimated: true,
    tpsEstimated: true as const,
    partial: false,
  }

  test("both", () => expect(formatLabel(value, "both")).toBe("~41 tok · ~6.50 t/s"))
  test("tokens", () => expect(formatLabel(value, "tokens")).toBe("~41 tok"))
  test("tps", () => expect(formatLabel(value, "tps")).toBe("~6.50 t/s"))

  test("scales precision with magnitude", () => {
    expect(formatLabel({ ...value, tps: 62.44 }, "tps")).toBe("~62.4 t/s")
    expect(formatLabel({ ...value, tps: 184.6 }, "tps")).toBe("~185 t/s")
  })

  test("shows exact settled tokens and omits unavailable TPS", () => {
    const settled = { ...value, tps: null, tokensEstimated: false, frozen: true }
    expect(formatLabel(settled, "both")).toBe("41 tok")
    expect(formatLabel(settled, "tps")).toBe("— t/s")
  })
})

// ---------------------------------------------------------------------------
// setup wiring: the reactive path cannot be rendered headlessly, but the parts
// that matter (which events are subscribed, and when the render timer runs) are
// observable through a fake context and a patched setInterval.

/** The event fields `setup` reads; the harness emits nothing else. */
interface FakeEvent {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly data: {
    readonly sessionID?: string
    readonly assistantMessageID?: string
    readonly id?: string
    readonly delta?: string
    readonly ordinal?: number
    readonly text?: string
    readonly tokens?: { readonly output: number; readonly reasoning: number }
  }
}

interface TimerSpy {
  callback: (() => void) | undefined
  intervalMs: number
  cleared: number
  created: number
}

interface Generation {
  active: number
}

/**
 * The slice of the host context `setup` actually touches. Member signatures
 * mirror the SDK's, so the real `Context` remains assignable to this and a
 * renamed or re-shaped host member fails to compile instead of being erased.
 */
interface FakeContext {
  readonly options: TpsOptionsInput
  readonly app: { readonly version: string }
  readonly theme: { readonly text: { readonly subdued: string } }
  readonly storage: {
    memory: (
      key: string,
      options: { readonly initial: Generation },
    ) => readonly [Generation, (mutation: (draft: Generation) => void) => void]
  }
  readonly data: {
    readonly on: (type: string, handler: (event: FakeEvent) => void) => () => void
  }
  readonly ui: { readonly slot: () => () => void }
}

// SAFETY: `FakeContext` covers every context member `setup` touches; the host
// members it omits are unreachable on this path. TypeScript cannot express
// "partial implementation of a foreign interface", so the parameter is narrowed
// through `unknown` — a test-double limitation, not a production cast.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const setupWithFakeContext = definition.setup as unknown as (
  context: FakeContext,
) => ReturnType<typeof definition.setup>

function createHarness(options: TpsOptionsInput = {}) {
  const handlers = new Map<string, ((event: FakeEvent) => void)[]>()
  const generation: Generation = { active: 0 }
  const timer: TimerSpy = { callback: undefined, intervalMs: 0, cleared: 0, created: 0 }
  let eventID = 0

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn: () => void, ms?: number) => {
    timer.callback = fn
    timer.intervalMs = ms ?? 0
    timer.created += 1
    // A real (immediately cancelled) handle keeps the host's return type honest
    // without leaving a live interval behind.
    const handle = realSetInterval(() => {}, 60_000)
    realClearInterval(handle)
    return handle
  }
  globalThis.clearInterval = () => {
    timer.cleared += 1
    timer.callback = undefined
  }

  const ctx: FakeContext = {
    options,
    app: { version: "test" },
    theme: { text: { subdued: "#888888" } },
    storage: {
      memory: () => [generation, (mutation: (draft: Generation) => void) => mutation(generation)] as const,
    },
    data: {
      on: (type: string, handler: (event: FakeEvent) => void) => {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => handlers.delete(type)
      },
    },
    ui: { slot: () => () => {} },
  }

  // `setup` is declared as possibly async and possibly cleanup-less; ours is
  // neither, and the timer assertions fail loudly if that ever changes.
  const started = setupWithFakeContext(ctx)
  const cleanup = started instanceof Function ? started : () => {}
  return {
    timer,
    subscribed: (type: string) => handlers.has(type),
    emit: (type: string, data: FakeEvent["data"], created = Date.now(), id = `evt_${eventID++}`) => {
      for (const handler of handlers.get(type) ?? []) handler({ id, type, created, data })
    },
    tick: () => timer.callback?.(),
    cleanup,
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

/**
 * Every debug directory this process could have created: the preferred name, or
 * a mkdtemp fallback. Matched exactly, not by prefix — `afterEach` deletes these,
 * and a prefix would make PID 12 claim (and remove) a live PID 123 log directory.
 */
function debugDirs(): string[] {
  const own = `${DEBUG_DIR_PREFIX}${process.pid}`
  return readdirSync(tmpdir())
    .filter((entry) => entry === own || entry.startsWith(`${own}-`))
    .map((entry) => join(tmpdir(), entry))
}

describe("plugin setup", () => {
  afterEach(() => {
    for (const dir of debugDirs()) rmSync(dir, { recursive: true, force: true })
  })

  test("subscribes to the events the tracker needs", () => {
    const h = createHarness()
    for (const type of [
      "session.execution.started",
      "session.text.delta",
      "session.reasoning.delta",
      "session.tool.input.delta",
      "session.text.started",
      "session.reasoning.started",
      "session.tool.input.started",
      "session.text.ended",
      "session.reasoning.ended",
      "session.tool.input.ended",
      "session.step.started",
      "session.step.ended",
      "session.step.failed",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.idle",
      "session.deleted",
    ]) {
      expect(h.subscribed(type)).toBe(true)
    }
    h.cleanup()
    h.restore()
  })

  test("runs the timer only while a model step is producing output", () => {
    const h = createHarness()
    expect(h.timer.created).toBe(0)

    h.emit("session.step.started", { sessionID: "s", assistantMessageID: "m1" })
    h.emit("session.text.delta", { sessionID: "s", assistantMessageID: "m1", ordinal: 0, delta: "hello" })
    expect(h.timer.created).toBe(1)
    expect(h.timer.intervalMs).toBe(125) // 8 Hz default

    h.tick() // still streaming: keeps ticking
    expect(h.timer.cleared).toBe(0)

    h.emit("session.step.ended", {
      sessionID: "s",
      assistantMessageID: "m1",
      tokens: { output: 1, reasoning: 0 },
    })
    h.tick() // publishes the step average, then stops during tool execution
    expect(h.timer.cleared).toBe(1)

    h.emit("session.step.started", { sessionID: "s", assistantMessageID: "m2" })
    h.emit("session.text.delta", { sessionID: "s", assistantMessageID: "m2", ordinal: 0, delta: "again" })
    expect(h.timer.created).toBe(2)
    h.cleanup()
    h.restore()
  })

  test("honours refreshHz", () => {
    const h = createHarness({ refreshHz: 20 })
    h.emit("session.text.delta", { sessionID: "s", delta: "hello" })
    expect(h.timer.intervalMs).toBe(50)
    h.cleanup()
    h.restore()
  })

  test("cleanup stops the timer", () => {
    const h = createHarness()
    h.emit("session.text.delta", { sessionID: "s", delta: "hello" })
    h.cleanup()
    expect(h.timer.cleared).toBe(1)
    h.restore()
  })

  // Ordered before the negative test: `afterEach` removes the directory, and the
  // module keeps its resolved path, so re-enabling debug afterwards would write
  // into a directory that no longer exists.
  test("debug logs into a private directory, not a guessable temp path", async () => {
    delete process.env["TPS_DEBUG"]
    const h = createHarness({ debug: true })
    const sessionID = "s\n\u001b[31mforged"
    h.emit("session.execution.started", { sessionID })
    h.emit("session.step.started", { sessionID, assistantMessageID: "m1" })
    h.emit("session.text.delta", { sessionID, assistantMessageID: "m1", ordinal: 0, delta: "a".repeat(4_000) })
    h.emit("session.text.ended", {
      sessionID,
      assistantMessageID: "m1",
      ordinal: 0,
      text: "a".repeat(4_000),
    })
    h.emit("session.step.ended", {
      sessionID,
      assistantMessageID: "m1",
      tokens: { output: 700, reasoning: 100 },
    })
    h.emit("session.idle", { sessionID })
    h.tick()
    h.cleanup()
    h.restore()

    const dir = join(tmpdir(), `${DEBUG_DIR_PREFIX}${process.pid}`)
    expect(debugDirs()).toEqual([dir])
    // Owner-only: the log carries session IDs, so other local users must not
    // even be able to list it.
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(existsSync(join(dir, "tps.log"))).toBe(true)
    const log = Bun.file(join(dir, "tps.log"))
    expect(log.size).toBeGreaterThan(0)
    const text = await log.text()
    expect(text).toContain("finish sid=s\\u000a\\u001b[31mforged tokens=800")
    expect(text).not.toContain(sessionID)
    // The old predictable path must stay unused.
    expect(existsSync(join(tmpdir(), `tps-debug-${process.pid}.log`))).toBe(false)
  })

  test("writes nothing to disk without the debug option", () => {
    delete process.env["TPS_DEBUG"]
    const h = createHarness()
    h.emit("session.execution.started", { sessionID: "s" })
    h.emit("session.text.delta", { sessionID: "s", delta: "hello" })
    h.emit("session.idle", { sessionID: "s" })
    h.tick()
    h.cleanup()
    h.restore()
    expect(debugDirs()).toHaveLength(0)
    expect(existsSync(join(tmpdir(), `tps-debug-${process.pid}.log`))).toBe(false)
  })
})

describe("isEnvEnabled", () => {
  test("accepts only explicit truthy spellings", () => {
    for (const value of ["1", "true", "TRUE", " true "]) expect(isEnvEnabled(value)).toBe(true)
    // A shell script exporting TPS_DEBUG=0 must not start writing to disk.
    for (const value of [undefined, "", "0", "false", "no", "off"]) expect(isEnvEnabled(value)).toBe(false)
  })
})

describe("resolveOptions", () => {
  test("empty options yield the defaults", () => {
    expect(resolveOptions({})).toEqual(DEFAULT_OPTIONS)
  })

  test("accepts valid values", () => {
    const options = resolveOptions({ display: "tps", refreshHz: 20, bytesPerToken: 5, debug: true })
    expect(options.display).toBe("tps")
    expect(options.refreshHz).toBe(20)
    expect(options.bytesPerToken).toBe(5)
    expect(options.debug).toBe(true)
  })

  test("clamps numbers into their supported range", () => {
    expect(resolveOptions({ refreshHz: 0 }).refreshHz).toBe(1)
    expect(resolveOptions({ refreshHz: 1000 }).refreshHz).toBe(60)
    expect(resolveOptions({ bytesPerToken: 0 }).bytesPerToken).toBe(1)
    expect(resolveOptions({ bytesPerToken: 100 }).bytesPerToken).toBe(16)
  })

  test("rejects invalid values", () => {
    const options = resolveOptions({ refreshHz: "12", bytesPerToken: null, display: "fancy", debug: "yes" })
    expect(options.refreshHz).toBe(DEFAULT_OPTIONS.refreshHz)
    expect(options.bytesPerToken).toBe(DEFAULT_OPTIONS.bytesPerToken)
    expect(options.display).toBe("both")
    expect(options.debug).toBe(false)
  })

  test("tolerates hostile shapes", () => {
    expect(resolveOptions({ display: {}, refreshHz: Number.NaN, bytesPerToken: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_OPTIONS,
    )
  })
})
