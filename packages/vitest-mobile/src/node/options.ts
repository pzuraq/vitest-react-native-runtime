/**
 * Single source of truth for pool option defaults.
 *
 * `withDefaults` takes the raw user-facing plugin options (all optional) plus
 * the plugin-computed bucket ({@link InternalPoolOptions}) and returns the
 * three atomic objects the pool consumes:
 *
 * - `options` — defaults applied, every field concrete (or `T | undefined`
 *   where genuinely optional).
 * - `internal` — pass-through; already concrete by construction.
 * - `runtime` — seeded with `bundleId` + `appDir`, everything else null/undefined
 *   until `doStart` resolves it.
 *
 * Adding a new option only requires: (1) declaring it on
 * {@link NativePluginOptions} + {@link ResolvedNativePluginOptions} in
 * types.ts, and (2) wiring its default here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  NativePluginOptions,
  InternalPoolOptions,
  Platform,
  ResolvedNativePluginOptions,
  ResolvedHarnessOptions,
  ResolvedDeviceOptions,
  ResolvedMetroOptions,
  RuntimeState,
} from './types';

export const DEFAULT_BUNDLE_ID = 'com.vitest.mobile.harness';

/** Read the harness bundle ID from app.json (Expo or RN flavors). */
export function detectBundleId(appDir: string, platform: Platform, override: string | undefined): string {
  if (override) return override;
  try {
    const appJsonPath = resolve(appDir, 'app.json');
    if (existsSync(appJsonPath)) {
      const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
      const expo = appJson.expo ?? appJson;
      if (platform === 'ios' && expo.ios?.bundleIdentifier) return expo.ios.bundleIdentifier;
      if (platform === 'android' && expo.android?.package) return expo.android.package;
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_BUNDLE_ID;
}

export function withDefaults(
  options: NativePluginOptions = {},
  internal: InternalPoolOptions,
): { options: ResolvedNativePluginOptions; internal: InternalPoolOptions; runtime: RuntimeState } {
  const platform = options.platform ?? 'android';
  const mode = internal.mode;

  const harness = options.harness ?? {};
  const device = options.device ?? {};
  const metro = options.metro ?? {};

  const resolvedHarness: ResolvedHarnessOptions = {
    reactNativeVersion: harness.reactNativeVersion,
    nativeModules: harness.nativeModules ?? [],
    app: harness.app,
    bundleIdOverride: harness.bundleIdOverride,
  };
  const resolvedDevice: ResolvedDeviceOptions = {
    preferredDeviceId: device.preferredDeviceId,
    headless: device.headless ?? mode === 'run',
    apiLevel: device.apiLevel,
  };
  const resolvedMetro: ResolvedMetroOptions = {
    bundle: metro.bundle,
    customize: metro.customize,
    babelPlugins: metro.babelPlugins ?? [],
  };

  const resolvedOptions: ResolvedNativePluginOptions = {
    platform,
    verbose: options.verbose ?? false,
    appConnectTimeout: options.appConnectTimeout ?? 180_000,
    port: options.port,
    metroPort: options.metroPort,
    harness: resolvedHarness,
    device: resolvedDevice,
    metro: resolvedMetro,
  };

  const runtime: RuntimeState = {
    appDir: internal.appDir,
    instanceId: null,
    port: undefined,
    metroPort: undefined,
    instanceDir: null,
    deviceId: undefined,
    bundleId: detectBundleId(internal.appDir, platform, harness.bundleIdOverride),
    harnessProjectDir: undefined,
  };

  return { options: resolvedOptions, internal, runtime };
}
