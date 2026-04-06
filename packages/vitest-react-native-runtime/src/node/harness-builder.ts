/**
 * harness-builder — scaffolds, customizes, builds, and caches the native
 * harness binary that runs tests on device.
 *
 * The harness binary is a minimal React Native app with NativeHarness baked in.
 * It loads JS from Metro at runtime — all test harness UI/logic comes from
 * the user's project via the Metro bundle.
 *
 * Build artifacts are cached in ~/.cache/vitest-native/builds/<hash>/ so
 * subsequent runs skip the build entirely.
 */

import { createHash } from 'node:crypto';
import { execSync, type ExecSyncOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger';
import type { Platform } from './types';

// ── Types ──────────────────────────────────────────────────────────

export interface HarnessBuildOptions {
  platform: Platform;
  /** React Native version (e.g. '0.81.5'). Auto-detected if not specified. */
  reactNativeVersion: string;
  /** Additional native modules to include (e.g. ['react-native-reanimated']). */
  nativeModules: string[];
  /** Path to vitest-react-native-runtime package root (for NativeHarness pod). */
  packageRoot: string;
  /** User's project root (for reading node_modules). */
  projectRoot: string;
  /** Override cache directory. */
  cacheDir?: string;
}

export interface HarnessBuildResult {
  /** Path to the built .app (iOS) or .apk (Android). */
  binaryPath: string;
  /** Bundle ID of the harness app. */
  bundleId: string;
  /** Whether this was a cache hit (no build needed). */
  cached: boolean;
}

const HARNESS_BUNDLE_ID = 'com.vitest.native.harness';
const HARNESS_APP_NAME = 'VitestNativeHarness';

// ── Public API ─────────────────────────────────────────────────────

/**
 * Ensure a harness binary exists for the given configuration.
 * Returns the path to the .app/.apk, building if necessary.
 * Uses a file-based lock to prevent parallel builds from concurrent pool workers.
 */
export async function ensureHarnessBinary(
  options: HarnessBuildOptions,
): Promise<HarnessBuildResult> {
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const cacheKey = computeCacheKey(options);
  const buildDir = resolve(cacheDir, 'builds', cacheKey);
  mkdirSync(buildDir, { recursive: true });

  // Check cache
  const binaryPath = getBinaryPath(buildDir, options.platform);
  if (existsSync(binaryPath)) {
    log.info(`Using cached harness binary: ${cacheKey.slice(0, 12)}...`);
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: true };
  }

  // File-based lock to prevent concurrent builds from parallel pool workers.
  // First worker creates the lock, others poll until the binary appears.
  const lockPath = resolve(buildDir, '.build-lock');
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // fails if exists
  } catch {
    // Another worker is building — wait for it
    log.info('Another worker is building the harness binary, waiting...');
    for (let i = 0; i < 600; i++) { // up to 10 minutes
      await new Promise<void>(r => setTimeout(r, 1000));
      if (existsSync(binaryPath)) {
        log.info('Harness binary ready (built by another worker).');
        return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: true };
      }
      if (!existsSync(lockPath)) break; // lock removed = build failed
    }
    throw new Error('Timed out waiting for harness binary build');
  }

  try {
    // Build
    log.info('Building harness binary (first run, will be cached)...');
    log.info(`  RN version: ${options.reactNativeVersion}`);
    if (options.nativeModules.length > 0) {
      log.info(`  Native modules: ${options.nativeModules.join(', ')}`);
    }

    const projectDir = await scaffoldProject(buildDir, options);
    customizeProject(projectDir, options);
    await buildProject(projectDir, options.platform);

    if (!existsSync(binaryPath)) {
      throw new Error(`Build completed but binary not found at: ${binaryPath}`);
    }

    log.info('Harness binary built and cached successfully.');
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: false };
  } finally {
    // Remove lock so other workers (or future runs) don't hang
    try { rmSync(lockPath); } catch {}
  }
}

/**
 * Auto-detect the React Native version from the user's node_modules.
 * Walks up from projectRoot to handle monorepo hoisting.
 */
export function detectReactNativeVersion(projectRoot: string): string {
  const pkgPath = resolveNodeModule(projectRoot, 'react-native/package.json');
  if (!pkgPath) {
    throw new Error(
      'react-native not found in node_modules. Install it first:\n  npm install react-native',
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

/**
 * Get the default cache directory.
 */
export function getDefaultCacheDir(): string {
  // Follow XDG on macOS/Linux, LOCALAPPDATA on Windows
  const envOverride = process.env.VITEST_NATIVE_CACHE_DIR;
  if (envOverride) return envOverride;

  if (process.platform === 'win32') {
    return resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'vitest-native');
  }
  return resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), '.cache'), 'vitest-native');
}

// ── Internals ──────────────────────────────────────────────────────

