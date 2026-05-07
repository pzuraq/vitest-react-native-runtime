# vitest-mobile

## 0.3.0

### Minor Changes

- d348a55: The harness builder now auto-wires Expo modules autolinking whenever a user
  declares any `expo-*` (or `expo`, or `@expo/*`) entry in
  `nativePlugin({ harness: { nativeModules } })`. This unblocks testing
  components from libraries that pull Expo modules under the hood — e.g.
  `expo-blur`, `expo-haptics`, `expo-image`, etc.

  Previously the harness was a vanilla React Native template (`use_native_modules!`
  only — no `use_expo_modules!`), so listing `expo-blur` in `nativeModules` got
  the JS dep installed but no native pod, and JS-side renders crashed with
  `Cannot read property 'BlurView' of undefined` because
  `expo-modules-autolinking` had never run.

  The builder now detects Expo-shaped names in `nativeModules` and runs
  `npx install-expo-modules@latest --non-interactive` against the scaffolded
  project to wire up the Podfile (`use_expo_modules!`), `settings.gradle`
  (`useExpoModules()`), `MainApplication`, and `AppDelegate`. Two
  post-processing patches keep the result compatible with vitest-mobile's
  own pipeline:
  1. The CLI integration's bundle-root rename (`index` →
     `.expo/.virtual-metro-entry`) is reverted, because vitest-mobile
     rewrites `/index.bundle` requests onto its prebuilt bundle directly
     and never consults Expo CLI's resolver.
  2. The missing `bindReactNativeFactory(factory)` call is inserted into
     `AppDelegate.swift`. SDK 54+'s `ExpoAppDelegate.recreateRootView`
     reads its own `factory` property and `fatalError`s if it's unset;
     `install-expo-modules`'s Swift transform doesn't add the bind call,
     but the from-scratch Expo bare template does.

  Cache key bumps to `fmt6` so users with v5 binaries that listed Expo modules
  as deps (no autolinking pipeline) get a fresh build the next time they
  bootstrap.

  Heuristic: a `nativeModules` entry triggers the Expo wiring when its name
  matches `expo`, `expo-*`, or `@expo/*`. Modules outside that pattern still
  go through the React Native community CLI's autolinking, which the
  scaffolded RN template already supports.

## 0.2.2

### Patch Changes

