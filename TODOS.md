# TODOs

Tracked gaps and planned work for vitest-react-native-runtime.

---

## Critical — Blocking test execution

- [ ] **Root cause: app wasn't loading Metro's dev bundle**
      Diagnosed via CDP: module registry had 0 modules. The app ran its embedded bundle because `expo-dev-client` was missing. Fixed by adding it to the init flow via `npx expo install expo-dev-client`.

- [ ] **Add CDP debugger access (CLI)**
      `npx vitest-react-native-runtime debug eval|status|logs` — connects to Hermes via CDP WebSocket. Written in `src/cli/debug.ts`.

- [ ] **Refactor require cycle: `setup.ts <-> pause.ts`**
      Extracted shared state into `state.ts`. No more circular dependency.

- [ ] **Fix expo-dev-client auto-connect on launch**
      The dev client shows a launcher UI instead of auto-connecting to Metro. The pool passes `EXDevClientUrl` as a launch arg but the dev client ignores it and shows the picker. Deep linking via `<scheme>://expo-development-client/?url=...` works but triggers an iOS confirmation dialog. Need to find how `npx expo start` + pressing `i` bypasses this.

---

## CLI enhancements — Keep agents on the happy path

- [ ] **`npx vitest-react-native-runtime status`**
      Single command that checks everything and reports:
  - Simulator/emulator booted? (which device, OS version)
  - App installed?
  - App running?
  - Metro running? (check port 8081)
  - Vitest WS server running? (check port 7878)
  - App connected to Metro?
    Print a clear summary with pass/fail for each check.

- [ ] **`npx vitest-react-native-runtime logs [--lines N]`**
      Read the last N lines from `app/.vitest-native/metro.log`. Filtered to remove noise, show errors prominently. Falls back to device logs if metro log doesn't exist.

- [ ] **`npx vitest-react-native-runtime doctor` improvements**
      Currently checks env tools. Should also check:
  - Is a simulator booted?
  - Is the app installed?
  - Is the app the latest build? (compare build hash or timestamp)
  - Are ports 8081/7878 free or already in use by expected processes?

- [ ] **`npx vitest-react-native-runtime kill`**
      Clean up stuck state: kill Metro, kill WS server, free ports 8081 and 7878. Agents currently have to do `lsof -ti :8081 | xargs kill -9` manually.

- [ ] **`npx vitest-react-native-runtime bundle-check`**
      Fetch the Metro bundle, analyze module count, check for resolution errors. Quick sanity check that the bundle is healthy before running tests.

---

## Metro / Build

- [x] **Persist metro logs to `.vitest-native/metro.log`**
      Pool now writes all Metro stdout/stderr to disk so agents can read logs after the fact.

- [x] **Rewrite `init` command to use `create-expo-app`**
      Uses Expo's scaffolding for version-compatible deps, then layers on vitest config, metro resolver, workspaces, and example package. Uses `npx expo install` for Expo-ecosystem packages.

- [ ] **Investigate `--clear` vs lazy loading**
      Pool starts Metro without `--clear`. Adding it didn't fix the runtime error. The real issue might be `lazy=true` in the bundle URL (from Expo dev client manifest). Need to check if non-lazy bundle works.

- [ ] **Add root `npm run build` script**
      Currently must use `npm run build -w packages/vitest-react-native-runtime`. Add a root alias.

---

## Agent experience

- [ ] **Programmatic console log capture**
      App console output only shows in vitest's stdout stream. Add a way to capture and query it — either via CDP, or by persisting to a log file like metro logs.

- [ ] **HMR verification**
      No way to programmatically confirm an HMR update was applied. Could expose a version counter or hash in the runtime that increments on HMR, queryable via CLI screenshot or CDP eval.

- [ ] **SKILL.md**
      Write a skill reference document for agents: all CLI commands, in-test APIs, debugging workflows, common failure modes and how to diagnose them.

- [ ] **Agent test suite (AGENT_TEST_SUITE.md)**
      Written but not validated — depends on fixing the runtime error first. Contains 8 phases covering boot, smoke test, screenshots, view tree, pause/resume, HMR, bug fix exercise, and full loop.

---

## Code quality

- [ ] **Default vitest config points to android**
      `vitest.config.ts` re-exports `vitest.config.android.ts`. Should either be platform-agnostic or auto-detect.

- [ ] **Test registry uses absolute paths**
      `test-registry.js` contains absolute paths like `/Users/kristen/...`. Works locally but not portable.
