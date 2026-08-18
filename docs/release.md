# Release

Maintainer runbook.

A path entry loads `tps.tsx` and lets the host transform it; an installed package loads the pre-built `dist/tui.js`. Those are two different code paths, so the bundle gets tested before it goes out.

## 1. Build the tarball

`npm pack` runs lint, check, test and build through `prepack`.

```sh
npm pack --pack-destination /tmp
```

The tarball holds `dist/tui.js`, `package.json`, `README.md` and `LICENSE`. The host entry point is `exports["./tui"]`.

## 2. Install it somewhere clean

```sh
mkdir -p /tmp/tps-verify && cd /tmp/tps-verify && npm init -y
npm i /tmp/opencode2-tps-<version>.tgz
```

## 3. Load the bundle

Point `cli.json` at the installed file, start the TUI and send a prompt.

```json
{
  "plugins": [
    { "package": "/tmp/tps-verify/node_modules/opencode2-tps/dist/tui.js" }
  ]
}
```

## 4. Publish a prerelease

Use a version such as `0.1.0-rc.1`.

```sh
npm publish --tag next
```

Always pass a tag. An untagged publish becomes `latest`, prerelease version or not.

## 5. Install from the registry

Install the prerelease, then reference the plugin by name in `cli.json`. This is the only step that exercises registry resolution, the `exports` subpath, and the bare-string entry form.

```sh
npm i opencode2-tps@next
```

## 6. Publish the release

```sh
npm publish
```
