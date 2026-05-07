---
"vitest-mobile": patch
---

Pin `install-expo-modules` to `0.14.21` so the Expo autolinking step
succeeds on Linux runners (Android-only CI).

`install-expo-modules@0.14.18` (the version currently published behind
upstream's `latest` tag) ships without the `process.platform === 'darwin'`
gate around its final `pod install --repo-update` step, so on Linux it
crashes with `ENOENT spawn pod` and bootstrap aborts before
`patchAppDelegateForExpo` can run. `0.14.21` (newest stable) has the gate
restored. Switch from `@latest` to a pinned version so we pick up the
fix regardless of which `install-expo-modules` version upstream tags as
`latest` next.
