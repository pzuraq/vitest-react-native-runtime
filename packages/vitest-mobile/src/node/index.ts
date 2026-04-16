/**
 * vitest-mobile — Node-side entry point.
 *
 * Scaffold a test app:
 *   npx vitest-mobile init ./test-app
 *
 * Then add the plugin to your vitest config:
 *   import { nativePlugin } from 'vitest-mobile'
 *   export default defineConfig({
 *     plugins: [nativePlugin({ appDir: './test-app' })],
 *     test: { include: ['native-tests/**\/*.test.tsx'] },
 *   })
 */

import type { Plugin, UserConfig } from 'vite';
import { createNativePoolWorker } from './pool';
import { resolve } from 'node:path';
import type { NativePluginOptions, NativePoolOptions, PoolMode } from './types';

const DEFAULT_INCLUDE = ['**/native-tests/**/*.test.tsx', '**/native-tests/**/*.test.ts'];

function detectMode(): PoolMode {
  if (process.env.CI) return 'run';
  if (process.argv.includes('run')) return 'run';
  return 'dev';
}

function countTestsInSpecs(specsInput: unknown): number {
  const specs = Array.isArray(specsInput) ? specsInput : [];
  let count = 0;

  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;
    const record = spec as Record<string, unknown>;
    const testModule = record.testModule as
      | {
          children?: { allTests?: () => Iterable<unknown> };
        }
      | undefined;
    try {
      const children = testModule?.children;
      if (children && typeof children === 'object' && 'allTests' in children) {
        const allTestsFn = (children as { allTests?: () => unknown }).allTests;
        if (typeof allTestsFn === 'function') {
          const result = allTestsFn.call(children);
          if (result && typeof (result as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
            count += Array.from(result as Iterable<unknown>).length;
            continue;
          }
        }
      }
    } catch {
      // Ignore and fall back to testIds-based estimate below.
    }

    const testIds = record.testIds;
    if (Array.isArray(testIds)) {
      count += testIds.length;
    }
  }

  return count;
}

/** Vite plugin that wires up the native pool worker. */
export function nativePlugin(options: NativePluginOptions = {}): Plugin {
  const mode = detectMode();

  const poolOptions: Partial<NativePoolOptions> & { mode: PoolMode } = {
    port: options.port,
    metroPort: options.metroPort,
    platform: options.platform ?? 'android',
    bundleId: options.bundleId,
    appDir: options.appDir ? resolve(process.cwd(), options.appDir) : process.cwd(),
    deviceId: options.deviceId ?? options.device,
    skipIfUnavailable: options.skipIfUnavailable ?? false,
    headless: options.headless ?? mode === 'run',
    shutdownEmulator: options.shutdownEmulator ?? mode === 'run',
    verbose: options.verbose ?? false,
    nativeModules: options.nativeModules,
    harnessApp: options.harnessApp,
    promptForNewDevice: options.promptForNewDevice ?? true,
    bundle: options.bundle,
    mode,
  };

  interface VitestInstance {
    rerunFiles?: (files: string[]) => void;
    scheduleRerun?: (files: string[]) => void;
    rerunTestSpecifications?: (files: string[]) => void;
    config?: { reporters?: unknown[] };
  }

  let _singletonWorker: ReturnType<typeof createNativePoolWorker> | null = null;
  let _vitestInstance: VitestInstance | null = null;
  let _reporterRegistered = false;

  function bindRerunCallback() {
    if (_singletonWorker && _vitestInstance) {
      const vitest = _vitestInstance;
      const rerunFn = vitest.rerunFiles ?? vitest.scheduleRerun ?? vitest.rerunTestSpecifications;
      const rerun = typeof rerunFn === 'function' ? rerunFn.bind(vitest) : null;

      // Newer Vitest versions may not expose a direct rerun API here.
      // In that case, keep the callback unset so pool.ts can use its
      // built-in replay fallback when rerun is requested from the device.
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
    config(config: UserConfig) {
      const test = ((config as Record<string, unknown>).test as Record<string, unknown> | undefined) ?? {};
      (config as Record<string, unknown>).test = test;
      test.pool = poolRunner;
      test.maxWorkers = 1;
      test.minWorkers = 1;
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

    if (_reporterRegistered) return;
    const reporters = _vitestInstance?.config?.reporters;
    if (!Array.isArray(reporters)) return;

    reporters.push({
      onTestRunStart(specs: unknown[]) {
        const testCount = countTestsInSpecs(specs);
        _singletonWorker?.sendToDevice({
          __native_run_start: true,
          fileCount: specs.length,
          testCount,
        });
      },
      onTestRunEnd(_modules: unknown, _errors: unknown, reason: string) {
        _singletonWorker?.sendToDevice({
          __native_run_end: true,
          reason,
        });
        if (mode === 'run') {
          _singletonWorker?.teardown();
        }
      },
    });
    _reporterRegistered = true;
  };

  return plugin;
}

export type { NativePluginOptions, NativePoolOptions, Platform } from './types';
