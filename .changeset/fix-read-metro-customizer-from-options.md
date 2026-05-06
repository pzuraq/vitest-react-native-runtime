---
"vitest-mobile": patch
---

Fix `vitest-mobile bundle` (and any other CLI command that statically reads the
metro customizer from a vitest config) to look at `metro.customize` on the
plugin options.

`readMetroCustomizerFromConfig` was inspecting `stored.metro` as if it were the
customizer function itself, but `nativePlugin({ metro })` stashes a
`MetroOptions` object (`{ bundle, customize, babelPlugins }`) on the plugin
instance — so the customizer was never picked up and the bundle was built with
only the harness-anchored base resolver. Any user resolver hook (e.g. monorepo
`#src/*` rewrites or `react-native` condition pinning) silently dropped on the
floor in pre-built bundles, while the in-process Vitest pool path was unaffected
because it reads `options.metro.customize` directly.

While there: collapse the three plugin-options readers
(`readNativeModulesFromConfig`, `readMetroCustomizerFromConfig`,
`readBabelPluginsFromConfig`) onto a single typed extractor
(`readVitestMobilePluginOptions`) that returns `NativePluginOptions[]` for the
matching projects. Each per-field reader is now a tiny pluck function over the
shared extractor — so a future change to the plugin-options shape fails the
type-checker in one place instead of silently dropping options in three. The
extractor also normalizes the legacy top-level `nativeModules` field into
`harness.nativeModules` so consumers stay strictly typed.

Internal: also extract the readers from `cli/index.ts` into a new internal
`cli/config-readers.ts` module (no public API change) so they can be
unit-tested without dragging the cac dispatcher in. Adds regression tests
covering all readers, including the metro-customizer bug fix and the legacy
`nativeModules` compat path.
