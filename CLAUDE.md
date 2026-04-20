# Contributing to vitest-mobile

## Project Structure

Monorepo using npm workspaces with two workspace roots:

- `packages/vitest-mobile/` — the main package (Vitest custom pool + runtime + native modules + CLI)
- `test-packages/` — example test modules (counter, greeting, toggle, todo-list)

Root-level files (`index.js`, `index.ios.js`, `vitest.config.ts`) are auto-generated harness entry points.

```
vitest-mobile/
├── packages/
│   └── vitest-mobile/           # The main package
│       ├── src/
│       │   ├── node/            # Vitest plugin, pool worker, device control
│       │   ├── runtime/         # Device-side: runner, render, locators
│       │   ├── babel/           # Test file wrapper plugin
│       │   ├── metro/           # Metro config helpers + test registry generator
│       │   └── cli/             # CLI commands (boot, build, debug, screenshot)
│       ├── ios/                 # Native TurboModule (Objective-C++)
│       ├── android/             # Native TurboModule (Java/JNI)
│       ├── dist/                # Built output (tsup)
│       └── tests/               # Unit + integration + e2e tests
├── test-packages/               # Example test modules
├── vitest.config.ts             # Root Vitest config (ios + android projects)
├── index.js / index.ios.js      # Auto-generated harness entry points
└── .github/workflows/ci.yml     # CI pipeline
```

## Architecture Overview

Test files are transformed by a Babel plugin (injected automatically via a custom Metro transformer) that wraps `describe()`/`it()` calls in an `exports.__run` function, making them safe to `require()` without an active runner context. The runner calls `__run()` inside `startTests()` where vitest's suite collector is active.

For a full architecture walkthrough, see [`packages/vitest-mobile/docs/architecture.md`](packages/vitest-mobile/docs/architecture.md).

## Prerequisites

| Tool         | Version      | Notes                                             |
| ------------ | ------------ | ------------------------------------------------- |
| Node.js      | >= 18        | LTS recommended                                   |
| npm          | >= 9         | Ships with Node 18+                               |
| Xcode        | >= 15        | iOS only — includes `xcrun simctl`                |
| Android SDK  | API 35       | Android only — includes `adb`, `avdmanager`       |
| Java         | 17 (Temurin) | Android only                                      |
| Vitest       | ^4.0         | Peer dependency                                   |
| React Native | >= 0.81.5    | New Architecture (Fabric + TurboModules) required |

## Getting Started

```bash
git clone <repo-url>
cd vitest-mobile
npm install
npm run build
```

## Development Workflow

### Building the Package

```bash
# One-time build
npm run build

# Watch mode (rebuilds on source changes in packages/vitest-mobile/src)
npm run dev
```

The dev loop:

1. Make code change in `packages/vitest-mobile/src/`
2. tsup watch (`npm run dev`) rebuilds `dist/`
3. Metro detects change in `dist/` and serves updated bundle
4. App reloads (may need manual relaunch — see Common Issues below)
5. Verify via screenshot + CDP eval + log tailing

### Running Tests Locally

```bash
# Boot a device
npx vitest-mobile boot-device --platform ios

# Build + install the test harness app (~5 min first build, cached after)
npx vitest-mobile bootstrap --platform ios

# Run all tests
npx vitest run --project ios

# Watch mode (re-runs on file changes)
npx vitest --project ios
```

Replace `--platform ios` with `--platform android` for Android. Android also supports `--headless --api-level 35`.

### Iterating on Components

1. Write a component + test with `pause()` at the point you want to inspect
2. Run the test via `npx vitest --project ios`
3. Test executes up to `pause()` and blocks
4. Take a screenshot: `npx vitest-mobile screenshot --platform ios`
5. Edit the component — Metro HMR updates it live on the device
6. When satisfied, remove `pause()` and the test runs to completion

### Code Quality

```bash
npm run lint          # ESLint
npm run check-types   # TypeScript
npm run format        # Prettier (write)
npm run format:check  # Prettier (check only)
```

All four must pass before merging — CI enforces this.

## CLI Commands

All commands: `npx vitest-mobile <command>`

### Device & App Lifecycle

