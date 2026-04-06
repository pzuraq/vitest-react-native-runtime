/**
 * vitest-react-native-runtime — Node-side entry point.
 *
 * Scaffold a test app:
 *   npx vitest-react-native-runtime init ./test-app
 *
 * Then add the plugin to your vitest config:
 *   import { nativePlugin } from 'vitest-react-native-runtime'
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

/** Vite plugin that wires up the native pool worker. */
export function nativePlugin(options: NativePluginOptions = {}): Plugin {
  const mode = detectMode();

  const poolOptions: Partial<NativePoolOptions> & { mode: PoolMode } = {
    port: options.port ?? 7878,
    metroPort: options.metroPort ?? 8081,
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
    mode,
  };

  let _singletonWorker: ReturnType<typeof createNativePoolWorker> | null = null;

  const poolRunner = {
    name: 'native',
    createPoolWorker() {
      if (!_singletonWorker) {
        _singletonWorker = createNativePoolWorker(poolOptions as NativePoolOptions);
      }
      return _singletonWorker;
    },
  };

  return {
    name: 'vitest-react-native-runtime',
    config(config: UserConfig) {
      const test = ((config as Record<string, unknown>).test as Record<string, unknown> | undefined) ?? {};
      (config as Record<string, unknown>).test = test;
      test.pool = poolRunner;
      // All test files share one device/Metro/WebSocket — must be serial
      test.maxWorkers = 1;
      test.minWorkers = 1;
      if (!test.include) {
        test.include = DEFAULT_INCLUDE;
      }
      poolOptions.testInclude = test.include as string[];
      return config;
    },
  };
}

export type { NativePluginOptions, NativePoolOptions, Platform } from './types';
