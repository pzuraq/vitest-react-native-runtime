/**
 * harness-builder — scaffolds, customizes, builds, and caches the native
 * harness binary that runs tests on device.
 *
 * The harness binary is a minimal React Native app with VitestMobileHarness baked in.
 * It loads JS from Metro at runtime — all test harness UI/logic comes from
 * the user's project via the Metro bundle.
 *
 * Build artifacts are cached in ~/.cache/vitest-mobile/builds/<hash>/ so
 * subsequent runs skip the build entirely.
 */

import { createHash } from 'node:crypto';
import { execSync, type ExecSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger';
import { getCacheDir } from './paths';
import type { Platform } from './types';

// ── Types ──────────────────────────────────────────────────────────

export interface HarnessBuildOptions {
  platform: Platform;
  /** React Native version (e.g. '0.81.5'). Auto-detected if not specified. */
  reactNativeVersion: string;
  /** Additional native modules to include (e.g. ['react-native-reanimated']). */
  nativeModules: string[];
  /** Path to vitest-mobile package root (for VitestMobileHarness pod). */
  packageRoot: string;
  /** User's project root (for reading node_modules). */
  projectRoot: string;
}

export interface HarnessBuildResult {
  /** Path to the built .app (iOS) or .apk (Android). */
  binaryPath: string;
  /** Bundle ID of the harness app. */
  bundleId: string;
  /** Whether this was a cache hit (no build needed). */
  cached: boolean;
  /** Deterministic cache key derived from platform, RN version, native modules, and harness version. */
  cacheKey: string;
  /**
   * Absolute path to the scaffolded harness project directory
   * (`<cache>/builds/<key>/project`). Used as the anchor for resolving
   * `@react-native/metro-config` (and other RN-template-provided packages)
   * when Metro boots.
   */
  projectDir: string;
}

const HARNESS_BUNDLE_ID = 'com.vitest.mobile.harness';
const HARNESS_APP_NAME = 'VitestMobileApp';
const DEFAULT_BUILD_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Bump when the build customization changes in a way that invalidates cached
// binaries (e.g. adding VitestMobileCacheKey to Info.plist / AndroidManifest).
// v3: platform-independent cache key — scaffold+customize is shared, build is per-platform.
// v4: merge scaffolded package.json (preserves RN template devDeps incl. @react-native/metro-config)
//     + preserve node_modules in trimBuildCache + exports "./package.json" for TurboModule
//     autolinking. Old binaries built pre-v4 are missing VitestMobileHarness registration.
const BUILD_FORMAT_VERSION = 4;

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
      customizeProject(projectDir, options, cacheKey);
      writeFileSync(resolve(projectDir, '.vitest-mobile-customized'), '');
    } else {
      log.info('Using cached project (scaffold + customization already done)');
    }

    log.info(`Building ${options.platform} binary (this may take a few minutes)...`);
    await buildProject(projectDir, options.platform);

    if (!existsSync(binaryPath)) {
      throw new Error(`Build completed but binary not found at: ${binaryPath}`);
    }

    const totalElapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
    log.info(`Harness binary built and cached successfully (${totalElapsed}s total).`);
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: false, cacheKey, projectDir };
  } finally {
    // Remove lock so other workers (or future runs) don't hang
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
 * Remove intermediate build artifacts from the cache, keeping only the final
 * binary (.app or .apk). This drastically reduces the cache size
 * (from ~1.2 GB to ~100 MB for iOS) so CI cache save/restore is fast.
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

  // Find all build hash directories
  const entries = readdirSync(buildsDir);
  for (const entry of entries) {
    const buildDir = resolve(buildsDir, entry);
    const binaryPath = getBinaryPath(buildDir, options.platform);
    if (!existsSync(binaryPath)) continue;

    const projectDir = resolve(buildDir, 'project');
    if (!existsSync(projectDir)) continue;

    // Note: we deliberately keep `project/node_modules` in the trim. Metro
    // boots against the harness project to resolve @react-native/metro-config
    // and the rest of the RN template's runtime dep closure; without those
    // packages present, `npx vitest run` would fail to start after a trim.
    //
    // This does make the cache larger (~1.2 GB vs ~100 MB per key). In CI
    // with content-addressed cache keys, that's fine: `actions/cache/save`
    // is a no-op on an existing key, so only the first save after a
    // cache-key-changing event pays the upload cost — which matches when
    // we'd have rebuilt from scratch anyway.

    if (options.platform === 'ios') {
      // Keep only: project/node_modules + project/ios/DerivedData/Build/Products/Debug-iphonesimulator/*.app
      const dirsToRemove = [
        resolve(projectDir, 'ios', 'Pods'),
        resolve(projectDir, 'ios', 'DerivedData', 'Build', 'Intermediates.noindex'),
        resolve(projectDir, 'ios', 'DerivedData', 'Logs'),
        resolve(projectDir, 'ios', 'DerivedData', 'ModuleCache.noindex'),
        resolve(projectDir, 'ios', 'DerivedData', 'info.plist'),
        resolve(projectDir, 'vendor'), // bundler gems
        resolve(projectDir, 'android'),
      ];
      for (const dir of dirsToRemove) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } else {
      // Android: keep node_modules + the .apk
      const dirsToRemove = [
        resolve(projectDir, 'android', '.gradle'),
        resolve(projectDir, 'android', 'app', 'build', 'intermediates'),
        resolve(projectDir, 'android', 'app', 'build', 'tmp'),
        resolve(projectDir, 'ios'),
        resolve(projectDir, 'vendor'),
      ];
      for (const dir of dirsToRemove) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }

  const after = getDirSizeSync(buildsDir);
  log.info(`Trimmed build cache: ${formatSize(before)} → ${formatSize(after)}`);
  return { before, after, trimmed: true };
}

function getDirSizeSync(dir: string): number {
  let size = 0;
  try {
    const output = execSync(`du -sk "${dir}" 2>/dev/null || echo "0"`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
    }).trim();
    size = parseInt(output.split('\t')[0] ?? '0', 10) * 1024;
  } catch {
    size = 0;
  }
  return size;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── Internals ──────────────────────────────────────────────────────

const BUILTIN_NATIVE_DEPS = ['react-native-safe-area-context'];

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

function getHarnessVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Check that the cached binary is complete (not a partial/failed build). */
function isBinaryValid(binaryPath: string, platform: Platform): boolean {
  if (platform === 'ios') {
    // A valid .app must have an Info.plist
    return existsSync(resolve(binaryPath, 'Info.plist'));
  }
  // APK is a single file — existence is sufficient
  return true;
}

function getBinaryPath(buildDir: string, platform: Platform): string {
  if (platform === 'ios') {
    return resolve(
      buildDir,
      'project',
      'ios',
      'DerivedData',
      'Build',
      'Products',
      'Debug-iphonesimulator',
      `${HARNESS_APP_NAME}.app`,
    );
  }
  return resolve(buildDir, 'build', `${HARNESS_APP_NAME}.apk`);
}

// ── Templates ──────────────────────────────────────────────────────

const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'templates');

