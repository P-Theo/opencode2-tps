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

// 50 ASCII bytes -> ceil(50/5) = 10 estimated tokens
const DELTA = "a".repeat(50)

describe("TpsTracker", () => {
  test("accumulates estimated tokens and computes rolling tps", () => {
    const tracker = new TpsTracker()
    tracker.beginRun("s")
    tracker.push("s", DELTA, 1000)
    tracker.push("s", DELTA, 1100)
    tracker.push("s", DELTA, 1200)
    const value = tracker.value("s", 1200)
    // 30 tokens over gaps 100+100 clamped to >=250ms => 120 t/s
    expect(value).not.toBeNull()
    expect(value?.tokens).toBe(30)
    expect(value?.frozen).toBe(false)
    expect(value?.tps).toBeCloseTo(120)
  })

  test("derives tokens from the run's byte total, not per delta", () => {
    const tracker = new TpsTracker()
    // ten 2-byte deltas = 20 bytes = 4 tokens (a per-delta floor would say 10)
    for (let i = 0; i < 10; i += 1) tracker.push("s", "ab", 1000 + i * 10)
    expect(tracker.value("s", 1090)?.tokens).toBe(4)
  })

  test("counts multi-byte characters by their utf-8 length", () => {
    const tracker = new TpsTracker()
    tracker.push("s", "€".repeat(5), 1000) // 3 bytes each => 15 bytes => 3 tokens
    expect(tracker.value("s", 1000)?.tokens).toBe(3)
  })

  test("falls back to the run average when the live window goes stale", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 1000)
    // inside the stale cutoff: a live single-sample rate
    expect(tracker.value("s", 2000)?.tps).toBeCloseTo(10)
    // past it the indicator keeps the run-so-far average instead of blanking
    const stale = tracker.value("s", 2501)
    expect(stale?.tokens).toBe(10)
    expect(stale?.frozen).toBe(false)
    expect(stale?.tps).toBeCloseTo(10) // 10 tokens / 1000ms capped tail
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

  test("drops samples older than the rolling window", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 6000)
    const value = tracker.value("s", 6000)
    // only the second sample is inside the 5s window: single sample, 10 tokens
    expect(value?.tokens).toBe(20) // totals are cumulative for the run
    expect(value?.tps).toBeCloseTo(40) // 10 tokens / 250ms floor
  })

  test("caps gaps inside the live window so tool pauses do not drag it down", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 3000) // 3s pause, both samples still in the window
    // uncapped this would read 20/3s = 6.67; the gap counts as 2s at most
    expect(tracker.value("s", 3000)?.tps).toBeCloseTo(10)
  })

  test("caps inter-delta gaps so tool pauses do not inflate duration", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 10_000)
    tracker.finish("s", 10_000)
    const value = tracker.value("s", 10_000)
    // activeMs = 0 (first sample) + 2000 (capped gap) + 0 tail => 20 tok / 2s
    expect(value?.frozen).toBe(true)
    expect(value?.tokens).toBe(20)
    expect(value?.tps).toBeCloseTo(10)
  })

  test("honours a custom gap cap", () => {
    const tracker = new TpsTracker({ ...DEFAULT_OPTIONS, gapCapMs: 500 })
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 10_000)
    tracker.finish("s", 10_000)
    expect(tracker.value("s", 10_000)?.tps).toBeCloseTo(40) // 20 tok / 500ms
  })

  test("keeps the frozen average until the next run", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 100)
    tracker.finish("s", 200)
    const frozen = tracker.value("s", 201)
    expect(frozen?.frozen).toBe(true)
    expect(frozen?.tokens).toBe(20)
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

  test("prune trims the window without touching run totals", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 100)
    tracker.prune(10_000)
    const value = tracker.value("s", 10_000)
    expect(value?.tokens).toBe(20)
    expect(value?.tps).toBeCloseTo(20 / 1.1) // activeMs 100 + capped 1000ms tail
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
    expect(tracker.hasRunning()).toBe(true)
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
    readonly delta?: string
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

  test("runs no timer until a session streams, and stops once it is idle", () => {
    const h = createHarness()
    expect(h.timer.created).toBe(0)

    h.emit("session.text.delta", { sessionID: "s", delta: "hello" })
    expect(h.timer.created).toBe(1)
    expect(h.timer.intervalMs).toBe(125) // 8 Hz default

    h.tick() // still streaming: keeps ticking
    expect(h.timer.cleared).toBe(0)

    h.emit("session.idle", { sessionID: "s" })
    h.tick() // publishes the frozen value, then stops
    expect(h.timer.cleared).toBe(1)

    // a later run starts a fresh timer
    h.emit("session.text.delta", { sessionID: "s", delta: "again" })
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
  test("debug logs into a private directory, not a guessable temp path", () => {
    delete process.env["TPS_DEBUG"]
    const h = createHarness({ debug: true })
    h.emit("session.execution.started", { sessionID: "s" })
    h.emit("session.text.delta", { sessionID: "s", delta: "hello" })
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
    const options = resolveOptions({ display: "tps", refreshHz: 20, gapCapMs: 1500, debug: true })
    expect(options.display).toBe("tps")
    expect(options.refreshHz).toBe(20)
    expect(options.gapCapMs).toBe(1500)
    expect(options.debug).toBe(true)
  })

  test("clamps numbers into their supported range", () => {
    expect(resolveOptions({ refreshHz: 0 }).refreshHz).toBe(1)
    expect(resolveOptions({ refreshHz: 1000 }).refreshHz).toBe(60)
    expect(resolveOptions({ sampleWindowMs: 10 }).sampleWindowMs).toBe(1_000)
    expect(resolveOptions({ gapCapMs: 1e9 }).gapCapMs).toBe(30_000)
  })

  test("rejects non-numeric and unknown values", () => {
    const options = resolveOptions({ refreshHz: "12", sampleWindowMs: null, display: "fancy", debug: "yes" })
    expect(options.refreshHz).toBe(DEFAULT_OPTIONS.refreshHz)
    expect(options.sampleWindowMs).toBe(DEFAULT_OPTIONS.sampleWindowMs)
    expect(options.display).toBe("both")
    expect(options.debug).toBe(false)
  })

  test("never lets the single-sample ceiling fall below the floor", () => {
    const options = resolveOptions({ singleSampleMinMs: 900, singleSampleMaxMs: 100 })
    expect(options.singleSampleMinMs).toBe(900)
    expect(options.singleSampleMaxMs).toBe(900)
  })

  test("tolerates hostile shapes", () => {
    expect(resolveOptions({ display: {}, refreshHz: Number.NaN, gapCapMs: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_OPTIONS,
    )
  })
})
