// Precompiles the runtime modules in src/ into the published entrypoints.
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
// graph and renderer as the TUI. Relative imports between the modules stay
// relative (`./tracker.js`), so every compiled file ships and dist/ resolves
// the same graph the source has.

import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const src = join(root, "src")

const targets = []

for (const source of (await readdir(src)).sort()) {
  if (!/\.tsx?$/.test(source) || /\.(test|d)\.tsx?$/.test(source)) continue
  targets.push({
    source,
    out: `dist/${source === "plugin.tsx" ? "tui.js" : source.replace(/\.tsx?$/, ".js")}`,
    // Presets apply in reverse order: TypeScript first, then Solid's JSX transform.
    presets: source.endsWith(".tsx")
      ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [ts]]
      : [[ts]],
  })
}

if (targets.length === 0) throw new Error("no source modules found in src/")

// dist is generated as a unit; removed source modules must not remain in tarballs.
await rm(join(root, "dist"), { recursive: true, force: true })

for (const target of targets) {
  const source = join(src, target.source)
  const out = join(root, target.out)
  const code = await readFile(source, "utf8")

  const result = await transformAsync(code, {
    filename: source,
    configFile: false,
    babelrc: false,
    presets: target.presets,
  })

  if (!result?.code) throw new Error(`babel produced no output for ${target.source}`)

  const output = `${result.code}\n`

  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, output, "utf8")
  console.log(`built ${out} (${Buffer.byteLength(output)} bytes)`)
}
