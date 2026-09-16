import { appendFileSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// debug
//
// Off unless asked for: an unconfigured install must never touch disk.
//
// The log goes inside an owner-only directory instead of straight into the
// shared temp directory. A guessable path there (the PID is a small, enumerable
// number) can be pre-created by another local user as a symlink, which
// appendFileSync would happily follow into a file of their choosing; a
// world-readable log would also hand them the session IDs it records.

export const DEBUG_DIR_PREFIX = "tps-debug-"

const debugState = { enabled: false, file: "" }

/** True only for a real directory that belongs to us and to no one else. */
function isOwnPrivateDir(path: string): boolean {
  try {
    const stats = lstatSync(path) // lstat, not stat: a planted symlink must not pass

    if (!stats.isDirectory()) return false
    const uid = process.getuid?.()

    // Windows has no uid and a per-user temp directory, so there is nothing to check.
    if (uid === undefined) return true

    return stats.uid === uid && (stats.mode & 0o777) === 0o700
  } catch {
    return false
  }
}

/**
 * The 0700 directory to log into. Named after the PID so the process's own hot
 * reloads keep appending to one file, and only reused when it really is ours —
 * anything else squatting on the name gets sidestepped via mkdtemp.
 */
function debugDir(): string {
  const preferred = join(tmpdir(), `${DEBUG_DIR_PREFIX}${process.pid}`)

  try {
    mkdirSync(preferred, { mode: 0o700 })

    return preferred
  } catch {
    if (isOwnPrivateDir(preferred)) return preferred

    return mkdtempSync(`${preferred}-`)
  }
}

export function configureDebug(enabled: boolean): void {
  debugState.enabled = enabled

  if (!enabled || debugState.file) return

  try {
    debugState.file = join(debugDir(), "tps.log")
  } catch {
    debugState.enabled = false // no usable temp directory: stay silent
  }
}

/** Truthy spellings only: `TPS_DEBUG=0` must not start writing to disk. */
export function isEnvEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()

  return normalized === "1" || normalized === "true"
}

export function mark(line: string): void {
  if (!debugState.enabled) return

  try {
    const safeLine = line.replace(/\p{Cc}/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )

    appendFileSync(debugState.file, `${new Date().toISOString()} ${safeLine}\n`)
  } catch {
    // debug only; never break the host
  }
}
