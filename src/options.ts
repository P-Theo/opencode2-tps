// `ctx.options` is host-supplied JSON (Record<string, any>), so this is a real
// parsing boundary: every value is validated and clamped, and anything invalid
// falls back to the default rather than propagating NaN into the arithmetic.
// `options.schema.json` documents the same enumerations, defaults, and bounds
// for editors and agents; `tests/options-schema.test.ts` keeps the two in
// agreement.

import { BYTES_PER_TOKEN_MAX, BYTES_PER_TOKEN_MIN, DEFAULT_CONFIG, formatTps, type TpsConfig, type TpsValue } from "./tracker.js"

export const DISPLAY_MODES = ["both", "tokens", "tps"] as const

export type DisplayMode = (typeof DISPLAY_MODES)[number]

export const REFRESH_HZ_MIN = 1

export const REFRESH_HZ_MAX = 60

/**
 * A value as it can arrive from `cli.json`: arbitrary JSON, nothing more.
 * Named so the option boundary has a real input contract to validate against.
 */
export type OptionValue = string | number | boolean | null | readonly OptionValue[] | { readonly [key: string]: OptionValue }

/** The option surface, exactly as documented in the README, before validation. */
export interface TpsOptionsInput {
  readonly display?: OptionValue
  readonly refreshHz?: OptionValue
  readonly bytesPerToken?: OptionValue
  readonly debug?: OptionValue
}

export interface TpsOptions extends TpsConfig {
  readonly display: DisplayMode
  readonly refreshHz: number
  readonly debug: boolean
}

export const DEFAULT_OPTIONS: TpsOptions = {
  ...DEFAULT_CONFIG,
  display: "both",
  refreshHz: 8,
  debug: false,
}

function isFiniteNumber(value: OptionValue | undefined): value is number {
  return Number.isFinite(value)
}

function isDisplayMode(value: OptionValue | undefined): value is DisplayMode {
  return DISPLAY_MODES.some((mode) => mode === value)
}

function clampNumber(value: OptionValue | undefined, fallback: number, min: number, max: number): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.min(Math.max(value, min), max)
}

export function resolveOptions(raw: TpsOptionsInput): TpsOptions {
  return {
    display: isDisplayMode(raw.display) ? raw.display : DEFAULT_OPTIONS.display,
    refreshHz: clampNumber(raw.refreshHz, DEFAULT_OPTIONS.refreshHz, REFRESH_HZ_MIN, REFRESH_HZ_MAX),
    bytesPerToken: clampNumber(raw.bytesPerToken, DEFAULT_OPTIONS.bytesPerToken, BYTES_PER_TOKEN_MIN, BYTES_PER_TOKEN_MAX),
    debug: raw.debug === true,
  }
}

export function formatLabel(value: TpsValue, display: DisplayMode): string {
  const tokens = `${value.tokensEstimated ? "~" : ""}${value.tokens} tok`
  const tps = value.tps === null ? null : `~${formatTps(value.tps)} t/s`

  if (display === "tokens") return tokens

  if (display === "tps") return tps ?? "— t/s"

  return tps === null ? tokens : `${tokens} · ${tps}`
}
