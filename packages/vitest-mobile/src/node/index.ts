/**
 * vitest-mobile — Node-side entry point.
 *
 * Add the plugin to your vitest config:
 *   import { nativePlugin } from 'vitest-mobile'
 *   export default defineConfig({
 *     plugins: [nativePlugin({ platform: 'ios' })],
 *     test: { include: ['native-tests/**\/*.test.tsx'] },
 *   })
 */

import type { Plugin, UserConfig } from 'vite';
import { createNativePoolWorker } from './pool';
import type { NativePluginOptions, NativePoolOptions, PoolMode } from './types';

const DEFAULT_INCLUDE = ['**/native-tests/**/*.test.tsx', '**/native-tests/**/*.test.ts'];

/**
 * Key under which nativePlugin stashes the original user-supplied options on
 * the returned Plugin object. Not part of the public API — intended for the
 * vitest-mobile CLI to read back options (currently `nativeModules`) from a
 * statically-loaded vitest config.
 */
export const VITEST_MOBILE_PLUGIN_OPTIONS_KEY = '__vitestMobileOptions';

function detectMode(): PoolMode {
  if (process.env.CI) return 'run';
  if (process.argv.includes('run')) return 'run';
  return 'dev';
}

/** Vite plugin that wires up the native pool worker. */
export function nativePlugin(options: NativePluginOptions = {}): Plugin {
  const mode = detectMode();

  const poolOptions: Partial<NativePoolOptions> & { mode: PoolMode } = {
    port: options.port,
    metroPort: options.metroPort,
    platform: options.platform ?? 'android',
    appDir: process.cwd(),
    deviceId: options.device,
    skipIfUnavailable: options.skipIfUnavailable ?? false,
    headless: options.headless ?? mode === 'run',
    verbose: options.verbose ?? false,
    reactNativeVersion: options.reactNativeVersion,
    nativeModules: options.nativeModules,
    harnessApp: options.harnessApp,
    promptForNewDevice: options.promptForNewDevice ?? true,
    bundle: options.bundle,
    appConnectTimeout: options.appConnectTimeout,
    metro: options.metro,
    mode,
  };

  interface VitestInstance {
    rerunFiles?: (files: string[]) => void;
    scheduleRerun?: (files: string[]) => void;
    rerunTestSpecifications?: (files: string[]) => void;
  }

  let _singletonWorker: ReturnType<typeof createNativePoolWorker> | null = null;
  let _vitestInstance: VitestInstance | null = null;

  function bindRerunCallback() {
    if (_singletonWorker && _vitestInstance) {
      const vitest = _vitestInstance;
      const rerunFn = vitest.rerunFiles ?? vitest.scheduleRerun ?? vitest.rerunTestSpecifications;
      const rerun = typeof rerunFn === 'function' ? rerunFn.bind(vitest) : null;
      if (!rerun) return;
      _singletonWorker.setRerunCallback((files: string[], _pattern?: string) => {
        rerun(files);
      });
    }
  }

  const poolRunner = {
    name: 'native',
    createPoolWorker() {
      if (!_singletonWorker) {
        _singletonWorker = createNativePoolWorker(poolOptions as NativePoolOptions);
        bindRerunCallback();
      }
      return _singletonWorker;
    },
  };

  // Cast to any because configureVitest is a vitest-specific plugin hook
  // not present in Vite's Plugin type definition.
  const plugin: Plugin & Record<string, unknown> = {
    name: 'vitest-mobile',
    // Expose the original user-supplied options so the CLI can read them
    // back from a loaded vitest config (bootstrap/build/install/bundle use
    // this to default `nativeModules` without requiring users to repeat
    // themselves with --native-modules on the command line).
    [VITEST_MOBILE_PLUGIN_OPTIONS_KEY]: options,
    config(config: UserConfig) {
      const test = ((config as Record<string, unknown>).test as Record<string, unknown> | undefined) ?? {};
      (config as Record<string, unknown>).test = test;
      test.pool = poolRunner;
      test.maxWorkers = 1;
      test.minWorkers = 1;
      // isolate: false tells Vitest this worker can share runtime across files.
      // Combined with maxWorkers=1, it makes groupSpecs bundle all same-project/env
      // specs into a single task with context.files = [all], which collapses the
      // worker lifecycle (start → run → stop) to fire once per user-initiated run
      // rather than once per file. The RN harness shares one JS VM across files
      // anyway, so this matches reality.
      if (test.isolate === undefined) {
        test.isolate = false;
      }
      if (!test.include) {
        test.include = DEFAULT_INCLUDE;
      }
      poolOptions.testInclude = test.include as string[];

      // Disable Vitest's built-in file watcher for native test files.
      // Metro HMR is the sole rerun trigger — it knows about transitive
      // dependency changes (e.g. editing a component reruns its test),
      // while Vitest's watcher only sees the test file itself.
      // Without this, both fire and cause double-execution.
      if (mode === 'dev') {
        const forceExclude = test.include as string[];
        const existing = (test.watchExclude ?? []) as string[];
        test.watchExclude = [...existing, ...forceExclude];
      }

      return config;
    },
  };

  plugin.configureVitest = (ctx: { vitest?: VitestInstance } & VitestInstance) => {
    _vitestInstance = ctx.vitest ?? ctx;
    bindRerunCallback();
  };

  return plugin;
}

export type {
  NativePluginOptions,
  NativePoolOptions,
  Platform,
  MetroConfigContext,
  MetroConfigCustomizer,
} from './types';
