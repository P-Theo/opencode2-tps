import { describe, expect, test } from "bun:test"
import { isEnvEnabled } from "../src/debug.ts"

describe("isEnvEnabled", () => {
  test("accepts only explicit truthy spellings", () => {
    for (const value of ["1", "true", "TRUE", " true "]) expect(isEnvEnabled(value)).toBe(true)

    // A shell script exporting TPS_DEBUG=0 must not start writing to disk.
    for (const value of [undefined, "", "0", "false", "no", "off"]) expect(isEnvEnabled(value)).toBe(false)
  })
})
