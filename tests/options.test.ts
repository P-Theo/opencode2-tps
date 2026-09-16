import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, formatLabel, resolveOptions } from "../src/options.ts"

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