- 320c60b: Fix `vitest-mobile bundle` (and any other CLI command that statically reads the
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

## 0.2.1

### Patch Changes

- 66f4239: Add `metro.babelPlugins` option to inject extra Babel plugins into Metro's transform pipeline.

  Native modules like `react-native-reanimated` require compile-time Babel transforms (e.g. worklet directives) that Metro won't apply unless the plugin is explicitly wired in. Previously, users had no way to add these — worklet transforms were silently skipped in both watch mode and pre-built bundles.

  **New option: `metro.babelPlugins`.**

  ```ts
  nativePlugin({
    harness: { nativeModules: ['react-native-reanimated'] },
    metro: { babelPlugins: ['react-native-reanimated/plugin'] },
  });
  ```

  Plugins are resolved from the harness project's `node_modules` and injected into the generated Metro transformer shim. They run before vitest-mobile's own plugins so worklet transforms etc. are applied before the test wrapper inspects the output. Works in both live Metro (watch mode) and `bundle` pre-builds.

  **Auto-injection for known modules.** When a native module listed in `harness.nativeModules` has a well-known companion Babel plugin (currently just `react-native-reanimated` → `react-native-reanimated/plugin`), the harness builder automatically adds it to `babel.config.js` during `bootstrap`.

  **CLI plumbing.** The `bundle` command now reads `metro.babelPlugins` from the vitest config and passes them through to the bundler, so pre-built bundles match live-Metro output.

## 0.2.0

### Minor Changes

- fd223b8: Restructure plugin options and rewrite tye device-side runtime.

  ### Breaking: plugin options

  `nativePlugin(...)` options are now nested into `harness` / `device` / `metro` groups:

  ```ts
  // Before
  nativePlugin({ platform: 'ios', headless: true, bundle: true, metro: customizerFn });

  // After
  nativePlugin({ platform: 'ios', device: { headless: true }, metro: { bundle: true, customize: customizerFn } });
  ```

  Removed `promptForNewDevice` and `skipIfUnavailable`. Missing environments now throw instead of soft-skipping.

  ### Runtime rewrite
  - `setup.ts`, `ControlBridge`, `TestRegistry`, `TestRunnerService`, `run.ts`, `state.ts` collapsed into a single `HarnessRuntime` root that owns connection, state, registry diff, and RPC forwarding.
  - Generated test-registry module replaced by `require.context` in `test-context.ts` (backed by new `inline-app-root-plugin`).
  - Explorer UI walks Vitest's native task tree directly; old `TestTreeNode` parallel tree deleted.
  - `ReactNativeRunner` simplified to `(config, runtime)` — delegates `onCollected`/`onTaskUpdate` to the runtime.
  - Task state (`collectedFiles`, `taskState`) lives on the runtime instance; entries are append-only across reruns.

  ### Other
  - New `vitest-compat-plugin.ts` rewrites Vitest dist for Hermes/Metro. Hermes-safe `node:*` stubs added.
  - Pool-side: `PauseController`, Metro log tailing, bundle server, and pool message types extracted into dedicated modules.

- 1434ccd: Per-project device ownership, interactive device picker, and a big CLI UX polish pass.

  **Project-scoped devices (iOS + Android).**
  - Each project now owns a specific simulator / AVD, stored in `~/.cache/vitest-mobile/devices.json` keyed by project path. Running Expo, Android Studio, or another vitest-mobile project on the same machine no longer collides with your tests.
  - `vitest-mobile bootstrap` always shows an interactive picker: your existing simulators/AVDs plus a "Create new dedicated device" option. Current mapping is pre-selected so hitting Enter keeps your choice.
  - `--device <name>` skips the picker (for CI and scripts). Non-TTY bootstrap auto-creates the project-scoped device.
  - On Android, "Create new" is annotated as unavailable and refused unless the Android cmdline-tools (`sdkmanager` + `avdmanager`) are installed — with a pointer to install them or pick an existing AVD instead.
  - `reset-device` now respects whether vitest-mobile created the device: deletes + clears the mapping if we created it, only clears the mapping if the user picked their own device.
  - iOS: existing `VitestMobile-<hash>` simulators are auto-registered into the mapping on first run (no re-prompt on upgrade).
  - Concurrent runs on the same project get a per-instance secondary simulator (iOS) / emulator instance (Android).

  **CLI UX polish.**
  - **Consistent `--platform` flag (breaking).** Every command takes `--platform <ios|android>` (previously some were positional, some `--platform`). The old `vitest-mobile build ios` form prints a clear migration hint and exits non-zero. Most commands prompt (TTY) or error (non-TTY) when `--platform` is omitted; `trim-cache` / `clean-devices` / `bundle` default to both platforms; `cache-key` still requires an explicit platform.
  - **Spinners with live step messages** for `build`, `install`, `bootstrap`, `bundle`, `boot-device` — instead of a wall of xcodebuild / gradle / pod-install output. Spinner now animates during long builds (the underlying spawn is async; previously a sync `execSync` blocked the event loop).
  - **Child-process output is tee'd to `~/.cache/vitest-mobile/logs/<timestamp>-<command>-<platform>.log`.** On failure the log path is printed; nothing is silently swallowed.
  - **Ctrl+C now works during long builds** (same async-spawn fix — SIGINT previously went to the blocked child instead of Node).
  - **Unknown commands exit 1** with a help dump (previously exited 0 silently).

  **Metro + native modules config.**
  - New `nativePlugin({ metro })` customizer and exported `MetroConfigCustomizer` type. Layers on top of the auto-generated harness-anchored base Metro config (runs before internal test transforms, so the vitest shim and test-registry stay authoritative). Composes across multiple plugin instances.
  - `build`, `install`, `bootstrap`, and `bundle` CLIs read `nativeModules` from the vitest config automatically; `--native-modules` overrides when passed.

  **Setup diagnostics.**
  - Simulator creation failures now report the real cause — unaccepted Xcode license, `xcode-select` pointing at Command Line Tools, missing iOS runtime. Preflight checks before `xcodebuild` catch SDK/runtime mismatch upfront.

  **Build system.**
  - Xcode 26.4 compat: bundled `fmt` pod pinned to C++17 so RCT-Folly compiles under Apple Clang 21. Harness build format bumped to v5 — existing cached binaries rebuild once.

  **Fixes.**
  - `promptConfirm` no longer leaks a stdin resume that kept `bootstrap` alive after accepting the prompt.

### Patch Changes

- 01ce6fe: Collapse the pool worker lifecycle to fire once per user-initiated run instead of once per file, by setting `test.isolate = false` in the plugin's config hook.

  **Why.** With `isolate: true` (the previous default), Vitest's scheduler created one `PoolRunner` per test file, meaning `worker.start()` and `worker.stop()` — and the 60s / 90s handshake timeouts guarding them — fired N times per run. The React Native harness shares a single JS VM across files anyway, so the per-file isolation was a fiction maintained by singleton idempotency flags. Under `isolate: false` + `maxWorkers: 1`, Vitest bundles every file into one task with `context.files = [all]`, and the handshake timers fire exactly once per user-initiated run (initial or HMR-driven rerun). Timer scope now matches reality.

  **Changes.**
  - `test.isolate = false` is applied by the plugin, guarded so user-level overrides win.
  - `canReuse: () => true` added to the pool worker.
  - Device-side `handleRun` refactored into a per-file loop so explorer file-start/file-done UI events still fire per file; test execution inside `startTests` is unchanged.
  - Removed dead code: the fallback `__rerun` replay path (Vitest ^4's `rerunFiles` is guaranteed), the `_lastRunMessages` map, `_sessionCount`, `countTestsInSpecs`, and the triple-keying of file identifiers. Reporter shrunk to a pass-through for `__native_run_start` / `__native_run_end` plus the `run`-mode `teardown()` await.

  No user-visible behavior change. Custom Vitest pools, test configs that explicitly set `test.isolate`, and the device-side test execution path are all unaffected.

## 0.1.1

### Patch Changes

- 5c06893: Includes missing files in publish

## 0.1.0

### Minor Changes

- 62f1809: Initial Release
- 759910b: Initial release of vitest-mobile
