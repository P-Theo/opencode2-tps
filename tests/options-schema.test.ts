// Keeps options.schema.json honest against the runtime parser and the README.
// The schema is the contract agents validate against; the parser is what
// actually runs; a drift between them is a bug in one of them, so both are
// pinned to the same exported constants.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import optionsSchema from "../options.schema.json"
import packageJson from "../package.json"
import {
  DEFAULT_OPTIONS,
  DISPLAY_MODES,
  REFRESH_HZ_MAX,
  REFRESH_HZ_MIN,
} from "../src/options.ts"
import { BYTES_PER_TOKEN_MAX, BYTES_PER_TOKEN_MIN, DEFAULT_CONFIG } from "../src/tracker.ts"

const docs = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8")

describe("options.schema.json agreement", () => {
  const { display, refreshHz, bytesPerToken, debug } = optionsSchema.properties

  test("documents the same enumerations as runtime parsing", () => {
    expect(display.enum).toEqual([...DISPLAY_MODES])
  })

  test("documents the same defaults as runtime parsing", () => {
    expect(display.default).toBe(DEFAULT_OPTIONS.display)
    expect(refreshHz.default).toBe(DEFAULT_OPTIONS.refreshHz)
    expect(bytesPerToken.default).toBe(DEFAULT_OPTIONS.bytesPerToken)
    expect(debug.default).toBe(DEFAULT_OPTIONS.debug)
    expect(DEFAULT_CONFIG.bytesPerToken).toBe(DEFAULT_OPTIONS.bytesPerToken)
  })

  test("documents the same bounds as the runtime clamp", () => {
    expect(refreshHz.minimum).toBe(REFRESH_HZ_MIN)
    expect(refreshHz.maximum).toBe(REFRESH_HZ_MAX)
    expect(bytesPerToken.minimum).toBe(BYTES_PER_TOKEN_MIN)
    expect(bytesPerToken.maximum).toBe(BYTES_PER_TOKEN_MAX)
  })

  test("documents every option the parser reads, and no others", () => {
    expect(Object.keys(optionsSchema.properties).sort()).toEqual(["bytesPerToken", "debug", "display", "refreshHz"])
  })

  test("names the plugin and its options location consistently", () => {
    expect(optionsSchema.title).toBe(`${packageJson.name} plugin options`)
    expect(optionsSchema.description).toContain(packageJson.name)
  })
})

describe("docs agreement", () => {
  test("states the defaults the plugin ships with", () => {
    expect(docs).toContain(`"${DEFAULT_OPTIONS.display}"`)
    expect(docs).toContain(String(DEFAULT_OPTIONS.refreshHz))
    expect(docs).toContain(String(DEFAULT_OPTIONS.bytesPerToken))
  })

  test("documents each option by name", () => {
    for (const name of ["display", "refreshHz", "bytesPerToken", "debug"]) expect(docs).toContain(`\`${name}\``)
  })
})
