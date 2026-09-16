// The published package loads the precompiled dist/tui.js through its `./tui`
// export, not src/plugin.tsx. Every other test imports the source, so this suite builds
// the bundle with the production script, imports it, and renders the composer
// claim with testRender: the transformed JSX mounts, the precompiled memo still
// tracks the plugin's refresh signal, and the shipped label appears, settles and
// freezes, resets for a new run, and stays per-session.

import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { testRender } from "@opentui/solid"
import type { JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import type { TpsOptionsInput } from "../src/options.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

const distEntry = new URL("../dist/tui.js", import.meta.url).href

// 95 bytes / 4.75 bytes-per-token = 20 estimated tokens.
const DELTA = "a".repeat(95)

let plugin: Plugin.Definition

beforeAll(async () => {
  // Spawn the production build with Node — the interpreter `npm run build` uses
  // — so every run tests a fresh dist/tui.js built exactly as the package
  // ships, even from a clean checkout and across watch-mode reruns.
  const build = spawnSync("node", ["scripts/build.mjs"], { cwd: root, encoding: "utf8" })

  if (build.status !== 0) throw new Error(`node scripts/build.mjs failed:\n${build.stderr || build.stdout}`)
  plugin = (await import(distEntry)).default
})

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

interface Generation {
  active: number
}

interface Claim {
  readonly append: "session.composer.top"
  readonly render: (input: { readonly sessionID: string }) => JSX.Element
}

interface FakeContext {
  readonly options: TpsOptionsInput
  readonly app: { readonly version: string }
  readonly theme: { readonly text: { readonly subdued: string } }
  readonly storage: {
    readonly memory: (
      key: string,
      options: { readonly initial: Generation },
    ) => readonly [Generation, (mutation: (draft: Generation) => void) => void]
  }
  readonly data: {
    readonly on: (type: string, handler: (event: FakeEvent) => void) => () => void
  }
  readonly ui: {
    readonly slot: (claim: Claim) => () => void
  }
}

type FakeSetup = (context: FakeContext) => (() => void) | void

function start(context: FakeContext): (() => void) | void {
  // SAFETY: FakeContext covers every context member the compiled setup touches;
  // TypeScript cannot express a partial implementation of a foreign interface,
  // so the callable is narrowed through unknown — a test-double limitation, not
  // a production cast.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const setup = plugin.setup as unknown as FakeSetup

  return setup(context)
}

interface Harness {
  readonly claims: Claim[]
  emit: (type: string, data: FakeEvent["data"], created: number) => void
  tick: () => void
  cleanup: () => void
  restore: () => void
}

function createHarness(options: TpsOptionsInput = {}): Harness {
  const claims: Claim[] = []
  const handlers = new Map<string, ((event: FakeEvent) => void)[]>()
  const generation: Generation = { active: 0 }
  let flush: (() => void) | undefined
  let eventID = 0

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  // Rendering is throttled by the plugin's own interval; capture the callback
  // so the test can flush on demand instead of waiting on wall-clock time.
  globalThis.setInterval = (callback: () => void, _ms?: number) => {
    flush = callback
    // A real (immediately cancelled) handle keeps the host's return type honest
    // without leaving a live interval behind.
    const handle = realSetInterval(() => {}, 60_000)
    realClearInterval(handle)

    return handle
  }

  globalThis.clearInterval = () => {
    flush = undefined
  }

  const context: FakeContext = {
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
    ui: {
      slot: (claim: Claim) => {
        claims.push(claim)

        return () => {}
      },
    },
  }

  // `setup` is declared as possibly async and possibly cleanup-less; ours is
  // neither, and the render assertions fail loudly if that ever changes.
  const started = start(context)
  const cleanup = started instanceof Function ? started : () => {}

  return {
    claims,
    emit: (type, data, created) => {
      for (const handler of handlers.get(type) ?? []) handler({ id: `evt_${eventID++}`, type, created, data })
    },
    tick: () => flush?.(),
    cleanup,
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

async function openApp(harness: Harness, sessionID: string) {
  return testRender(() => harness.claims[0]!.render({ sessionID }), { width: 60, height: 4 })
}

describe("built entrypoint", () => {
  test("renders the live label through text, reasoning, and tool-input streaming", async () => {
    const h = createHarness()
    const app = await openApp(h, "ses_test")

    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("tok")

      const now = Date.now()
      h.emit("session.execution.started", { sessionID: "ses_test" }, now)
      h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m1" }, now)
      h.emit("session.text.delta", { sessionID: "ses_test", assistantMessageID: "m1", ordinal: 0, delta: DELTA }, now)
      h.tick()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("~20 tok")
      expect(app.captureCharFrame()).toContain("t/s")

      h.emit("session.reasoning.delta", { sessionID: "ses_test", assistantMessageID: "m1", ordinal: 0, delta: DELTA }, now)
      h.tick()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("~40 tok")

      h.emit("session.tool.input.started", { sessionID: "ses_test", assistantMessageID: "m1", id: "t1" }, now)
      h.emit("session.tool.input.delta", { sessionID: "ses_test", assistantMessageID: "m1", id: "t1", delta: DELTA }, now)
      h.tick()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("~60 tok")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("settles exactly and freezes after completion", async () => {
    const h = createHarness()
    const app = await openApp(h, "ses_test")

    try {
      const t0 = Date.now()
      h.emit("session.execution.started", { sessionID: "ses_test" }, t0)
      h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m1" }, t0)
      h.emit("session.text.delta", { sessionID: "ses_test", assistantMessageID: "m1", ordinal: 0, delta: DELTA }, t0)
      h.tick()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("~20 tok")

      h.emit("session.step.streamed", { sessionID: "ses_test", assistantMessageID: "m1" }, t0 + 1000)
      h.emit(
        "session.step.ended",
        { sessionID: "ses_test", assistantMessageID: "m1", tokens: { output: 42, reasoning: 8 } },
        t0 + 1050,
      )
      h.emit("session.execution.succeeded", { sessionID: "ses_test" }, t0 + 1100)
      h.tick()
      await app.renderOnce()
      const frozen = app.captureCharFrame()
      expect(frozen).toContain("50 tok")
      expect(frozen).toContain("50.0 t/s")
      expect(frozen).not.toContain("~50 tok")

      // A late delta after completion must not move the frozen figure.
      h.emit("session.text.delta", { sessionID: "ses_test", assistantMessageID: "m1", ordinal: 0, delta: "late" }, t0 + 2000)
      h.tick()
      await app.renderOnce()
      expect(app.captureCharFrame()).toBe(frozen)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("resets the figure when a new prompt starts", async () => {
    const h = createHarness()
    const app = await openApp(h, "ses_test")

    try {
      const t0 = Date.now()
      h.emit("session.execution.started", { sessionID: "ses_test" }, t0)
      h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m1" }, t0)
      h.emit("session.text.delta", { sessionID: "ses_test", assistantMessageID: "m1", ordinal: 0, delta: DELTA }, t0)
      h.emit("session.step.streamed", { sessionID: "ses_test", assistantMessageID: "m1" }, t0 + 1000)
      h.emit(
        "session.step.ended",
        { sessionID: "ses_test", assistantMessageID: "m1", tokens: { output: 42, reasoning: 8 } },
        t0 + 1050,
      )
      h.emit("session.execution.succeeded", { sessionID: "ses_test" }, t0 + 1100)
      h.tick()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("50 tok")

      const t1 = t0 + 5000
      h.emit("session.execution.started", { sessionID: "ses_test" }, t1)
      h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m2" }, t1)
      h.emit("session.text.delta", { sessionID: "ses_test", assistantMessageID: "m2", ordinal: 0, delta: DELTA }, t1)
      h.tick()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("~20 tok")
      expect(app.captureCharFrame()).not.toContain("50 tok")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("keeps orchestrator and sub-agent sessions independent", async () => {
    const h = createHarness()

    const app = await testRender(
      () => (
        <box flexDirection="column">
          {h.claims[0]!.render({ sessionID: "ses_main" })}
          {h.claims[0]!.render({ sessionID: "ses_sub" })}
        </box>
      ),
      { width: 60, height: 8 },
    )

    try {
      const now = Date.now()
      h.emit("session.execution.started", { sessionID: "ses_sub" }, now)
      h.emit("session.step.started", { sessionID: "ses_sub", assistantMessageID: "m1" }, now)
      h.emit("session.text.delta", { sessionID: "ses_sub", assistantMessageID: "m1", ordinal: 0, delta: DELTA }, now)
      h.tick()
      await app.renderOnce()
      let frame = app.captureCharFrame()
      expect(frame).toContain("~20 tok")
      expect(frame.match(/tok/g)?.length).toBe(1)

      h.emit("session.step.started", { sessionID: "ses_main", assistantMessageID: "m2" }, now)
      h.emit(
        "session.text.delta",
        { sessionID: "ses_main", assistantMessageID: "m2", ordinal: 0, delta: DELTA + DELTA },
        now,
      )
      h.tick()
      await app.renderOnce()
      frame = app.captureCharFrame()
      expect(frame).toContain("~20 tok")
      expect(frame).toContain("~40 tok")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })
})
