# Vendored anti-slop plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), path `skills/install-anti-slop/assets/anti-slop`.

- Previous baseline: `e8100a10da49858cfa8d26883d170e9cc8281988`
- Current baseline: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Adoption: complete incoming snapshot; no local rule modifications.

This directory matches the upstream snapshot above except for this file. Rule policy (enabled rules and severities) lives in the repository root `.oxlintrc.json`, not here.

The Effect plugin source is copied but intentionally not registered: the repository has no direct `effect` dependency, so `anti-slop-effect` is absent from `jsPlugins`. The bundled `vendor/eslint-stylistic/` code carries its own provenance and license in `vendor/eslint-stylistic/UPSTREAM.md`.

To update: stage a new upstream revision beside the live tree, diff against the current baseline, apply reviewed changes, and update this record.