/**
 * Copy the platform's template tree into the project directory, overwriting
 * any scaffolded files at the same paths. Template directory structure mirrors
 * the actual project layout (e.g. templates/android/app/src/main/res/...).
 */
function applyTemplates(platform: Platform, projectDir: string): void {
  const src = resolve(TEMPLATES_DIR, platform === 'ios' ? 'ios' : 'android');
  const dest = resolve(projectDir, platform === 'ios' ? 'ios' : 'android');
  cpSync(src, dest, { recursive: true });
}

/** Replace {{KEY}} placeholders in a file that was already copied by applyTemplates. */
function fillPlaceholders(filePath: string, replacements: Record<string, string>): void {
  let content = readFileSync(filePath, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  writeFileSync(filePath, content);
}

function run(cmd: string, opts: ExecSyncOptions = {}): string {
  log.verbose(`$ ${cmd}`);
  const start = Date.now();
  const result = (
    execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: DEFAULT_BUILD_TIMEOUT,
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      ...opts,
    }) as string
  ).trim();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log.verbose(`  ✓ ${elapsed}s`);
  return result;
}

/** Like run(), but streams output to the terminal so long commands show progress. */
function runLive(cmd: string, opts: ExecSyncOptions = {}): void {
  log.verbose(`$ ${cmd}`);
  execSync(cmd, {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: DEFAULT_BUILD_TIMEOUT,
    env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    ...opts,
  });
}

// ── Scaffold ───────────────────────────────────────────────────────