```bash
npx vitest-mobile boot-device --platform ios
npx vitest-mobile build --platform ios
npx vitest-mobile install --platform ios
npx vitest-mobile bootstrap --platform ios        # build + install in one step

# Manual launch on simulator
xcrun simctl terminate booted com.vitest.mobile.harness
xcrun simctl launch booted com.vitest.mobile.harness --initialUrl "http://127.0.0.1:8081"
```

In a TTY, `--platform` can be omitted on most commands and you'll be prompted to pick one. In CI / non-TTY contexts, omitting `--platform` errors for commands that can't sensibly default to "both" (build, bootstrap, boot-device, reset-device). Fast filesystem-only commands (`trim-cache`, `clean-devices`, `bundle`) default to both platforms when `--platform` is omitted.

### Debugging & Inspection

```bash
npx vitest-mobile debug eval "<expression>"
npx vitest-mobile debug open
npx vitest-mobile screenshot --platform ios
```

## CDP Evaluation Patterns

The `debug eval` command is the primary tool for inspecting app state from outside.

### Hermes Bridgeless Limitations

- `require()` does NOT work in CDP eval — use `globalThis` for accessing registered globals
- Use `globalThis` not `global` (doesn't exist in Hermes)
- `Runtime.enable` times out — the debug command skips it automatically
- `__r.getModules()` may return empty with lazy bundling
- `__r.resolveWeak()` only works at bundle time, not dynamically

### Useful Eval Expressions

```bash
# Check test file registry
npx vitest-mobile debug eval "JSON.stringify(Object.keys(globalThis.__TEST_FILES__ || {}))"

# Check if a test module has the babel plugin's __run wrapper
npx vitest-mobile debug eval "(function() { var f = globalThis.__TEST_FILES__; var m = f && f['counter/counter.test.tsx'](); return JSON.stringify({ hasRun: typeof m?.__run, keys: Object.keys(m || {}) }); })()"

# Check HMR listener state
npx vitest-mobile debug eval "globalThis.__TEST_HMR_LISTENERS__?.size ?? 'none'"

# Trigger HMR listeners manually (simulate file change)
npx vitest-mobile debug eval "(function() { var l = globalThis.__TEST_HMR_LISTENERS__; if (l) { l.forEach(function(fn) { fn('counter/counter.test.tsx'); }); return 'notified ' + l.size; } return 'no listeners'; })()"
```

## CI/CD Pipeline

The repository uses GitHub Actions (`.github/workflows/ci.yml`). The pipeline runs on pushes to `main` and on pull requests.

### Pipeline Overview

| Job                | Runner          | Trigger   | Purpose                                           |
| ------------------ | --------------- | --------- | ------------------------------------------------- |
| `lint-typecheck`   | `ubuntu-latest` | push + PR | Lint, type check, format check                    |
| `unit-tests`       | `ubuntu-latest` | push + PR | Unit and integration tests                        |
| `e2e-android`      | `ubuntu-latest` | push + PR | Android E2E with build cache                      |
| `e2e-ios`          | `macos-latest`  | push + PR | iOS E2E with build cache                          |
| `e2e-android-full` | `ubuntu-latest` | push only | Android E2E without cache (verifies clean builds) |
| `e2e-ios-full`     | `macos-latest`  | push only | iOS E2E without cache                             |

### How It Works

**1. Lint & Type Checks** — runs on every push and PR:

```yaml
- npm ci
- npm run build --workspace=packages/vitest-mobile
- npm run lint
- npm run check-types
- npm run format:check
```

**2. Unit & Integration Tests** — runs the package's own test suite:

```yaml
- npm ci
- npm test # in packages/vitest-mobile
```

**3. E2E Tests (Cached)** — runs on every push and PR with build caching for fast iteration:

```yaml
# Android-specific setup
- uses: actions/setup-java@v4 # Java 17 for Gradle
- Enable KVM for hardware-accelerated emulator

# Shared steps (both platforms)
- npm ci
- npm run build --workspace=packages/vitest-mobile
- Compute cache key: npx vitest-mobile cache-key --platform <platform>
- Restore cache: ~/.cache/vitest-mobile (+ Android SDK images)
- Bootstrap: npx vitest-mobile bootstrap --platform <platform> --headless
- Pre-build bundle: npx vitest-mobile bundle --platform <platform>
- Run tests: npx vitest run --project <platform>
- Save cache
```

The `cache-key` command generates a deterministic hash from native dependencies so that the built binary is only rebuilt when native code changes. The `--headless` flag runs the emulator without a display (required in CI). The `bundle` command pre-builds the JS bundle so tests don't wait for Metro to serve it on first request.

**4. Full Build (Push to main only)** — identical to cached E2E but uses `--force` to skip the cache, ensuring clean builds always work:

```yaml
- npx vitest-mobile bootstrap --platform <platform> --headless --force
```

## Releasing

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.

```bash
# Add a changeset (interactive — choose package, semver bump, and description)
npx changeset

# Preview what will be released
npx changeset status

# Build and publish
npm run release    # runs: npm run build && changeset publish
```

Changesets are committed as markdown files in `.changeset/` and consumed during publish. The package is configured for public access (`"access": "public"` in `.changeset/config.json`).

## Key Files

### Package Source (`packages/vitest-mobile/src/`)

| Path                           | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `runtime/harness.tsx`          | Root component for the test harness app                  |
| `runtime/runner.ts`            | VitestRunner implementation — importFile, onAfterRunTask |
| `runtime/vitest-shim.ts`       | Metro resolves `vitest` → this shim                      |
| `runtime/expect-setup.ts`      | Sets up chai + @vitest/expect for Hermes                 |
| `runtime/setup.ts`             | WebSocket connection to Vitest pool (connected mode)     |
| `runtime/context.tsx`          | TestContainerProvider — where render() puts components   |
| `runtime/pause.ts`             | Pause/resume test execution                              |
| `runtime/screenshot.ts`        | Screenshot API                                           |
| `babel/test-wrapper-plugin.ts` | Babel plugin wrapping test files                         |
| `metro/transformer.ts`         | Custom Metro transformer that injects the babel plugin   |
| `metro/withNativeTests.ts`     | Metro config helper                                      |
| `node/pool.ts`                 | Vitest custom pool worker                                |
| `runtime/symbolicate.ts`       | Stack trace symbolication via Metro's /symbolicate       |
| `node/device.ts`               | Device management (boot, launch, screenshot)             |
| `node/code-frame.ts`           | Syntax-highlighted code snippets for errors              |
| `cli/index.ts`                 | CLI dispatcher                                           |
| `cli/debug.ts`                 | CDP debugging tools                                      |

### Root App Files

| Path                               | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `index.js` / `index.ios.js`        | Auto-generated — creates harness, registers with AppRegistry |
| `vitest.config.ts`                 | Vitest config for connected mode (ios + android projects)    |
| `test-packages/*/tests/*.test.tsx` | Test files                                                   |

## Common Issues

**"Requiring unknown module NNN"** — Module code not in the bundle. Caused by lazy bundling or missing static dependencies. Clear the Metro cache: `npx expo start --dev-client --clear`

**"Vitest failed to find the current suite"** — `describe()`/`it()` called without runner context. The babel plugin should prevent this. Check:

- Clear Metro cache
- Verify the test file is being transformed (check for `exports.__run` in the bundled output)

**App crashes on reload (`r`)** — Dev client serves 1-module bundle. Workaround:

```bash
xcrun simctl terminate booted com.vitest.mobile.harness
xcrun simctl launch booted com.vitest.mobile.harness --initialUrl "http://127.0.0.1:8081"
```

**"No development build installed"** — Rebuild native binary: `npx vitest-mobile bootstrap --platform ios`

**Process hanging after tests complete** — The WebSocket server may keep the event loop alive. This is a known upstream issue with the Vitest custom pool API — there's no `close()` lifecycle hook to distinguish "file done" from "run done." See `.github/vitest-custom-pool-close-rfc.md`.

## Known Gaps

- **Cannot run tests programmatically via CDP** — `require()` doesn't work in Hermes CDP eval. Tests must be triggered via HMR file changes.
- **HMR re-runs not fully working** — Notification chain works but re-execution has issues with module cache and test result collection. Active area of development.
- **No console log streaming to agent** — `Runtime.enable` times out on Hermes bridgeless. Logs only appear in Expo terminal.
- **test.only / it.only may not work** — Needs verification.
- **App reload fragile** — Pressing `r` sometimes produces 1-module bundle. Use terminate + relaunch.
- **No programmatic tap** — `xcrun simctl io booted tap` not supported on iOS. CLI `tap`/`type-text` commands exist but limited.
