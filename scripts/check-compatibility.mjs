import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

const packages = ["@opencode/cli", "@opencode/plugin", "@opencode/theme"]

const versions = packages.map((name) => packageJson.devDependencies[name])

const version = versions[0]

if (!/^0\.0\.0-beta-\d{5,6}$/.test(version)) {
  throw new Error(`OpenCode 2 compatibility version has an unexpected format: ${version}`)
}

if (!versions.every((candidate) => candidate === version)) {
  throw new Error(`OpenCode 2 packages must use one exact version: ${versions.join(", ")}`)
}

const floor = /earliest known compatible beta is\s+`(0\.0\.0-beta-\d{5,6})`/i.exec(readme)?.[1]

if (floor === undefined) {
  throw new Error("README does not state the earliest known compatible beta")
}

if (Number(floor.replace("0.0.0-beta-", "")) > Number(version.replace("0.0.0-beta-", ""))) {
  throw new Error(`README floor ${floor} is newer than the pinned compatibility target ${version}`)
}

// Resolved against this script's location, not cwd, so the check works from any directory.
const root = fileURLToPath(new URL("..", import.meta.url))

// The package's own bin target, not npm's `.bin` wrapper: a .cmd shim cannot be
// execFileSync'd on Windows without a shell, while the native binary runs
// unshelled on every platform despite the .exe name. A normal install's
// postinstall (or CI's prepare step with --ignore-scripts) puts it there.
const executable = resolve(root, "node_modules", "@opencode", "cli", "bin", "opencode2.exe")

const reported = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim()

if (reported !== `opencode2 v${version}`) {
  throw new Error(`Expected opencode2 v${version}, got ${reported}`)
}

console.log(`OpenCode 2 compatibility target: ${version} (floor ${floor})`)