async function scaffoldProject(buildDir: string, options: HarnessBuildOptions): Promise<string> {
  const projectDir = resolve(buildDir, 'project');

  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }

  log.info('Scaffolding React Native project...');

  // Use @react-native-community/cli to init a project matching the user's RN version.
  // This ensures the Xcode project template matches the RN version exactly.
  run(
    `npx @react-native-community/cli init ${HARNESS_APP_NAME} --version ${options.reactNativeVersion} --skip-install --skip-git-init`,
    { cwd: buildDir },
  );

  // The CLI creates a directory named after the app
  const scaffoldDir = resolve(buildDir, HARNESS_APP_NAME);

  // Move it to our standard location
  if (existsSync(scaffoldDir) && scaffoldDir !== projectDir) {
    cpSync(scaffoldDir, projectDir, { recursive: true });
    rmSync(scaffoldDir, { recursive: true, force: true });
  }

  return projectDir;
}

// ── Customize ──────────────────────────────────────────────────────

function customizeProject(projectDir: string, options: HarnessBuildOptions, cacheKey: string): void {
  log.info('Customizing harness project...');

  customizeIOS(projectDir, cacheKey);
  customizeAndroid(projectDir, cacheKey);

  // 2. Merge our additions into the scaffolded package.json.
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
  pkg.dependencies = dependencies;

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // 3. Install dependencies
  log.info('Installing dependencies... (this may take a minute)');
  const depsStart = Date.now();
  runLive('npm install', { cwd: projectDir });
  log.info(`  Dependencies installed (${((Date.now() - depsStart) / 1000).toFixed(1)}s)`);
}

function customizeIOS(projectDir: string, cacheKey: string): void {
  const iosDir = resolve(projectDir, 'ios');

  // Extract Xcode-version-specific attributes from the scaffolded storyboard
  // before overwriting it with our template.
  const storyboardPath = resolve(iosDir, HARNESS_APP_NAME, 'LaunchScreen.storyboard');
  const storyboardReplacements = extractStoryboardReplacements(storyboardPath);

  applyTemplates('ios', projectDir);

  if (storyboardReplacements) {
    fillPlaceholders(storyboardPath, storyboardReplacements);
  }

  const podfilePath = resolve(iosDir, 'Podfile');
  if (existsSync(podfilePath)) {
    let podfile = readFileSync(podfilePath, 'utf8');
    podfile = podfile.replace(/platform\s+:ios,\s*.+/, "platform :ios, '16.0'");
    writeFileSync(podfilePath, podfile);
  }

  updateIOSBundleId(projectDir);

  // PlistBuddy is macOS-only; skip on Linux (Android-only CI runners still
  // customize both platforms for the shared project, but only build one).
  if (process.platform === 'darwin') {
    const infoPlistPath = resolve(iosDir, HARNESS_APP_NAME, 'Info.plist');
    if (existsSync(infoPlistPath)) {
      const pb = '/usr/libexec/PlistBuddy';
      run(`${pb} -c 'Set :CFBundleDisplayName Vitest' "${infoPlistPath}"`);
      run(`${pb} -c 'Add :VitestMobileCacheKey string ${cacheKey}' "${infoPlistPath}"`);
    }
  }
}

function customizeAndroid(projectDir: string, cacheKey: string): void {
  const androidDir = resolve(projectDir, 'android');

  applyTemplates('android', projectDir);

  fillPlaceholders(resolve(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml'), {
    CACHE_KEY: cacheKey,
  });

  const appBuildGradle = resolve(androidDir, 'app', 'build.gradle');
  if (existsSync(appBuildGradle)) {
    let content = readFileSync(appBuildGradle, 'utf8');
    content = content.replace(/applicationId\s+"[^"]+"/, `applicationId "${HARNESS_BUNDLE_ID}"`);
    content = content.replace(/minSdk\s*=\s*\d+/, 'minSdk = 24');
    content = content.replace(
      /(defaultConfig\s*\{[^}]*versionName\s+"[^"]*")/,
      '$1\n        resValue "integer", "react_native_dev_server_port", "18081"',
    );
    writeFileSync(appBuildGradle, content);
  }
}

/**
 * Extract the <document> tag and view controller ID from the scaffolded storyboard.
 * These carry Xcode-version-specific attributes we need to preserve.
 */
function extractStoryboardReplacements(storyboardPath: string): Record<string, string> | null {
  if (!existsSync(storyboardPath)) {
    log.verbose('LaunchScreen.storyboard not found, skipping splash modification');
    return null;
  }
  const existing = readFileSync(storyboardPath, 'utf8');
  const docMatch = existing.match(/<document[^>]+>/);
  if (!docMatch) {
    log.verbose('Could not parse LaunchScreen.storyboard, skipping splash modification');
    return null;
  }
  const docTag = docMatch[0];
  const vcId = docTag.match(/initialViewController="([^"]+)"/)?.[1] ?? '01J-lp-oVM';
  return { DOCUMENT_TAG: docTag, VC_ID: vcId };
}

