/**
 * harness-builder — scaffolds, customizes, builds, and caches the native
 * harness binary that runs tests on device.
 *
 * The harness binary is a minimal React Native app with VitestMobileHarness baked in.
 * It loads JS from Metro at runtime — all test harness UI/logic comes from
 * the user's project via the Metro bundle.
 *
 * Build artifacts are cached in `~/.cache/vitest-mobile/builds/<hash>/` so
 * subsequent runs skip the build entirely.
 *
 * Layout:
 *   - `_shared.ts` — constants, types, command runners, fs helpers
 *   - `ios.ts`     — customizeIOS, buildIOS, getIOSBinaryPath, etc.
 *   - `android.ts` — customizeAndroid, buildAndroid, getAndroidBinaryPath, etc.
 *   - `index.ts`   — public API + orchestration (this file)
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from '../logger';
import { getCacheDir } from '../paths';
import type { InternalPoolOptions, Platform, ResolvedNativePluginOptions } from '../types';
import {
  HARNESS_APP_NAME,
  HARNESS_BUNDLE_ID,
  formatSize,
  getDirSizeSync,
  readInstalledVersion,
  resolveNodeModule,
  runLive,
  type HarnessBuildOptions,
  type HarnessBuildResult,
} from './_shared';
import { buildIOS, customizeIOS, getIOSBinaryPath, isIOSBinaryValid, trimIOSBuildArtifacts } from './ios';
import {
  buildAndroid,
  customizeAndroid,
  getAndroidBinaryPath,
  isAndroidBinaryValid,
  trimAndroidBuildArtifacts,
} from './android';

export type { HarnessBuildOptions, HarnessBuildResult };

// Bump when the build customization changes in a way that invalidates cached
// binaries (e.g. adding VitestMobileCacheKey to Info.plist / AndroidManifest).
// v3: platform-independent cache key — scaffold+customize is shared, build is per-platform.
// v4: merge scaffolded package.json (preserves RN template devDeps incl. @react-native/metro-config)
//     + preserve node_modules in trimBuildCache + exports "./package.json" for TurboModule
//     autolinking. Old binaries built pre-v4 are missing VitestMobileHarness registration.
// v6: auto-wire Expo modules via `install-expo-modules` whenever any user-supplied
//     nativeModule matches the Expo naming convention (`expo`, `expo-*`, `@expo/*`).
//     Old v5 binaries built with Expo modules listed as deps lacked the autolinking
//     pipeline, so component renders that touched Expo modules' native side crashed.
const BUILD_FORMAT_VERSION = 6;

const BUILTIN_NATIVE_DEPS = ['react-native-safe-area-context'];

// ── Public API ─────────────────────────────────────────────────────

/**
 * Look up a cached harness binary for the given configuration.
 * Returns the result if found, or null if the binary hasn't been built yet.
 * Does NOT build — callers should direct users to run `npx vitest-mobile bootstrap`.
 */
export function findHarnessBinary(
  options: Pick<HarnessBuildOptions, 'platform' | 'reactNativeVersion' | 'nativeModules' | 'packageRoot'>,
): HarnessBuildResult | null {
  const cacheDir = getCacheDir();
  const cacheKey = computeCacheKey(options);
  const buildDir = resolve(cacheDir, 'builds', cacheKey);
  const binaryPath = getBinaryPath(buildDir, options.platform);
  const projectDir = resolve(buildDir, 'project');
  if (existsSync(binaryPath) && isBinaryValid(binaryPath, options.platform)) {
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: true, cacheKey, projectDir };
  }
  return null;
}

export interface ResolvedHarness {
  binaryPath: string;
  /** Null when the caller supplied `harnessApp`; otherwise the hash of the build inputs. */
  cacheKey: string | null;
  /** Bundle ID from the harness result, or undefined when a pre-built app was passed. */
  bundleId: string | undefined;
  /** Scaffolded harness project directory, or undefined for pre-built apps. */
  projectDir: string | undefined;
}

