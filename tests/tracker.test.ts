import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import { TpsTracker } from "../src/tracker.ts"

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

  test("prefers the streamed boundary over the last content boundary", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.markStreamed("s", "m1", 1500)
    tracker.finishStep("s", "m1", 20, 10_000)
    tracker.finish("s", 11_000)
    expect(tracker.value("s", 11_000)?.tps).toBeCloseTo(20 / 1.5)
  })

  test("falls back to the last content boundary without a streamed event", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.finishStep("s", "m1", 20, 10_000)
    tracker.finish("s", 11_000)
    expect(tracker.value("s", 11_000)?.tps).toBeCloseTo(20)
  })

  test("gives a zero-output step a duration from the streamed boundary", () => {
    // Gemini hidden thinking: exact usage, no observable content events at all.
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 1000)
    tracker.markStreamed("s", "m1", 4000)
    tracker.finishStep("s", "m1", 300, 9000)
    tracker.finish("s", 10_000)
    const value = tracker.value("s", 10_000)
    expect(value).toMatchObject({ tokens: 300, tokensEstimated: false })
    expect(value?.tps).toBeCloseTo(100)
  })

  test("excludes local tool execution between the streamed boundary and step settlement", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "tool:t1", "{}", 500)
    tracker.markStreamed("s", "m1", 1000)
    tracker.finishStep("s", "m1", 50, 10_000)
    tracker.beginStep("s", "m2", 30_000)
    tracker.finishBlock("s", "m2", "text:0", "done", 31_000)
    tracker.finishStep("s", "m2", 50, 40_000)
    tracker.finish("s", 50_000)
    expect(tracker.value("s", 50_000)?.tps).toBeCloseTo(50)
  })

  test("failed steps with usage settle exactly against the streamed boundary", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.markStreamed("s", "m1", 1200)
    tracker.finishStep("s", "m1", 17, 2000)
    tracker.finish("s", 3000)
    expect(tracker.value("s", 3000)).toMatchObject({ tokens: 17, tokensEstimated: false, partial: false })
    expect(tracker.value("s", 3000)?.tps).toBeCloseTo(17 / 1.2)
  })

  test("an interrupted step keeps its streamed boundary in the partial freeze", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 1000)
    tracker.markStreamed("s", "m1", 1500)
    tracker.finish("s", 2000)
    expect(tracker.value("s", 2000)).toMatchObject({ tokens: 11, tokensEstimated: true, partial: true, frozen: true })
    expect(tracker.value("s", 2000)?.tps).toBeCloseTo(11 / 1.5)
  })

  test("a retried step's latest streamed boundary wins", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.markStreamed("s", "m1", 1000)
    tracker.markStreamed("s", "m1", 5000)
    tracker.finishStep("s", "m1", 20, 6000)
    tracker.finish("s", 7000)
    expect(tracker.value("s", 7000)?.tps).toBeCloseTo(4)
  })

  test("ignores streamed boundaries for unknown or mismatched steps", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.markStreamed("s", "other", 1000)
    tracker.markStreamed("elsewhere", "m1", 1500)
    tracker.finishBlock("s", "m1", "text:0", DELTA, 2000)
    tracker.finishStep("s", "m1", 20, 3000)
    tracker.finish("s", 4000)
    expect(tracker.value("s", 4000)?.tps).toBeCloseTo(10)
  })

  test("OpenAI Responses shape: summary deltas stream, encrypted reasoning arrives only at settlement", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.beginBlock("s", "m1", "reasoning:0", 100)
    tracker.push("s", "a".repeat(95), 200, "m1", "reasoning:0")
    tracker.finishBlock("s", "m1", "reasoning:0", "a".repeat(95), 1000)
    tracker.beginBlock("s", "m1", "text:0", 1100)
    tracker.push("s", "b".repeat(95), 1200, "m1", "text:0")
    tracker.finishBlock("s", "m1", "text:0", "b".repeat(95), 2000)
    tracker.markStreamed("s", "m1", 2100)
    tracker.finishStep("s", "m1", 200, 9000) // 20 visible + 180 encrypted reasoning
    tracker.finish("s", 10_000)
    const value = tracker.value("s", 10_000)
    expect(value).toMatchObject({ tokens: 200, tokensEstimated: false })
    expect(value?.tps).toBeCloseTo(200 / 2.1)
  })

  test("Anthropic shape: thinking deltas stream and thinking tokens settle exactly", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 0)
    tracker.beginBlock("s", "m1", "reasoning:0", 100)
    tracker.push("s", "t".repeat(95), 200, "m1", "reasoning:0")
    tracker.finishBlock("s", "m1", "reasoning:0", "t".repeat(95), 1500)
    tracker.beginBlock("s", "m1", "text:0", 1600)
    tracker.finishBlock("s", "m1", "text:0", "ok", 1800)
    tracker.markStreamed("s", "m1", 1900)
    tracker.finishStep("s", "m1", 150, 5000) // 30 visible + 120 thinking
    tracker.finish("s", 6000)
    expect(tracker.value("s", 6000)).toMatchObject({ tokens: 150, tokensEstimated: false })
    expect(tracker.value("s", 6000)?.tps).toBeCloseTo(150 / 1.9)
  })

  test("Gemini shape: signature-only thinking leaves no reasoning deltas, thoughts settle exactly", () => {
    const tracker = new TpsTracker()
    tracker.beginStep("s", "m1", 1000)
    tracker.beginBlock("s", "m1", "text:0", 3000)
    tracker.finishBlock("s", "m1", "text:0", "done", 3500)
    tracker.markStreamed("s", "m1", 3600)
    tracker.finishStep("s", "m1", 260, 9000) // 60 visible + 200 thoughts
    tracker.finish("s", 10_000)
    const value = tracker.value("s", 10_000)
    expect(value).toMatchObject({ tokens: 260, tokensEstimated: false })
    expect(value?.tps).toBeCloseTo(100)
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