function updateIOSBundleId(projectDir: string): void {
  // Update the bundle ID in the pbxproj
  const pbxprojPath = resolve(projectDir, 'ios', `${HARNESS_APP_NAME}.xcodeproj`, 'project.pbxproj');
  if (existsSync(pbxprojPath)) {
    let content = readFileSync(pbxprojPath, 'utf8');
    // Replace the default bundle ID with ours
    content = content.replace(
      /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"[^"]+"/g,
      `PRODUCT_BUNDLE_IDENTIFIER = "${HARNESS_BUNDLE_ID}"`,
    );
    writeFileSync(pbxprojPath, content);
  }
}

// ── Build ──────────────────────────────────────────────────────────

async function buildProject(projectDir: string, platform: Platform): Promise<void> {
  if (platform === 'ios') {
    await buildIOS(projectDir);
  } else {
    await buildAndroid(projectDir);
  }
}

async function buildIOS(projectDir: string): Promise<void> {
  const iosDir = resolve(projectDir, 'ios');

  // Install gems + pods (bundle exec ensures compatible CocoaPods version)
  log.info('Installing Ruby gems...');
  let stepStart = Date.now();
  runLive('bundle install', { cwd: projectDir });
  log.info(`  Gems installed (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);

  log.info('Running pod install... (this may take a minute)');
  stepStart = Date.now();
  runLive('bundle exec pod install', { cwd: iosDir });
  log.info(`  Pods installed (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);

  log.info('Building for iOS simulator (this may take a few minutes)...');
  stepStart = Date.now();

  const buildCmd = [
    'xcodebuild build',
    `-workspace ${HARNESS_APP_NAME}.xcworkspace`,
    `-scheme ${HARNESS_APP_NAME}`,
    '-sdk iphonesimulator',
    '-configuration Debug',
    `-derivedDataPath "${resolve(iosDir, 'DerivedData')}"`,
  ].join(' ');

  runLive(buildCmd, { cwd: iosDir });
  log.info(`  Xcode build complete (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);

  // Verify the .app exists (getBinaryPath points directly at DerivedData)
  const appPath = resolve(
    iosDir,
    'DerivedData',
    'Build',
    'Products',
    'Debug-iphonesimulator',
    `${HARNESS_APP_NAME}.app`,
  );
  if (!existsSync(appPath)) {
    throw new Error(`Build succeeded but .app not found at: ${appPath}`);
  }
  log.info(`Binary built: ${appPath}`);
}

async function buildAndroid(projectDir: string): Promise<void> {
  const androidDir = resolve(projectDir, 'android');

  log.info('Building Android debug APK (this may take a few minutes)...');
  const gradleStart = Date.now();

  // Use the gradle wrapper from the scaffolded project
  const gradlew = resolve(androidDir, 'gradlew');
  if (!existsSync(gradlew)) {
    throw new Error('gradlew not found in Android project');
  }

  run(`chmod +x "${gradlew}"`, { cwd: androidDir });
  run(`"${gradlew}" assembleDebug -x lint --no-daemon`, {
    cwd: androidDir,
  });
  log.info(`  Gradle build complete (${((Date.now() - gradleStart) / 1000).toFixed(1)}s)`);

  // Find the APK
  const apkPath = resolve(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!existsSync(apkPath)) {
    throw new Error(`Build succeeded but APK not found at: ${apkPath}`);
  }

  // Copy to our expected location
  const targetPath = getBinaryPath(resolve(projectDir, '..'), 'android');
  mkdirSync(resolve(targetPath, '..'), { recursive: true });
  cpSync(apkPath, targetPath);
  log.info(`APK built: ${targetPath}`);
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Walk up from startDir looking for node_modules/<modulePath>. */
function resolveNodeModule(startDir: string, modulePath: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = resolve(dir, 'node_modules', modulePath);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPeerVersion(projectRoot: string, pkg: string): string | null {
  const pkgPath = resolveNodeModule(projectRoot, `${pkg}/package.json`);
  if (!pkgPath) return null;
  try {
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkgJson.version;
  } catch {
    return null;
  }
}

function readInstalledVersion(projectRoot: string, pkg: string): string | null {
  return readPeerVersion(projectRoot, pkg);
}
