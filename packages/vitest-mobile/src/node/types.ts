/**
 * Shared types for vitest-mobile node-side modules.
 */

import type { ConfigT } from 'metro-config';

export type Platform = 'android' | 'ios';

export type PoolMode = 'dev' | 'run';

/**
 * Context passed to a {@link MetroConfigCustomizer}. Lets the customizer
 * anchor its own `require.resolve` calls into the harness tree (for pulling
 * RN-version-pinned modules) and vary behavior per-platform when needed.
 */
export interface MetroConfigContext {
  /**
   * Absolute path to the scaffolded harness project
   * (`<cache>/builds/<key>/project`). Same directory vitest-mobile uses as
   * the anchor for its harness-pinned resolver overrides.
   */
  harnessProjectDir: string;
  /** User's project root — the directory passed to `getDefaultConfig()`. */
  projectRoot: string;
  /** Platform this config is being prepared for. */
  platform: Platform;
}

/**
 * Transform the auto-generated, harness-anchored Metro config before
 * vitest-mobile applies its test-specific overrides (test-registry shim,
 * vitest shim, babel transformer wrapper, etc).
 *
 * Return the modified config. Mutating the incoming object and returning it
 * is fine — vitest-mobile treats the return value as authoritative.
 */
export type MetroConfigCustomizer = (config: ConfigT, context: MetroConfigContext) => ConfigT | Promise<ConfigT>;

export interface NativePoolOptions {
  port?: number;
  metroPort?: number;
  platform: Platform;
  bundleId: string;
  appDir: string;
  deviceId?: string;
  skipIfUnavailable: boolean;
  headless: boolean;
  verbose: boolean;
  mode: PoolMode;
  testInclude: string[];
  /** Override the React Native version (auto-detected from node_modules by default). */
  reactNativeVersion?: string;
  /** Additional native modules to include in the harness binary. */
  nativeModules?: string[];
  /** Path to a pre-built .app/.apk to use instead of auto-building. */
  harnessApp?: string;
  /** Prompt before creating persistent device definitions when needed. */
  promptForNewDevice?: boolean;
  /** Use a pre-built JS bundle instead of Metro. Pass true for default path, or a path to the bundle directory. */
  bundle?: boolean | string;
  /**
   * How long to wait (ms) for the harness app to connect back after it's
   * launched. Covers app process start, Metro's initial bundle compile,
   * Hermes parse, and JS init. Increase for cold Metro caches or large
   * monorepos. Default: 180000 (3 minutes).
   */
  appConnectTimeout?: number;
  /**
   * Customize the Metro config that vitest-mobile uses for bundling tests.
   * See {@link NativePluginOptions.metro} for details.
   */
  metro?: MetroConfigCustomizer;
}

export interface NativePluginOptions {
  platform?: Platform;
  /** Override the React Native version (auto-detected from node_modules by default). */
  reactNativeVersion?: string;
  /** Additional native modules to include in the harness binary. */
  nativeModules?: string[];
  /** Path to a pre-built .app/.apk to use instead of auto-building. */
  harnessApp?: string;
  /** Simulator/emulator device name or ID. */
  device?: string;
  /** Run simulator/emulator in headless mode. Defaults to true in CI. */
  headless?: boolean;
  /** Skip native tests if environment is not available. */
  skipIfUnavailable?: boolean;
  /** Enable verbose logging. */
  verbose?: boolean;
  /** WebSocket port for pool-app communication. */
  port?: number;
  /** Metro dev server port. */
  metroPort?: number;
  /** Prompt before creating persistent simulator/emulator definitions when needed. */
  promptForNewDevice?: boolean;
  /** Use a pre-built JS bundle instead of Metro. Pass true for default path, or a path to the bundle directory. */
  bundle?: boolean | string;
  /**
   * How long to wait (ms) for the harness app to connect back after it's
   * launched. Covers app process start, Metro's initial bundle compile,
   * Hermes parse, and JS init. Increase for cold Metro caches or large
   * monorepos. Default: 180000 (3 minutes).
   */
  appConnectTimeout?: number;
  /**
   * Customize the Metro config used to bundle tests. The callback receives
   * the auto-generated harness-anchored base config (with `react`,
   * `react-native`, `react-native-safe-area-context`, and `@react-native/*`
   * already pinned to the RN version the harness binary was built against)
   * and must return the final config vitest-mobile should use.
   *
   * Prefer this over a project-level `metro.config.js` — that file would
   * shadow the auto-generated config entirely, forcing you to re-implement
   * harness anchoring by hand. This callback layers on top of the generated
   * base so you only specify the deltas (extra `assetExts`, workspace
   * `resolveRequest` hooks, monorepo watch folders, etc.).
   */
  metro?: MetroConfigCustomizer;
}

export interface DeviceOptions {
  wsPort?: number;
  metroPort?: number;
  deviceId?: string;
  /** Bundle ID of the harness app — used to check if a device is already in use. */
  bundleId?: string;
  headless?: boolean;
  instanceId?: string;
  promptForNewDevice?: boolean;
  /** Android API level for auto-provisioning a system image + AVD (e.g. 35). */
  apiLevel?: number;
  /** Project root — used to derive a stable, project-scoped simulator identity so vitest-mobile owns its own simulator instead of reusing the user's. */
  appDir?: string;
}

export interface EnvironmentCheck {
  ok: boolean;
  message: string;
  fix?: string;
  detail?: string;
  autoFixable?: boolean;
}

export interface NamedCheck extends EnvironmentCheck {
  name: string;
}

export interface EnvironmentResult {
  ok: boolean;
  checks: NamedCheck[];
  issues: NamedCheck[];
}
