---
"vitest-mobile": minor
---

The harness builder now auto-wires Expo modules autolinking whenever a user
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
