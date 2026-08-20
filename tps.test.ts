import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import definition, {
  CALIBRATION_MIN_BYTES,
  CALIBRATION_MIN_TOKENS,
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
  test("accumulates estimated tokens and computes run-average tps", () => {
    const tracker = new TpsTracker()
    tracker.beginRun("s")
    tracker.push("s", DELTA, 1000)
    tracker.push("s", DELTA, 1100)
    tracker.push("s", DELTA, 1200)
    const value = tracker.value("s", 1200)
    // run total 32 tokens over 200ms from the first delta
    expect(value).not.toBeNull()
    expect(value?.tokens).toBe(32)
    expect(value?.frozen).toBe(false)
    expect(value?.tps).toBeCloseTo(160)
  })

  test("derives tokens from the run's byte total, not per delta", () => {
    const tracker = new TpsTracker()
    // ten 2-byte deltas = 20 bytes = 5 tokens (a per-delta floor would say 10)
    for (let i = 0; i < 10; i += 1) tracker.push("s", "ab", 1000 + i * 10)
    expect(tracker.value("s", 1090)?.tokens).toBe(5)
  })

  test("counts multi-byte characters by their utf-8 length", () => {
    const tracker = new TpsTracker()
    tracker.push("s", "€".repeat(5), 1000) // 3 bytes each => 15 bytes => 4 tokens
    expect(tracker.value("s", 1000)?.tokens).toBe(4)
  })

  test("honours a custom bytes-per-token ratio", () => {
    const tracker = new TpsTracker({ ...DEFAULT_OPTIONS, bytesPerToken: 5 })
    tracker.push("s", DELTA, 1000) // 50 bytes / 5 = 10 tokens
    expect(tracker.value("s", 1000)?.tokens).toBe(10)
  })

  test("a provider pause after output begins lowers tps", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 1000)
    expect(tracker.value("s", 2000)?.tps).toBeCloseTo(11)
    expect(tracker.value("s", 3000)?.tps).toBeCloseTo(5.5)
  })

  test("the running average is continuous with the frozen one", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 500)
    const running = tracker.value("s", 3000)
    tracker.finish("s", 3000)
    const frozen = tracker.value("s", 3000)
    expect(frozen?.frozen).toBe(true)
    expect(frozen?.tps).toBeCloseTo(running?.tps ?? -1)
  })

  test("renders nothing for a run that has produced no output yet", () => {
    const tracker = new TpsTracker()
    tracker.beginRun("s")
    expect(tracker.value("s", 1000)).toBeNull()
  })

  test("does not cap long pauses within a model step", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 6000)
    const value = tracker.value("s", 6000)
    expect(value?.tokens).toBe(22)
    expect(value?.tps).toBeCloseTo(22 / 6)
  })

  test("excludes time between model steps", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1")
    tracker.push("s", DELTA, 0, "m1")
    tracker.push("s", DELTA, 100, "m1")
    tracker.finishStep("s", "m1", undefined, 200)
    tracker.beginStep("s", "m2")
    tracker.push("s", DELTA, 10_000, "m2")
    tracker.push("s", DELTA, 10_100, "m2")
    // 200ms in step 1 + 100ms in step 2; the 9.8s tool interval is excluded.
    expect(tracker.value("s", 10_100)?.tps).toBeCloseTo(43 / 0.3)
  })

  test("counts a provider pause after the final delta until the step ends", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1")
    tracker.push("s", DELTA, 0, "m1")
    tracker.finishStep("s", "m1", undefined, 3_000)
    tracker.finish("s", 10_000)
    const value = tracker.value("s", 10_000)
    expect(value?.frozen).toBe(true)
    expect(value?.tokens).toBe(11)
    expect(value?.tps).toBeCloseTo(11 / 3)
  })

  test("excludes tool execution inside a model step", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1")
    tracker.push("s", DELTA, 0, "m1")
    tracker.push("s", DELTA, 100, "m1")
    tracker.beginTool("s", "m1", "tool1", 100)
    tracker.finishTool("s", "m1", "tool1", 5_100)
    tracker.finishStep("s", "m1", undefined, 5_200)
    expect(tracker.value("s", 5_200)?.tps).toBeCloseTo(22 / 0.2)
  })

  test("excludes overlapping tool executions only once", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1")
    tracker.push("s", DELTA, 0, "m1")
    tracker.beginTool("s", "m1", "tool1", 100)
    tracker.beginTool("s", "m1", "tool2", 200)
    tracker.finishTool("s", "m1", "tool1", 1_000)
    tracker.finishTool("s", "m1", "tool2", 2_000)
    tracker.finishStep("s", "m1", undefined, 2_100)
    expect(tracker.value("s", 2_100)?.tps).toBeCloseTo(11 / 0.2)
  })

  test("ignores tool events from another assistant message", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1")
    tracker.push("s", DELTA, 0, "m1")
    tracker.beginTool("s", "other", "tool1", 100)
    tracker.finishTool("s", "other", "tool1", 2_000)
    tracker.finishStep("s", "m1", undefined, 2_100)
    expect(tracker.value("s", 2_100)?.tps).toBeCloseTo(11 / 2.1)
  })

  test("keeps the frozen average until the next run", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 100)
    tracker.finish("s", 200)
    const frozen = tracker.value("s", 201)
    expect(frozen?.frozen).toBe(true)
    expect(frozen?.tokens).toBe(22)
    // still frozen long after finishing — no time-based expiry
    expect(tracker.value("s", 200 + 60_000)?.frozen).toBe(true)
    // next prompt starts a new run and clears the frozen average
    tracker.beginRun("s")
    expect(tracker.value("s", 200 + 60_001)).toBeNull()
  })

  test("starts a run implicitly when execution.started was missed", () => {
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

  test("reports whether any run is streaming", () => {
    const tracker = new TpsTracker()
    expect(tracker.hasRunning()).toBe(false)
    tracker.push("s", DELTA, 0)
    expect(tracker.hasRunning()).toBe(true)
    tracker.finish("s", 100)
    expect(tracker.hasRunning()).toBe(false)
  })

  test("ignores empty deltas", () => {
    const tracker = new TpsTracker()
    tracker.push("s", "", 1000)
    expect(tracker.value("s", 1000)).toBeNull()
  })

  describe("calibration from completed model steps", () => {
    // 4000 bytes from one assistant step and 800 generated tokens: ratio 5,
    // which must override the configured fallback from then on.
    function seedCalibratedSession(bytes: number, tokens: number): TpsTracker {
      const tracker = new TpsTracker()
      tracker.beginStep("s", "m1")
      tracker.push("s", "a".repeat(bytes), 0, "m1")
      tracker.finishStep("s", "m1", tokens, 1)
      return tracker
    }

    test("calibrates from the first usable completed step", () => {
      const tracker = seedCalibratedSession(4_000, 800)
      tracker.push("s", DELTA, 1000) // 50 more bytes at ratio 5 => 10 more tokens
      tracker.finish("s", 1000)
      expect(tracker.value("s", 1000)?.tokens).toBe(810)
    })

    test("ignores steps without enough bytes or tokens", () => {
      const tracker = new TpsTracker()
      tracker.beginStep("s", "m1")
      tracker.push("s", "a".repeat(CALIBRATION_MIN_BYTES), 0, "m1")
      tracker.finishStep("s", "m1", CALIBRATION_MIN_TOKENS - 1, 1)
      tracker.push("s", DELTA, 1000)
      tracker.finish("s", 1000)
      // whole run at the fallback ratio 4.75: ceil((2048 + 50) / 4.75)
      expect(tracker.value("s", 1000)?.tokens).toBe(442)
    })

    test("keeps the fallback ratio when no step usage arrives", () => {
      const tracker = new TpsTracker()
      tracker.push("s", DELTA, 1000)
      tracker.finish("s", 1000)
      expect(tracker.value("s", 1000)?.tokens).toBe(11)
    })

    test("rejects an implausible ratio and keeps the fallback", () => {
      // 4000 bytes but only 100 tokens => ratio 40, outside the 1-16 bounds
      const tracker = seedCalibratedSession(4_000, 100)
      tracker.push("s", DELTA, 1000)
      tracker.finish("s", 1000)
      // whole run at the fallback ratio 4.75: ceil((4000 + 50) / 4.75)
      expect(tracker.value("s", 1000)?.tokens).toBe(853)
      // ... and the rejected step does not consume the one chance: the next
      // usable step calibrates.
      tracker.beginRun("s")
      tracker.beginStep("s", "m2")
      tracker.push("s", "a".repeat(CALIBRATION_MIN_BYTES), 2000, "m2")
      tracker.finishStep("s", "m2", 512, 2500) // ratio 4
      tracker.finish("s", 3000)
      expect(tracker.value("s", 3000)?.tokens).toBe(512)
    })

    test("calibrates once per session, ignoring later steps", () => {
      const tracker = seedCalibratedSession(4_000, 800) // ratio 5
      tracker.beginStep("s", "m2")
      tracker.push("s", DELTA, 1000)
      tracker.finishStep("s", "m2", 10_000, 1000)
      tracker.finish("s", 1000)
      expect(tracker.value("s", 1000)?.tokens).toBe(810) // still ratio 5
    })

    test("calibration is per session, not global", () => {
      const tracker = seedCalibratedSession(4_000, 800) // "s" calibrates to 5
      tracker.push("other", DELTA, 1000)
      tracker.finish("other", 1000)
      expect(tracker.value("other", 1000)?.tokens).toBe(11) // "other" keeps fallback ratio
    })

    test("eviction forgets the calibration", () => {
      const tracker = seedCalibratedSession(4_000, 800)
      tracker.evict("s")
      tracker.push("s", DELTA, 1000)
      tracker.finish("s", 1000)
      expect(tracker.value("s", 1000)?.tokens).toBe(11) // back to fallback
    })

    test("does not mix deltas from another assistant message into the sample", () => {
      const tracker = new TpsTracker()
      tracker.beginStep("s", "m1")
      tracker.push("s", "x".repeat(4_000), 0, "other")
      tracker.push("s", "a".repeat(4_000), 1, "m1")
      tracker.finishStep("s", "m1", 800, 2)
      tracker.finish("s", 2)
      expect(tracker.value("s", 2)?.tokens).toBe(1_600) // all 8000 run bytes at ratio 5
    })

    test("does not calibrate when the matching step start was missed", () => {
      const tracker = new TpsTracker()
      tracker.push("s", "a".repeat(4_000), 0, "m1")
      tracker.finishStep("s", "m1", 800, 1)
      tracker.finish("s", 1)
      expect(tracker.value("s", 1)?.tokens).toBe(843)
    })

    test("failed steps calibrate only when usage is available", () => {
      const tracker = new TpsTracker()
      tracker.beginStep("s", "m1")
      tracker.push("s", "a".repeat(4_000), 0, "m1")
      tracker.finishStep("s", "m1", undefined, 1)
      tracker.beginStep("s", "m2")
      tracker.push("s", "a".repeat(4_000), 1, "m2")
      tracker.finishStep("s", "m2", 800, 2)
      tracker.finish("s", 2)
      expect(tracker.value("s", 2)?.tokens).toBe(1_600)
    })

    test("ignores non-finite and negative usage", () => {
      for (const tokens of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        const tracker = new TpsTracker()
        tracker.beginStep("s", "m1")
        tracker.push("s", "a".repeat(4_000), 0, "m1")
        tracker.finishStep("s", "m1", tokens, 1)
        tracker.finish("s", 1)
        expect(tracker.value("s", 1)?.tokens).toBe(843)
      }
    })

    test("cap eviction forgets the calibration", () => {
      const tracker = seedCalibratedSession(4_000, 800)
      tracker.finish("s", 1)
      for (let i = 0; i < 64; i += 1) {
        tracker.push(`other${i}`, DELTA, i + 2)
        tracker.finish(`other${i}`, i + 3)
      }
      tracker.push("s", DELTA, 1000)
      tracker.finish("s", 1001)
      expect(tracker.value("s", 1001)?.tokens).toBe(11)
    })

    test("an empty run preserves calibration until bounded eviction", () => {
      const tracker = seedCalibratedSession(4_000, 800)
      tracker.beginRun("s")
      tracker.finish("s", 1)
      tracker.push("s", DELTA, 2)
      tracker.finish("s", 3)
      expect(tracker.value("s", 3)?.tokens).toBe(10)
    })
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
    expect(tracker.hasRunning()).toBe(true)
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
  const value = { tps: 6.5, tokens: 41, frozen: false }

  test("both", () => expect(formatLabel(value, "both")).toBe("41 tok · 6.50 t/s"))
  test("tokens", () => expect(formatLabel(value, "tokens")).toBe("41 tok"))
  test("tps", () => expect(formatLabel(value, "tps")).toBe("6.50 t/s"))

  test("scales precision with magnitude", () => {
    expect(formatLabel({ tps: 62.44, tokens: 1, frozen: false }, "tps")).toBe("62.4 t/s")
    expect(formatLabel({ tps: 184.6, tokens: 1, frozen: false }, "tps")).toBe("185 t/s")
  })
})

// ---------------------------------------------------------------------------
// setup wiring: the reactive path cannot be rendered headlessly, but the parts
// that matter (which events are subscribed, and when the render timer runs) are
// observable through a fake context and a patched setInterval.

/** The event fields `setup` reads; the harness emits nothing else. */
interface FakeEvent {
  readonly data: {
    readonly sessionID?: string
    readonly assistantMessageID?: string
    readonly id?: string
    readonly delta?: string
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
    emit: (type: string, data: FakeEvent["data"]) => {
      for (const handler of handlers.get(type) ?? []) handler({ data })
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
      "session.step.started",
      "session.step.ended",
      "session.step.failed",
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
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
    h.emit("session.text.delta", { sessionID: "s", assistantMessageID: "m1", delta: "hello" })
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
    h.emit("session.text.delta", { sessionID: "s", assistantMessageID: "m2", delta: "again" })
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
    h.emit("session.execution.started", { sessionID: "s" })
    h.emit("session.step.started", { sessionID: "s", assistantMessageID: "m1" })
    h.emit("session.text.delta", { sessionID: "s", assistantMessageID: "m1", delta: "a".repeat(4_000) })
    h.emit("session.step.ended", {
      sessionID: "s",
      assistantMessageID: "m1",
      tokens: { output: 700, reasoning: 100 },
    })
    h.emit("session.idle", { sessionID: "s" })
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
    expect(await log.text()).toContain("calibrated sid=s bytes=4000 tokens=800 ratio=5.00")
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
