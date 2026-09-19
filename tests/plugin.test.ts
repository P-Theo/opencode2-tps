import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEBUG_DIR_PREFIX } from "../src/debug.ts"
import type { TpsOptionsInput } from "../src/options.ts"
import definition from "../src/plugin.tsx"

// Setup wiring: the reactive path cannot be rendered headlessly, but the parts
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
 * The slice of the host context `setup` actually touches: an approximation of
 * the real `Context`, not a checked subset of it. The `unknown` narrowing
 * below switches the type checker off, so an SDK rename is caught by `tsc` on
 * `src/` (which is fully typed) rather than here — this fake only records what
 * `setup` does with the members it is given.
 */
interface FakeContext {
  readonly options: TpsOptionsInput
  readonly app: { readonly version: string }
  readonly theme: { readonly text: { readonly muted: string } }
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
  // SAFETY: Node 26's setInterval type has a conditional rest-args overload no
  // two-parameter double can satisfy; the double ignores extra arguments by
  // design, so the assignment is narrowed in one step — a test-double
  // limitation, not a production cast.
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    timer.callback = fn
    timer.intervalMs = ms ?? 0
    timer.created += 1
    // A real (immediately cancelled) handle keeps the host's return type honest
    // without leaving a live interval behind.
    const handle = realSetInterval(() => {}, 60_000)
    realClearInterval(handle)

    return handle
  }) as typeof globalThis.setInterval

  globalThis.clearInterval = () => {
    timer.cleared += 1
    timer.callback = undefined
  }

  const ctx: FakeContext = {
    options,
    app: { version: "test" },
    theme: { text: { muted: "#888888" } },
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
    subscribedTypes: () => [...handlers.keys()].sort(),
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
  // The debug switch is also readable from the environment. A developer's
  // shell must not decide what these tests assert.
  const savedDebugEnv = process.env["TPS_DEBUG"]
  beforeAll(() => {
    delete process.env["TPS_DEBUG"]
  })
  afterAll(() => {
    if (savedDebugEnv === undefined) delete process.env["TPS_DEBUG"]
    else process.env["TPS_DEBUG"] = savedDebugEnv
  })
  afterEach(() => {
    for (const dir of debugDirs()) rmSync(dir, { recursive: true, force: true })
  })

  test("subscribes to exactly the events the tracker needs", () => {
    const h = createHarness()

    const expected = [
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
      "session.step.streamed",
      "session.step.ended",
      "session.step.failed",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.idle",
      "session.deleted",
    ]

    for (const type of expected) expect(h.subscribed(type)).toBe(true)
    // Exact set, not just subset: an added or dropped subscription fails here.
    expect(h.subscribedTypes()).toEqual([...expected].sort())

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
    const h = createHarness({ debug: true })
    const sessionID = "s\n\u001b[31mforged"
    h.emit("session.execution.started", { sessionID }, 1_000)
    h.emit("session.step.started", { sessionID, assistantMessageID: "m1" }, 2_000)
    h.emit("session.text.delta", { sessionID, assistantMessageID: "m1", ordinal: 0, delta: "a".repeat(4_000) }, 2_100)
    h.emit("session.text.ended", {
      sessionID,
      assistantMessageID: "m1",
      ordinal: 0,
      text: "a".repeat(4_000),
    }, 3_000)
    h.emit("session.step.streamed", { sessionID, assistantMessageID: "m1" }, 3_200, "evt_streamed")
    // A replayed delivery of the same event must not move the boundary.
    h.emit("session.step.streamed", { sessionID, assistantMessageID: "m1" }, 500_000, "evt_streamed")
    h.emit("session.step.ended", {
      sessionID,
      assistantMessageID: "m1",
      tokens: { output: 700, reasoning: 100 },
    }, 4_000)
    h.emit("session.idle", { sessionID }, 4_100)
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
    expect(text).toContain("finish sid=s\\u000a\\u001b[31mforged tokens=800 observedMs=1200 tps=666.7")
    expect(text).not.toContain(sessionID)
    // The old predictable path must stay unused.
    expect(existsSync(join(tmpdir(), `tps-debug-${process.pid}.log`))).toBe(false)
  })

  test("writes nothing to disk without the debug option", () => {
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
