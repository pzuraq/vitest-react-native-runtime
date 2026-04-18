# vitest-mobile

Run Vitest component tests inside a real React Native app. Tests execute using real native views and real touch events, not mocked renderers or simulated interactions.

![vitest-mobile demo](./demo.webp)

The pool boots an emulator/simulator, launches a React Native app, connects over WebSocket, and sends test files to run.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Vitest Config](#vitest-config)
- [Writing Tests](#writing-tests)
- [Test API Reference](#test-api-reference)
- [CLI Reference](#cli-reference)
- [CI/CD](#cicd)
- [Troubleshooting](#troubleshooting)

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

## Quick Start

Install the package:

```bash
npm install vitest-mobile
```

Create a `vitest.config.ts` at the root of your project with the `nativePlugin`:

```typescript
import { defineConfig } from 'vitest/config';
import { nativePlugin } from 'vitest-mobile';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [nativePlugin({ platform: 'ios' })],
        test: {
          name: 'ios',
          include: ['test-packages/**/tests/**/*.test.tsx'],
        },
      },
      {
        plugins: [nativePlugin({ platform: 'android' })],
        test: {
          name: 'android',
          include: ['test-packages/**/tests/**/*.test.tsx'],
        },
      },
    ],
  },
});
```

Bootstrap the test harness app and run the tests:

```bash
# Generate, build, and install the test harness app (~5 min first build)
npx vitest-mobile bootstrap ios

# Run tests
npx vitest run --project ios
```

For Android:

```bash
# Generate, build, and install the test harness app (~5 min first build)
npx vitest-mobile bootstrap android
npx vitest run --project android
```

## Writing Tests

Tests look like standard Vitest tests, but use `vitest-mobile/runtime` for rendering into real native views:

```tsx
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from 'vitest-mobile/runtime';
import { CounterModule } from '../CounterModule';

afterEach(async () => {
  await cleanup();
});

describe('CounterModule', () => {
  it('renders initial count of zero', async () => {
    const screen = await render(<CounterModule userId="123" />);
    await expect.element(screen.getByTestId('count-display')).toHaveText('0');
  });

  it('increments on press', async () => {
    const screen = await render(<CounterModule userId="123" />);
    await screen.getByTestId('increment-btn').tap();
    await expect.element(screen.getByTestId('count-display')).toHaveText('1');
  });
});
```

## Test API Reference

### Rendering

```typescript
import { render, cleanup, waitFor, screenshot, pause } from 'vitest-mobile/runtime';
```

| Function                         | Description                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `render(<Component />)`          | Mount a component into the test container. Returns a `Screen` with locator methods. |
| `cleanup()`                      | Unmount the rendered component and flush the UI queue.                              |
| `waitFor(fn, opts?)`             | Retry an assertion until it passes. Default 3s timeout, 50ms interval.              |
| `screenshot(name?)`              | Capture the emulator screen, returns host file path (PNG).                          |
| `pause({ label?, screenshot? })` | Block test execution until resumed.                                                 |

### Screen

| Method                      | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `screen.getByTestId(id)`    | Find element by `testID`. Returns `Locator`. Throws if not found. |
| `screen.getByText(text)`    | Find element containing text. Returns `Locator`.                  |
| `screen.getAllByTestId(id)` | Find all matching elements.                                       |
| `screen.queryByTestId(id)`  | Returns `Locator \| null` (no throw).                             |
| `screen.findByTestId(id)`   | Async — waits until element appears.                              |
| `screen.findByText(text)`   | Async — waits until text appears.                                 |
| `screen.dumpTree()`         | Returns an indented text representation of the view tree.         |
| `screen.getTree()`          | Returns a structured `ViewTreeNode` object.                       |

### Locator

| Method                | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `locator.tap()`       | Dispatch a real native tap event via the TurboModule. |
| `locator.longPress()` | Dispatch a real native long press.                    |
| `locator.type(text)`  | Type text into a focused input via native text input. |
| `locator.text`        | Current text content (sync, re-queries on access).    |
| `locator.exists`      | Whether the element is in the tree.                   |

### Custom Matchers

| Matcher                                | Description                       |
| -------------------------------------- | --------------------------------- |
| `expect(locator).toBeVisible()`        | Element exists and is not hidden. |
| `expect(locator).toHaveText('...')`    | Text content matches exactly.     |
| `expect(locator).toContainText('...')` | Text content contains the string. |

Use `expect.element(locator)` for automatic retrying:

```tsx
await expect.element(screen.getByTestId('count')).toHaveText('1');
```

## CLI Reference

All commands are run via `npx vitest-mobile <command>`.

### Device & App Lifecycle

```bash
# Boot a simulator / emulator
npx vitest-mobile boot-device ios
npx vitest-mobile boot-device android

# Build the native harness binary (~5 min first time, cached after)
npx vitest-mobile build ios
npx vitest-mobile build android

# Install the built binary onto the device
npx vitest-mobile install ios

# Build + install in one step
npx vitest-mobile bootstrap ios
npx vitest-mobile bootstrap android --headless --api-level 35
```

### Debugging & Inspection

```bash
# Evaluate a JS expression in the running app via CDP
npx vitest-mobile debug eval "<expression>"

# Open the JS debugger
npx vitest-mobile debug open

# Take a screenshot of the simulator
npx vitest-mobile screenshot --platform ios
```

### Running Tests

```bash
# Run all tests on iOS
npx vitest run --project ios

# Run all tests on Android
npx vitest run --project android

# Watch mode (re-runs on file changes)
npx vitest --project ios
```

### Useful CDP Eval Expressions

```bash
# Check test file registry
npx vitest-mobile debug eval "JSON.stringify(Object.keys(globalThis.__TEST_FILES__ || {}))"

# Check if a test module has the babel plugin's __run wrapper
npx vitest-mobile debug eval "(function() { var f = globalThis.__TEST_FILES__; var m = f && f['counter/counter.test.tsx'](); return JSON.stringify({ hasRun: typeof m?.__run, keys: Object.keys(m || {}) }); })()"
```

## CI/CD

To add vitest-mobile E2E tests to your CI pipeline:

#### Android

```yaml
name: Native Tests (Android)
on: [push, pull_request]

jobs:
  e2e-android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17

      - run: npm ci

      # Enable KVM for hardware-accelerated Android emulator
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' \
            | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      # Build native binary, boot emulator, install app
      - run: npx vitest-mobile bootstrap android --headless --api-level 35

      # Pre-build the JS bundle for faster test startup
      - run: npx vitest-mobile bundle --platform android

      # Run tests
      - run: npx vitest run --project android
```

#### iOS

```yaml
name: Native Tests (iOS)
on: [push, pull_request]

jobs:
  e2e-ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npx vitest-mobile bootstrap ios --headless
      - run: npx vitest-mobile bundle --platform ios
      - run: npx vitest run --project ios
```

#### Adding Build Caching

To avoid rebuilding the native binary on every CI run, cache the `~/.cache/vitest-mobile` directory. The `cache-key` command generates a deterministic key:

```yaml
- name: Compute cache key
  id: cache-key
  run: echo "key=android-e2e-$(npx vitest-mobile cache-key android)" >> "$GITHUB_OUTPUT"

- uses: actions/cache/restore@v4
  with:
    path: ~/.cache/vitest-mobile
    key: ${{ steps.cache-key.outputs.key }}
    restore-keys: android-e2e-

# ... bootstrap + test steps ...

- uses: actions/cache/save@v4
  with:
    path: ~/.cache/vitest-mobile
    key: ${{ steps.cache-key.outputs.key }}
```

For Android, also cache the system image to avoid re-downloading:

```yaml
path: |
  ~/.cache/vitest-mobile
  /usr/local/lib/android/sdk/system-images/android-35
```

## Troubleshooting

### "Requiring unknown module NNN"

Module code is not in the bundle. Caused by lazy bundling or missing static dependencies. Try clearing the Metro cache:

```bash
npx expo start --dev-client --clear
```

### "Vitest failed to find the current suite"

`describe()`/`it()` called without runner context. The babel plugin should prevent this. Check:

1. Clear Metro cache
2. Verify the test file is being transformed (check for `exports.__run` in the bundled output)

### App crashes on reload

The dev client sometimes serves a 1-module bundle. Workaround — terminate and relaunch:

```bash
xcrun simctl terminate booted com.vitest.mobile.harness
xcrun simctl launch booted com.vitest.mobile.harness --initialUrl "http://127.0.0.1:8081"
```

### "No development build installed"

Rebuild the native binary:

```bash
npx vitest-mobile bootstrap ios
```

### Process hanging after tests complete

The WebSocket server may keep the event loop alive. This is a [known upstream issue](/.github/vitest-custom-pool-close-rfc.md) with the Vitest custom pool API — there's no `close()` lifecycle hook to distinguish "file done" from "run done."

## License

MIT
