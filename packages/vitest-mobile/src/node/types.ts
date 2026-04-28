/**
 * Shared types for vitest-mobile node-side modules.
 *
 * The pool worker reads from three atomic buckets:
 *
 * - `ResolvedNativePluginOptions`: user-configurable options (nested
 *   harness/device/metro groups). Frozen after `withDefaults`.
 * - `InternalPoolOptions`: plugin-computed values (appDir, mode,
 *   testPatterns, outputDir). Not user-facing. Frozen once the plugin
 *   finishes constructing the pool.
 * - `RuntimeState`: mutable runtime-resolved values (instanceId, port,
 *   metroPort, instanceDir, deviceId, bundleId, …). Populated by
 *   `doStart` and mutated in place.
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
 * vitest-mobile applies its test-specific overrides (test-context shim,
 * vitest shim, babel transformer wrapper, etc).
 *
 * Return the modified config. Mutating the incoming object and returning it
 * is fine — vitest-mobile treats the return value as authoritative.
 */
export type MetroConfigCustomizer = (config: ConfigT, context: MetroConfigContext) => ConfigT | Promise<ConfigT>;

// ── Public user-config groups ──────────────────────────────────────

/** Harness-related options — which binary to use and how it was built. */
export interface HarnessOptions {
  /** Override the React Native version (auto-detected from node_modules by default). */
  reactNativeVersion?: string;
  /** Additional native modules to include in the harness binary. */
  nativeModules?: string[];
  /** Path to a pre-built .app/.apk to use instead of auto-building. */
  app?: string;
  /**
   * Override the harness app's bundle ID. Normally detected from app.json
   * (Expo or RN flavors) and falling back to `com.vitest.mobile.harness`.
   */
  bundleIdOverride?: string;
}

/** Device-related options — which simulator/emulator to use and how to run it. */
export interface DeviceOptions {
  /** Preferred simulator/emulator ID. If unset, the pool picks one. */
  preferredDeviceId?: string;
  /** Run simulator/emulator in headless mode. Defaults to true in run mode. */
  headless?: boolean;
  /** Android API level for auto-provisioning a system image + AVD (e.g. 35). */
  apiLevel?: number;
}

/** Metro / bundling options. */
export interface MetroOptions {
  /**
   * Use a pre-built JS bundle instead of Metro. Pass `true` for the default
   * path (`<appDir>/.vitest-mobile/bundle`), or a directory path.
   */
  bundle?: boolean | string;
  /**
   * Customize the Metro config that vitest-mobile uses for bundling tests.
   * See {@link NativePluginOptions.metro} for details.
   */
  customize?: MetroConfigCustomizer;
  /**
   * Extra Babel plugins to inject into Metro's transform pipeline. These are
   * applied to every file Metro bundles, both in watch mode (live Metro) and
   * when building pre-built bundles.
   *
   * Use this for native modules that require a compile-time Babel transform,
   * such as `react-native-reanimated/plugin`. Plugins are resolved from the
   * harness project's `node_modules` (where your `harness.nativeModules`
   * are installed).
   *
   * @example
   * ```ts
   * nativePlugin({
   *   harness: { nativeModules: ['react-native-reanimated'] },
   *   metro: { babelPlugins: ['react-native-reanimated/plugin'] },
   * })
   * ```
   */
  babelPlugins?: string[];
}

// ── User-facing plugin options ─────────────────────────────────────

/**
 * Options accepted by `nativePlugin(...)` in the user's vitest config.
 * All fields optional; defaults are applied internally by `withDefaults`.
 */
export interface NativePluginOptions {
  platform?: Platform;
  port?: number;
  metroPort?: number;
  verbose?: boolean;
  /**
   * How long to wait (ms) for the harness app to connect back after it's
   * launched. Covers app process start, Metro's initial bundle compile,
   * Hermes parse, and JS init. Increase for cold Metro caches or large
   * monorepos. Default: 180000 (3 minutes).
   */
  appConnectTimeout?: number;
  harness?: HarnessOptions;
  device?: DeviceOptions;
  metro?: MetroOptions;
}

// ── Resolved (defaulted) variants ──────────────────────────────────

export interface ResolvedHarnessOptions {
  reactNativeVersion: string | undefined;
  nativeModules: string[];
  app: string | undefined;
  bundleIdOverride: string | undefined;
}

export interface ResolvedDeviceOptions {
  preferredDeviceId: string | undefined;
  headless: boolean;
  apiLevel: number | undefined;
}

export interface ResolvedMetroOptions {
  bundle: boolean | string | undefined;
  customize: MetroConfigCustomizer | undefined;
  babelPlugins: string[];
}

/** Pool options after `withDefaults` — frozen, every field concrete. */
export interface ResolvedNativePluginOptions {
  platform: Platform;
  verbose: boolean;
  appConnectTimeout: number;
  /** User preference for the WebSocket port; `undefined` means "auto-pick". */
  port: number | undefined;
  /** User preference for the Metro port; `undefined` means "auto-pick". */
  metroPort: number | undefined;
  harness: ResolvedHarnessOptions;
  device: ResolvedDeviceOptions;
  metro: ResolvedMetroOptions;
}

// ── Plugin-computed pool context ───────────────────────────────────

/**
 * Values the plugin derives from process state / Vitest config and threads
 * into the pool. Not user-facing — constructed by `nativePlugin` at config
 * time. Frozen once the pool is up.
 */
export interface InternalPoolOptions {
  /** Project root — `process.cwd()` at plugin-config time. */
  appDir: string;
  /** `'run'` when invoked as `vitest run` or in CI; `'dev'` for watch mode. */
  mode: PoolMode;
  /** Glob patterns mirroring Vitest's `test.include`. */
  testPatterns: string[];
  /** `<appDir>/.vitest-mobile` — stable base for pool artifacts. */
  outputDir: string;
}

// ── Runtime-resolved state (mutable during doStart) ────────────────

/**
 * Values resolved during `doStart` (ports picked, instance registered,
 * device claimed, harness binary identified). Mutated in place as startup
 * progresses. Drivers read from this single bucket instead of a dozen
 * plucked fields.
 *
 * `appDir` is the only always-required field — it's mirrored from
 * {@link InternalPoolOptions.appDir} when the pool constructs its
 * runtime and serves as a required argument when the CLI passes a
 * minimal runtime literal to drivers (`ensureDevice(platform, { appDir }, …)`).
 * Everything else is populated progressively and may be absent at the
 * time a driver is called from the CLI.
 */
export interface RuntimeState {
  /** Project root (mirrored from `InternalPoolOptions.appDir`; stable). */
  appDir: string;
  /** Populated by `resolveInstance`. */
  instanceId?: string | null;
  /** WebSocket port, populated by `resolveInstance`. */
  port?: number;
  /** Metro port, populated by `resolveInstance`. */
  metroPort?: number;
  /** `<outputDir>/instances/<instanceId>`, populated by `resolveInstance`. */
  instanceDir?: string | null;
  /** The device `ensureDevice` picked for this run. */
  deviceId?: string;
  /**
   * Harness app's bundle ID. Seeded by `detectBundleId` during
   * `withDefaults`; `resolveHarness` may override with the cached
   * harness's specific value. Always concrete when the pool is the caller;
   * the CLI may pass a minimal runtime that omits this for commands that
   * don't need it.
   */
  bundleId?: string;
  /**
   * Scaffolded harness project directory
   * (`<cache>/builds/<key>/project`). Populated by `resolveHarness`.
   */
  harnessProjectDir?: string;
}

// ── Environment check types ────────────────────────────────────────

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
