import { describe, expect, test } from "bun:test"
import { TpsTracker } from "./tps.tsx"

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

  test("goes stale when no delta arrives for LIVE_STALE_MS", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 1000)
    expect(tracker.value("s", 2000)).not.toBeNull()
    expect(tracker.value("s", 2501)).toBeNull()
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

  test("caps inter-delta gaps so tool pauses do not inflate duration", () => {
    const tracker = new TpsTracker()
    tracker.push("s", DELTA, 0)
    tracker.push("s", DELTA, 10_000)
    tracker.finish("s", 10_000)
    const value = tracker.value("s", 10_000)
    // activeMs = 250 (first) + 2000 (capped gap) + 0 tail => 20 tok / 2.25s
    expect(value?.frozen).toBe(true)
    expect(value?.tokens).toBe(20)
    expect(value?.tps).toBeCloseTo(20 / 2.25, 2)
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

  test("clearLive hides the live value but keeps run totals", () => {
    const tracker = new TpsTracker()
    tracker.beginRun("s")
    tracker.push("s", DELTA, 1000)
    tracker.clearLive("s")
    expect(tracker.value("s", 1000)).toBeNull()
    tracker.push("s", DELTA, 2000)
    const value = tracker.value("s", 2000)
    expect(value?.tokens).toBe(20)
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

  test("ignores empty deltas", () => {
    const tracker = new TpsTracker()
    tracker.push("s", "", 1000)
    expect(tracker.value("s", 1000)).toBeNull()
  })
})