/**
 * Resolve which harness binary to use for this run. Prefers an explicit
 * `harnessApp` path; otherwise looks up the cached binary matching the
 * current platform + RN version + native modules. Throws with an actionable
 * message if neither is available.
 *
 * `packageRoot` is the absolute path to the installed `vitest-mobile` package
 * — it's needed when the harness builder has to scaffold a new project. The
 * pool supplies it explicitly rather than deriving it here so this module
 * doesn't depend on `__dirname`/ESM URL resolution.
 */
export function resolveHarness(
  options: Pick<ResolvedNativePluginOptions, 'platform' | 'harness'>,
  internal: Pick<InternalPoolOptions, 'appDir'>,
  packageRoot: string,
): ResolvedHarness {
  const { harness } = options;
  if (harness.app) {
    log.info(`Using pre-built harness: ${harness.app}`);
    const binaryPath = resolve(harness.app);
    if (!existsSync(binaryPath)) {
      throw new Error(`Harness binary not found: ${binaryPath}`);
    }
    return { binaryPath, cacheKey: null, bundleId: undefined, projectDir: undefined };
  }

  const rnVersion = harness.reactNativeVersion ?? detectReactNativeVersion(internal.appDir);
  if (!rnVersion) {
    throw new Error(
      'Could not auto-detect React Native version (react-native not found in node_modules).\n' +
        'Either install react-native or set reactNativeVersion explicitly in your Vitest config:\n\n' +
        "  nativePlugin({ harness: { reactNativeVersion: '0.81.5' } })",
    );
  }
  log.info(`React Native version: ${rnVersion}`);

  const result = findHarnessBinary({
    platform: options.platform,
    reactNativeVersion: rnVersion,
    nativeModules: harness.nativeModules,
    packageRoot,
  });
  if (!result) {
    throw new Error(
      `No harness binary found for ${options.platform}. Build it first:\n\n` +
        `  npx vitest-mobile bootstrap ${options.platform}\n`,
    );
  }

  log.info(`Using cached harness binary: ${result.binaryPath.split('/').pop()?.slice(0, 12)}...`);
  return {
    binaryPath: result.binaryPath,
    cacheKey: result.cacheKey,
    bundleId: result.bundleId,
    projectDir: result.projectDir,
  };
}

/**
 * Ensure a harness binary exists for the given configuration.
 * Returns the path to the .app/.apk, building if necessary.
 * Uses a file-based lock to prevent parallel builds from concurrent pool workers.
 */
