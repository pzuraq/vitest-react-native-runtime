# vitest-react-native-runtime

## Project Structure

Monorepo with workspaces:
- `packages/vitest-react-native-runtime/` — the main package (Vitest custom pool + runtime + native modules + CLI)
- `test-app/` — test harness Expo app that runs on the device
- `test-app/packages/` — test modules (counter, greeting, toggle, todo-list, agent-verify)

## Architecture Overview

The test harness has two modes:
- **Explorer mode** (default): Standalone UI for browsing/running tests without Vitest
- **Connected mode**: Headless mode driven by Vitest pool over WebSocket

Test files are transformed by a Babel plugin (`vitest-react-native-runtime/babel-plugin`) that wraps `describe()`/`it()` calls in an `exports.__run` function, making them safe to `require()` without an active runner context. The runner calls `__run()` inside `startTests()` where vitest's suite collector is active.

## CLI Commands

All commands: `npx vitest-react-native-runtime <command>`

### Device & App Lifecycle

```bash
# Boot iOS simulator
npx vitest-react-native-runtime boot-device ios

# Build + install app on simulator (requires Xcode, takes ~5min first time)
npx vitest-react-native-runtime bootstrap ios

# Start Expo dev server with TTY passthrough + file watcher
# Interactive: i=open iOS, j=debugger, r=reload, Ctrl+C=quit
npx vitest-react-native-runtime start

# Launch app manually on simulator (if not using Expo's 'i' command)
xcrun simctl terminate booted com.vitest.nativetest
xcrun simctl launch booted com.vitest.nativetest --initialUrl "http://127.0.0.1:8081"

# Check environment health
npx vitest-react-native-runtime status --platform ios
npx vitest-react-native-runtime doctor
```

### Debugging & Inspection

```bash
# Evaluate JS in the running app via Chrome DevTools Protocol
npx vitest-react-native-runtime debug eval "<expression>"
npx vitest-react-native-runtime debug eval --json "<expression>"
npx vitest-react-native-runtime debug eval --file script.js

# Check Metro/CDP status
npx vitest-react-native-runtime debug status

# Stream console.log output from the app
npx vitest-react-native-runtime debug logs

# Take a screenshot of the simulator
npx vitest-react-native-runtime screenshot --platform ios

# Dump the app's view hierarchy via CDP
npx vitest-react-native-runtime tree
npx vitest-react-native-runtime tree --json
```

### Process Management

```bash
# Kill stuck Metro/WS processes on ports 8081 and 7878
npx vitest-react-native-runtime kill

# Kill a specific port
npx vitest-react-native-runtime kill --port 8081
```

### Reading Logs

```bash
# Read Metro logs (when using 'start' command, logs go to .vitest-native/app.log)
npx vitest-react-native-runtime logs --app-dir test-app
npx vitest-react-native-runtime logs --lines 50 --app-dir test-app

# Or read the log file directly
tail -30 test-app/.vitest-native/app.log
```

### Running Tests

```bash
# Via Vitest (connected mode — pool drives execution)
cd test-app && npx vitest run
cd test-app && npx vitest dev

# Via Explorer UI (standalone mode — tap modules in the app UI)
npx vitest-react-native-runtime start

# Build the package
npm run build

# Watch mode (rebuilds on source changes — run alongside Expo)
npm run dev
```

## In-Test APIs

```typescript
import {
  render, cleanup, waitFor,
  screenshot, pause,
  getViewTree, getViewTreeString,
} from 'vitest-react-native-runtime/runtime';
```

- `render(<Component />)` — renders into the test container, returns a `Screen` with locator methods
- `cleanup()` — unmounts the rendered component
- `waitFor(() => expect(...))` — retries an assertion until it passes
- `screenshot(name?)` — captures the emulator screen, returns host file path (PNG). No-ops in standalone/explorer mode.
- `pause({ label?, screenshot? })` — blocks test execution. In explorer mode, shows a Continue button. In connected mode, blocks until resumed via Enter key or CLI.
- `screen.dumpTree()` — returns an indented text representation of the rendered view tree
- `screen.getTree()` — returns a structured `ViewTreeNode` object
- `screen.findByTestId(id)` — async find element by testID
- `screen.getByTestId(id)` — sync find (throws if not found)
- `element.tap()` — simulate touch
- `element.type(text)` — simulate text input
- `expect(element).toHaveText(text)` — assert element text
- `expect(element).toBeVisible()` — assert element visibility

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
npx vitest-react-native-runtime debug eval "JSON.stringify(Object.keys(globalThis.__TEST_FILES__ || {}))"

# Check if a test module has the babel plugin's __run wrapper
npx vitest-react-native-runtime debug eval "(function() { var f = globalThis.__TEST_FILES__; var m = f && f['counter/counter.test.tsx'](); return JSON.stringify({ hasRun: typeof m?.__run, keys: Object.keys(m || {}) }); })()"

# Check HMR listener state
npx vitest-react-native-runtime debug eval "globalThis.__TEST_HMR_LISTENERS__?.size ?? 'none'"