function computeCacheKey(options: HarnessBuildOptions): string {
  const parts = [
    options.platform,
    options.reactNativeVersion,
    ...options.nativeModules.sort(),
    getNativeHarnessVersion(options.packageRoot),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

function getNativeHarnessVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getBinaryPath(buildDir: string, platform: Platform): string {
  if (platform === 'ios') {
    return resolve(
      buildDir, 'project', 'ios', 'DerivedData', 'Build', 'Products',
      'Debug-iphonesimulator', `${HARNESS_APP_NAME}.app`,
    );
  }
  return resolve(buildDir, 'build', `${HARNESS_APP_NAME}.apk`);
}

function run(cmd: string, opts: ExecSyncOptions = {}): string {
  log.verbose(`$ ${cmd}`);
  return (execSync(cmd, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 600000, // 10 min max
    ...opts,
  }) as string).trim();
}

// ── Scaffold ───────────────────────────────────────────────────────

async function scaffoldProject(
  buildDir: string,
  options: HarnessBuildOptions,
): Promise<string> {
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

function customizeProject(projectDir: string, options: HarnessBuildOptions): void {
  log.info('Customizing harness project...');

  // 1. Write our AppDelegate
  if (options.platform === 'ios') {
    customizeIOS(projectDir, options);
  } else {
    customizeAndroid(projectDir, options);
  }

  // 2. Write a minimal package.json (for npm install)
  // Include vitest-react-native-runtime as a file: dep so autolinking
  // picks up the NativeHarness TurboModule via react-native.config.cjs.
  const deps: Record<string, string> = {
    'react': readPeerVersion(options.projectRoot, 'react') ?? '19.1.0',
    'react-native': options.reactNativeVersion,
    'vitest-react-native-runtime': `file:${options.packageRoot}`,
  };
  const devDeps: Record<string, string> = {
    '@react-native-community/cli': 'latest',
    '@react-native-community/cli-platform-ios': 'latest',
    '@react-native-community/cli-platform-android': 'latest',
  };
  for (const mod of options.nativeModules) {
    deps[mod] = readInstalledVersion(options.projectRoot, mod) ?? '*';
  }

  const packageJson = {
    name: HARNESS_APP_NAME.toLowerCase(),
    version: '0.0.0',
    private: true,
    dependencies: deps,
    devDependencies: devDeps,
  };
  writeFileSync(resolve(projectDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  // 3. Install dependencies
  log.info('Installing dependencies...');
  run('npm install --prefer-offline', { cwd: projectDir });
}

function customizeIOS(projectDir: string, _options: HarnessBuildOptions): void {
  const iosDir = resolve(projectDir, 'ios');

  // NativeHarness TurboModule is autolinked via react-native.config.cjs
  // (included because vitest-react-native-runtime is in package.json deps).
  // We only need to bump the iOS deployment target.

  const podfilePath = resolve(iosDir, 'Podfile');
  if (existsSync(podfilePath)) {
    let podfile = readFileSync(podfilePath, 'utf8');
    podfile = podfile.replace(
      /platform\s+:ios,\s*.+/,
      "platform :ios, '16.0'",
    );
    writeFileSync(podfilePath, podfile);
  }

  updateIOSBundleId(projectDir);
}

function customizeAndroid(projectDir: string, _options: HarnessBuildOptions): void {
  const androidDir = resolve(projectDir, 'android');

  // Update the applicationId in build.gradle
  const appBuildGradle = resolve(androidDir, 'app', 'build.gradle');
  if (existsSync(appBuildGradle)) {
    let content = readFileSync(appBuildGradle, 'utf8');
    content = content.replace(
      /applicationId\s+"[^"]+"/,
      `applicationId "${HARNESS_BUNDLE_ID}"`,
    );
    // Ensure minSdk is high enough
    content = content.replace(
      /minSdk\s*=\s*\d+/,
      'minSdk = 24',
    );
    writeFileSync(appBuildGradle, content);
  }
}

function updateIOSBundleId(projectDir: string): void {
  // Update the bundle ID in the pbxproj
  const pbxprojPath = resolve(
    projectDir,
    'ios',
    `${HARNESS_APP_NAME}.xcodeproj`,
    'project.pbxproj',
  );
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

  // Pod install
  log.info('Running pod install...');
  run('pod install', { cwd: iosDir });

  // Build for simulator — need a concrete simulator destination to produce
  // a runnable executable (generic/platform builds don't include the binary)
  log.info('Building for iOS simulator (this may take a few minutes)...');

  // Find a booted simulator UUID for the destination
  let simUdid = '';
  try {
    const bootedJson = run('xcrun simctl list devices booted -j');
    const parsed = JSON.parse(bootedJson);
    for (const devices of Object.values(parsed.devices) as any[]) {
      for (const d of devices) {
        if (d.state === 'Booted' && d.udid) {
          simUdid = d.udid;
          break;
        }
      }
      if (simUdid) break;
    }
  } catch { /* fall through */ }

  const destination = simUdid
    ? `'platform=iOS Simulator,id=${simUdid}'`
    : "'platform=iOS Simulator,name=iPhone 16'"; // fallback

  const buildCmd = [
    'xcodebuild build',
    `-workspace ${HARNESS_APP_NAME}.xcworkspace`,
    `-scheme ${HARNESS_APP_NAME}`,
    '-sdk iphonesimulator',
    '-configuration Debug',
    `-derivedDataPath "${resolve(iosDir, 'DerivedData')}"`,
    `-destination ${destination}`,
    '-quiet',
  ].join(' ');

  run(buildCmd, { cwd: iosDir });

  // Verify the .app exists (getBinaryPath points directly at DerivedData)
  const appPath = resolve(
    iosDir, 'DerivedData', 'Build', 'Products',
    'Debug-iphonesimulator', `${HARNESS_APP_NAME}.app`,
  );
  if (!existsSync(appPath)) {
    throw new Error(`Build succeeded but .app not found at: ${appPath}`);
  }
  log.info(`Binary built: ${appPath}`);
}

async function buildAndroid(projectDir: string): Promise<void> {
  const androidDir = resolve(projectDir, 'android');

  log.info('Building Android debug APK...');

  // Use the gradle wrapper from the scaffolded project
  const gradlew = resolve(androidDir, 'gradlew');
  if (!existsSync(gradlew)) {
    throw new Error('gradlew not found in Android project');
  }

  run(`chmod +x "${gradlew}"`, { cwd: androidDir });
  run(`"${gradlew}" assembleDebug -x lint --no-daemon`, {
    cwd: androidDir,
    timeout: 600000,
  });

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