export async function ensureHarnessBinary(options: HarnessBuildOptions): Promise<HarnessBuildResult> {
  const cacheDir = getCacheDir();
  const cacheKey = computeCacheKey(options);
  const buildDir = resolve(cacheDir, 'builds', cacheKey);
  mkdirSync(buildDir, { recursive: true });

  // Check cache — validate the binary is complete, not just the directory
  const binaryPath = getBinaryPath(buildDir, options.platform);
  const projectDir = resolve(buildDir, 'project');
  if (existsSync(binaryPath) && isBinaryValid(binaryPath, options.platform)) {
    log.info(`Using cached harness binary: ${cacheKey.slice(0, 12)}...`);
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: true, cacheKey, projectDir };
  }

  // File-based lock to prevent concurrent builds from parallel pool workers.
  // First worker creates the lock, others poll until the binary appears.
  const lockPath = resolve(buildDir, '.build-lock');
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // fails if exists
  } catch {
    // Another worker is building — wait for it
    log.info('Another worker is building the harness binary, waiting...');
    for (let i = 0; i < 600; i++) {
      // up to 10 minutes
      await new Promise<void>(r => setTimeout(r, 1000));
      if (existsSync(binaryPath)) {
        log.info('Harness binary ready (built by another worker).');
        return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: true, cacheKey, projectDir };
      }
      if (!existsSync(lockPath)) break; // lock removed = build failed
    }
    throw new Error('Timed out waiting for harness binary build');
  }

  try {
    const buildStart = Date.now();
    const isProjectReady = existsSync(resolve(projectDir, '.vitest-mobile-customized'));

    if (!isProjectReady) {
      log.info('');
      log.info('Scaffolding and customizing the test harness app.');
      log.info('This is a one-time setup shared by both iOS and Android.');
      log.info(`  React Native ${options.reactNativeVersion}`);
      if (options.nativeModules.length > 0) {
        log.info(`  Native modules: ${options.nativeModules.join(', ')}`);
      }
      log.info('');

      await scaffoldProject(buildDir, options);
      await customizeProject(projectDir, options, cacheKey);
      writeFileSync(resolve(projectDir, '.vitest-mobile-customized'), '');
    } else {
      log.info('Using cached project (scaffold + customization already done)');
    }

    log.info(`Building ${options.platform} binary (this may take a few minutes)...`);
    if (options.platform === 'ios') {
      await buildIOS(projectDir);
    } else {
      await buildAndroid(projectDir, buildDir);
    }

    if (!existsSync(binaryPath)) {
      throw new Error(`Build completed but binary not found at: ${binaryPath}`);
    }

    const totalElapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
    log.info(`Harness binary built and cached successfully (${totalElapsed}s total).`);
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: false, cacheKey, projectDir };
  } finally {
    try {
      rmSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Auto-detect the React Native version from the user's node_modules.
 * Walks up from projectRoot to handle monorepo hoisting.
 * Returns null if react-native is not installed.
 */
export function detectReactNativeVersion(projectRoot: string): string | null {
  const pkgPath = resolveNodeModule(projectRoot, 'react-native/package.json');
  if (!pkgPath) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

/**
 * True if any cached binary exists for the given platform under the shared
 * builds/ dir. Used by `vitest-mobile install` to infer `--platform` when
 * omitted — if only one platform has been built, that's almost certainly
 * what the user wants to install.
 */
export function hasAnyCachedBinary(platform: Platform): boolean {
  const buildsDir = resolve(getCacheDir(), 'builds');
  if (!existsSync(buildsDir)) return false;
  for (const entry of readdirSync(buildsDir)) {
    const binaryPath = getBinaryPath(resolve(buildsDir, entry), platform);
    if (existsSync(binaryPath) && isBinaryValid(binaryPath, platform)) return true;
  }
  return false;
}

/**
 * Remove intermediate build artifacts from the cache, keeping only the final
 * binary (.app or .apk). This drastically reduces the cache size
 * (from ~1.2 GB to ~100 MB for iOS) so CI cache save/restore is fast.
 *
 * Note: we deliberately keep `project/node_modules` in the trim. Metro boots
 * against the harness project to resolve @react-native/metro-config and the
 * rest of the RN template's runtime dep closure; without those packages
 * present, `npx vitest run` would fail to start after a trim. This makes
 * the cache larger (~1.2 GB vs ~100 MB per key); in CI with content-addressed
 * keys, that's fine because `actions/cache/save` is a no-op on an existing
 * key — only the first save after a cache-key-changing event pays the upload.
 */
export function trimBuildCache(options: { platform: Platform }): {
  before: number;
  after: number;
  trimmed: boolean;
} {
  const cacheDir = getCacheDir();
  const buildsDir = resolve(cacheDir, 'builds');
  if (!existsSync(buildsDir)) return { before: 0, after: 0, trimmed: false };

  const before = getDirSizeSync(buildsDir);

  for (const entry of readdirSync(buildsDir)) {
    const buildDir = resolve(buildsDir, entry);
    const binaryPath = getBinaryPath(buildDir, options.platform);
    if (!existsSync(binaryPath)) continue;

    const projectDir = resolve(buildDir, 'project');
    if (!existsSync(projectDir)) continue;

    if (options.platform === 'ios') trimIOSBuildArtifacts(projectDir);
    else trimAndroidBuildArtifacts(projectDir);
  }

  const after = getDirSizeSync(buildsDir);
  log.info(`Trimmed build cache: ${formatSize(before)} → ${formatSize(after)}`);
  return { before, after, trimmed: true };
}

/**
 * Compute the deterministic cache key for a harness build configuration.
 * Platform-independent — the same scaffolded project is shared between iOS
 * and Android, with only the native build step being platform-specific.
 */
export function computeCacheKey(
  options: Pick<HarnessBuildOptions, 'reactNativeVersion' | 'nativeModules' | 'packageRoot'>,
): string {
  const parts = [
    `fmt${BUILD_FORMAT_VERSION}`,
    options.reactNativeVersion,
    ...BUILTIN_NATIVE_DEPS,
    ...options.nativeModules.sort(),
    getHarnessVersion(options.packageRoot),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

// ── Internals ──────────────────────────────────────────────────────

function getHarnessVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getBinaryPath(buildDir: string, platform: Platform): string {
  return platform === 'ios' ? getIOSBinaryPath(buildDir) : getAndroidBinaryPath(buildDir);
}

function isBinaryValid(binaryPath: string, platform: Platform): boolean {
  return platform === 'ios' ? isIOSBinaryValid(binaryPath) : isAndroidBinaryValid();
}

async function scaffoldProject(buildDir: string, options: HarnessBuildOptions): Promise<string> {
  const projectDir = resolve(buildDir, 'project');

  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }

  log.info('Scaffolding React Native project...');

  // Use @react-native-community/cli to init a project matching the user's RN version.
  // This ensures the Xcode project template matches the RN version exactly.
  // runLive (async when a log sink is active) keeps the spinner animating
  // during this ~30s operation; run() would block the event loop sync.
  await runLive(
    `npx @react-native-community/cli init ${HARNESS_APP_NAME} --version ${options.reactNativeVersion} --skip-install --skip-git-init`,
    { cwd: buildDir },
  );

  const scaffoldDir = resolve(buildDir, HARNESS_APP_NAME);

  // Move it to our standard location
  if (existsSync(scaffoldDir) && scaffoldDir !== projectDir) {
    cpSync(scaffoldDir, projectDir, { recursive: true });
    rmSync(scaffoldDir, { recursive: true, force: true });
  }

  return projectDir;
}

async function customizeProject(projectDir: string, options: HarnessBuildOptions, cacheKey: string): Promise<void> {
  log.info('Customizing harness project...');

  customizeIOS(projectDir, cacheKey);
  customizeAndroid(projectDir, cacheKey);

  // Merge our additions into the scaffolded package.json.
  //
  // `@react-native-community/cli init --version <RN>` already produced a
  // package.json pinning react, react-native, and the full RN devDep set
  // (@react-native/metro-config, @react-native/babel-preset, etc.) at the
  // exact versions matching that RN release. Preserving those pins avoids
  // version-tracking drift on our side — in particular, it guarantees
  // @react-native/metro-config is present in the harness node_modules so
  // Metro can resolve it from a known, deterministic location without
  // depending on user-side hoisting.
  //
  // We only layer on the things the template can't know about:
  //  - vitest-mobile as a file: dep (for TurboModule autolinking via
  //    react-native.config.cjs)
  //  - react-native-safe-area-context (used by our harness UI)
  //  - any user-supplied native modules
  //  - `expo` (auto-added when any user-supplied module is an Expo module,
  //    so `expo-modules-autolinking` can pick the rest up)
  const pkgPath = resolve(projectDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name?: string;
    version?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
  };

  pkg.name = HARNESS_APP_NAME.toLowerCase();
  pkg.version = '0.0.0';
  pkg.private = true;

  const dependencies: Record<string, string> = { ...(pkg.dependencies ?? {}) };
  dependencies['react-native-safe-area-context'] =
    readInstalledVersion(options.projectRoot, 'react-native-safe-area-context') ?? '^5.0.0';
  dependencies['vitest-mobile'] = `file:${options.packageRoot}`;
  for (const mod of options.nativeModules) {
    dependencies[mod] = readInstalledVersion(options.projectRoot, mod) ?? '*';
  }

  const needsExpoIntegration = hasExpoModule(options.nativeModules);
  if (needsExpoIntegration && !dependencies['expo']) {
    // Expo's autolinking machinery lives in the `expo` package. Pin to whatever
    // the user has installed if available — otherwise let `install-expo-modules`
    // pick a default compatible with the harness's RN version.
    const userExpoVersion = readInstalledVersion(options.projectRoot, 'expo');
    if (userExpoVersion) dependencies['expo'] = userExpoVersion;
  }

  pkg.dependencies = dependencies;

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  injectBabelPluginsForNativeModules(projectDir, options.nativeModules);

  log.info('Installing dependencies... (this may take a minute)');
  const depsStart = Date.now();
  await runLive('npm install', { cwd: projectDir });
  log.info(`  Dependencies installed (${((Date.now() - depsStart) / 1000).toFixed(1)}s)`);

  if (needsExpoIntegration) {
    log.info('Wiring up Expo modules autolinking...');
    const expoStart = Date.now();
    // `install-expo-modules` patches the harness's Podfile, settings.gradle,
    // MainApplication, AppDelegate, etc. so that `expo-modules-autolinking`
    // picks up every `expo-*` package the user listed in `nativeModules`.
    // Without this, JS-side imports of e.g. `expo-blur` evaluate but the
    // native pod isn't installed, so component renders crash with
    // `Cannot read property 'BlurView' of undefined`.
    //
    // `--non-interactive` skips the AGP / iOS deployment-target / CLI
    // integration prompts (all default to "yes"). The CLI integration
    // (babel-preset-expo, expo/metro-config, .expo/.virtual-metro-entry
    // bundle URL, Xcode "Bundle React Native code and images" phase) is
    // mostly fine for the harness — vitest-mobile bundles tests through
    // its own Metro config that requires @react-native/metro-config
    // directly from the harness's node_modules, bypassing the harness's
    // own metro.config.js entirely. The one piece we have to undo is the
    // bundle-root rename (`index` → `.expo/.virtual-metro-entry`); vitest
    // -mobile rewrites `/index.bundle` requests onto its prebuilt bundle
    // path at the Metro server, but the `.expo/...` URL would slip past
    // that rewrite and hit a 404.
    await runLive('npx --yes install-expo-modules@latest --non-interactive', {
      cwd: projectDir,
    });
    patchAppDelegateForExpo(projectDir);
    log.info(`  Expo modules wired (${((Date.now() - expoStart) / 1000).toFixed(1)}s)`);
  }
}

/**
 * Patch the harness's AppDelegate.swift (iOS) and MainApplication.kt/.java
 * (Android) after `install-expo-modules` runs:
 *
 *  1. Undo the bundle-root rename — the CLI integration retargets bundle
 *     loading at `.expo/.virtual-metro-entry` so that Expo CLI's bundler
 *     resolves the user's actual entry, but vitest-mobile is already
 *     serving Metro itself and rewriting `/index.bundle` requests onto its
 *     own pre-built bundle, so we keep the bundle root as plain `index`.
 *
 *  2. Add the `bindReactNativeFactory(factory)` call that SDK 54+'s
 *     `ExpoAppDelegate.recreateRootView` requires. `install-expo-modules`
 *     swaps the superclass to `ExpoAppDelegate` and the factory class to
 *     `ExpoReactNativeFactory`, but doesn't insert `bindReactNativeFactory`
 *     — yet `ExpoAppDelegate` reads its own private `factory` property at
 *     `recreateRootView` time and `fatalError`s with
 *     `"recreateRootView: Missing factory in ExpoAppDelegate"` if it's
 *     unset. The from-scratch Expo bare template hard-codes this call;
 *     we re-add it after the install-expo-modules transform.
 *
 * Searches for AppDelegate / MainApplication files by name rather than
 * hard-coding the package path because the Android Java/Kotlin path follows
 * the (rewritten) bundle ID and the iOS file lives inside the
 * `HARNESS_APP_NAME` subdirectory.
 */
function patchAppDelegateForExpo(projectDir: string): void {
  const targetNames = new Set(['AppDelegate.swift', 'AppDelegate.mm', 'MainApplication.kt', 'MainApplication.java']);

  const searchDirs = [resolve(projectDir, 'ios'), resolve(projectDir, 'android')];
  for (const root of searchDirs) {
    if (!existsSync(root)) continue;
    walkAndPatch(root, targetNames);
  }
}

function walkAndPatch(dir: string, targetNames: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndPatch(full, targetNames);
      continue;
    }
    if (!targetNames.has(entry.name)) continue;
    const before = readFileSync(full, 'utf8');
    let after = before.replaceAll('.expo/.virtual-metro-entry', 'index');
    after = ensureBindReactNativeFactoryCall(after, entry.name);
    if (after !== before) writeFileSync(full, after);
  }
}

/**
 * Insert `bindReactNativeFactory(factory)` immediately after the
 * `reactNativeFactory = factory` assignment in `AppDelegate.swift` if the
 * call is missing. No-op for non-Swift files.
 */
function ensureBindReactNativeFactoryCall(contents: string, filename: string): string {
  if (filename !== 'AppDelegate.swift') return contents;
  if (contents.includes('bindReactNativeFactory(')) return contents;
  // Match the assignment line so we can preserve its leading indent.
  const m = contents.match(/^([ \t]*)reactNativeFactory\s*=\s*factory[ \t]*$/m);
  if (!m) return contents;
  const indent = m[1];
  return contents.replace(m[0], `${m[0]}\n${indent}bindReactNativeFactory(factory)`);
}

/**
 * Heuristic for "this nativeModule needs Expo's autolinking pipeline" —
 * matches `expo`, `expo-*` (e.g. `expo-blur`, `expo-haptics`), and `@expo/*`
 * (e.g. `@expo/vector-icons`). Modules outside this naming pattern go
 * through the React Native community CLI's autolinking, which the
 * scaffolded RN template already supports out of the box.
 */
function hasExpoModule(nativeModules: readonly string[]): boolean {
  return nativeModules.some(name => name === 'expo' || name.startsWith('expo-') || name.startsWith('@expo/'));
}

/**
 * Native modules that require a corresponding Babel plugin to be added to
 * the harness project's `babel.config.js`. Map from npm package name to the
 * Babel plugin specifier that should be added. If a user declares one of
 * these as a `nativeModule`, we automatically append the plugin so Metro's
 * live bundling (watch mode) produces correct output — without it, worklet
 * directives and similar compile-time transforms are silently skipped.
 */
const NATIVE_MODULE_BABEL_PLUGINS: Record<string, string> = {
  'react-native-reanimated': 'react-native-reanimated/plugin',
};

function injectBabelPluginsForNativeModules(projectDir: string, nativeModules: string[]): void {
  const pluginsToAdd = nativeModules
    .filter(mod => mod in NATIVE_MODULE_BABEL_PLUGINS)
    .map(mod => NATIVE_MODULE_BABEL_PLUGINS[mod]);

  if (pluginsToAdd.length === 0) return;

  const babelConfigPath = resolve(projectDir, 'babel.config.js');
  if (!existsSync(babelConfigPath)) return;

  let content = readFileSync(babelConfigPath, 'utf8');
  for (const plugin of pluginsToAdd) {
    if (content.includes(plugin)) continue;
    content = content.replace(/plugins:\s*\[/, `plugins: [\n    '${plugin}',`);
    if (!content.includes(plugin)) {
      content = content.replace(/presets:\s*\[([^\]]*)\]/, `presets: [$1],\n  plugins: ['${plugin}']`);
    }
  }
  writeFileSync(babelConfigPath, content);
}