# Trigger HMR listeners manually (simulate file change)
npx vitest-react-native-runtime debug eval "(function() { var l = globalThis.__TEST_HMR_LISTENERS__; if (l) { l.forEach(function(fn) { fn('counter/counter.test.tsx'); }); return 'notified ' + l.size; } return 'no listeners'; })()"
```

## Agent Workflow for Component Development

1. Write a component + test with `pause()` at the point you want to inspect
2. Run the test via the Explorer UI or `npx vitest dev`
3. Test executes up to `pause()`, shows Continue button (explorer) or blocks (connected)
4. Take a screenshot: `npx vitest-react-native-runtime screenshot`
5. Inspect the view tree via `screen.dumpTree()` in the test
6. Edit the component — Metro HMR updates it live on the device
7. Take more screenshots to see changes
8. When satisfied, remove `pause()` and the test runs to completion

## Development Workflow

1. Make code change in `packages/vitest-react-native-runtime/src/`
2. tsup watch (`npm run dev`) rebuilds `dist/`
3. Metro detects change in `dist/` and serves updated bundle
4. App reloads (may need manual relaunch — see Common Issues)
5. Verify via screenshot + CDP eval + log tailing

## Common Issues

**"Requiring unknown module NNN"** — Module code not in the bundle. Caused by lazy bundling or missing static dependencies. Check that test-imports.ts has the file listed.

**"Vitest failed to find the current suite"** — `describe()`/`it()` called without runner context. The babel plugin should prevent this. Check:
- `test-app/babel.config.js` includes `'vitest-react-native-runtime/babel-plugin'`
- Clear Metro cache: `npx expo start --dev-client --clear`

**App crashes on reload (`r`)** — Dev client serves 1-module bundle. Workaround:
```bash
xcrun simctl terminate booted com.vitest.nativetest
xcrun simctl launch booted com.vitest.nativetest --initialUrl "http://127.0.0.1:8081"
```

**"No development build installed"** — Rebuild native binary:
```bash
cd test-app && npx vitest-react-native-runtime bootstrap ios
```

## Key Files

### Package Source (`packages/vitest-react-native-runtime/src/`)

| Path | Purpose |
|------|---------|
| `runtime/harness.tsx` | Root component — mode switching (explorer vs connected) |
| `runtime/explorer/TestExplorer.tsx` | Navigation root for explorer mode |
| `runtime/explorer/ModuleListScreen.tsx` | Module list with multi-select |
| `runtime/explorer/TestRunnerScreen.tsx` | Test runner with results panel |
| `runtime/standalone-runner.ts` | Runs tests without Vitest pool |
| `runtime/runner.ts` | VitestRunner implementation — importFile, onAfterRunTask |
| `runtime/vitest-shim.ts` | Metro resolves `vitest` → this shim |
| `runtime/expect-setup.ts` | Sets up chai + @vitest/expect for Hermes |
| `runtime/setup.ts` | WebSocket connection to Vitest pool (connected mode) |
| `runtime/context.tsx` | TestContainerProvider — where render() puts components |
| `runtime/pause.ts` | Pause/resume test execution |
| `runtime/screenshot.ts` | Screenshot API |
| `babel/test-wrapper-plugin.ts` | Babel plugin wrapping test files |
| `metro/withNativeTests.ts` | Metro config helper |
| `node/pool.ts` | Vitest custom pool worker |
| `node/device.ts` | Device management (boot, launch, screenshot) |
| `cli/index.ts` | CLI dispatcher |
| `cli/start.ts` | Expo launcher with node-pty + file watcher |
| `cli/debug.ts` | CDP debugging tools |
| `cli/console.ts` | Interactive CDP REPL |

### Test App (`test-app/`)

| Path | Purpose |
|------|---------|
| `App.tsx` | Root — imports test-imports, creates harness |
| `src/test-imports.ts` | Static test file registry with HMR support |
| `metro.config.js` | Uses `withNativeTests()` for vitest module resolution |
| `babel.config.js` | Includes test-wrapper babel plugin |
| `vitest.config.ts` | Vitest config for connected mode |
| `packages/*/tests/*.test.tsx` | Test files |

## Known Gaps

- **Cannot run tests programmatically via CDP** — `require()` doesn't work in Hermes CDP eval. Tests must be triggered via Explorer UI or HMR file changes.
- **HMR re-runs not fully working** — Notification chain works but re-execution has issues with module cache and test result collection. Active area of development.
- **No console log streaming to agent** — `Runtime.enable` times out on Hermes bridgeless. Logs only appear in Expo terminal. Use `start` command to capture to `.vitest-native/app.log`.
- **test.only / it.only may not work** — Needs verification in standalone mode.
- **App reload fragile** — Pressing `r` sometimes produces 1-module bundle. Use terminate + relaunch.
- **No programmatic tap** — `xcrun simctl io booted tap` not supported on iOS. CLI `tap`/`type-text` commands exist but limited.
