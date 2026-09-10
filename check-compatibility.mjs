import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
const packages = ["@opencode/cli", "@opencode/plugin", "@opencode/theme"]
const versions = packages.map((name) => packageJson.devDependencies[name])
const version = versions[0]

if (!/^0\.0\.0-beta-\d{5,6}$/.test(version)) {
  throw new Error(`OpenCode 2 compatibility version has an unexpected format: ${version}`)
}
if (!versions.every((candidate) => candidate === version)) {
  throw new Error(`OpenCode 2 packages must use one exact version: ${versions.join(", ")}`)
}

const executable = resolve("node_modules", ".bin", process.platform === "win32" ? "opencode2.cmd" : "opencode2")
const reported = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim()
if (reported !== `opencode2 v${version}`) {
  throw new Error(`Expected opencode2 v${version}, got ${reported}`)
}

console.log(`OpenCode 2 compatibility target: ${version}`)
