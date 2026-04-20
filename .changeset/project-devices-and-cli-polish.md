---
'vitest-mobile': minor
---

Per-project device ownership, interactive device picker, and a big CLI UX polish pass.

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
