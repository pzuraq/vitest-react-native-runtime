---
'vitest-mobile': patch
---

Collapse the pool worker lifecycle to fire once per user-initiated run instead of once per file, by setting `test.isolate = false` in the plugin's config hook.

**Why.** With `isolate: true` (the previous default), Vitest's scheduler created one `PoolRunner` per test file, meaning `worker.start()` and `worker.stop()` — and the 60s / 90s handshake timeouts guarding them — fired N times per run. The React Native harness shares a single JS VM across files anyway, so the per-file isolation was a fiction maintained by singleton idempotency flags. Under `isolate: false` + `maxWorkers: 1`, Vitest bundles every file into one task with `context.files = [all]`, and the handshake timers fire exactly once per user-initiated run (initial or HMR-driven rerun). Timer scope now matches reality.

**Changes.**

- `test.isolate = false` is applied by the plugin, guarded so user-level overrides win.
- `canReuse: () => true` added to the pool worker.
- Device-side `handleRun` refactored into a per-file loop so explorer file-start/file-done UI events still fire per file; test execution inside `startTests` is unchanged.
- Removed dead code: the fallback `__rerun` replay path (Vitest ^4's `rerunFiles` is guaranteed), the `_lastRunMessages` map, `_sessionCount`, `countTestsInSpecs`, and the triple-keying of file identifiers. Reporter shrunk to a pass-through for `__native_run_start` / `__native_run_end` plus the `run`-mode `teardown()` await.

No user-visible behavior change. Custom Vitest pools, test configs that explicitly set `test.isolate`, and the device-side test execution path are all unaffected.
