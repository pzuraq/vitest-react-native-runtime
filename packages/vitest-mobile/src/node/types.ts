/**
 * Shared types for vitest-mobile node-side modules.
 */

export type Platform = 'android' | 'ios';

export type PoolMode = 'dev' | 'run';

export interface NativePoolOptions {
  port?: number;
  metroPort?: number;
  platform: Platform;
  bundleId: string;
  appDir: string;
  deviceId?: string;
  skipIfUnavailable: boolean;
  headless: boolean;
  shutdownEmulator: boolean;
  verbose: boolean;
  mode: PoolMode;
  testInclude: string[];
  /** Additional native modules to include in the harness binary. */
  nativeModules?: string[];
  /** Path to a pre-built .app/.apk to use instead of auto-building. */
  harnessApp?: string;
  /** Prompt before creating persistent device definitions when needed. */
  promptForNewDevice?: boolean;
  /** Use a pre-built JS bundle instead of Metro. Pass true for default path, or a path to the bundle directory. */
  bundle?: boolean | string;
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
  /** @deprecated Use `device` instead. */
  deviceId?: string;
  /** Run simulator/emulator in headless mode. Defaults to true in CI. */
  headless?: boolean;
  /** Shut down emulator after tests complete. */
  shutdownEmulator?: boolean;
  /** Skip native tests if environment is not available. */
  skipIfUnavailable?: boolean;
  /** Enable verbose logging. */
  verbose?: boolean;
  /** @deprecated Use auto-build instead. */
  bundleId?: string;
  /** @deprecated Use auto-build instead. */
  appDir?: string;
  /** WebSocket port for pool-app communication. */
  port?: number;
  /** Metro dev server port. */
  metroPort?: number;
  /** Prompt before creating persistent simulator/emulator definitions when needed. */
  promptForNewDevice?: boolean;
  /** Use a pre-built JS bundle instead of Metro. Pass true for default path, or a path to the bundle directory. */
  bundle?: boolean | string;
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
