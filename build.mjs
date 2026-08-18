// Precompiles tps.tsx into the published entrypoint.
//
// The host only applies its Solid/Babel transform to files *outside*
// node_modules (filter: /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx$/ in
// @opentui/solid's bun plugin), and an installed package always lives inside
// node_modules. Untransformed JSX would still load — @opentui/solid ships a
// runtime jsx-runtime, and the host rewires runtime imports for node_modules
// ESM — but props and children would be evaluated once, so the indicator would
// render a single frozen value. Hence: transform here, ship JS.
//
// The preset options mirror @opentui/solid/scripts/solid-transform.js so the
// published output is what a locally-loaded source file would have become.
// Imports stay bare (`@opentui/solid`, `solid-js`); the host rewrites them to
// its own runtime copies, which is what keeps the plugin on the same reactive
// graph and renderer as the TUI.

import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const source = join(root, "tps.tsx")
const outDir = join(root, "dist")
const out = join(outDir, "tui.js")

const code = await readFile(source, "utf8")
const result = await transformAsync(code, {
  filename: source,
  configFile: false,
  babelrc: false,
  // Presets apply in reverse order: TypeScript first, then Solid's JSX transform.
  presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [ts]],
})

if (!result?.code) throw new Error("babel produced no output")

await mkdir(outDir, { recursive: true })
await writeFile(out, `${result.code}\n`, "utf8")
console.log(`built ${out} (${result.code.length} bytes)`)
