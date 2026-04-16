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
import { resolve } from 'node:path';
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
  /** Override cache directory. */
  cacheDir?: string;
  /** Timeout for native build commands in milliseconds (default: 30 minutes). */
  buildTimeout?: number;
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
}

const HARNESS_BUNDLE_ID = 'com.vitest.mobile.harness';
const HARNESS_APP_NAME = 'VitestMobileApp';
const DEFAULT_BUILD_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Bump when the build customization changes in a way that invalidates cached
// binaries (e.g. adding VitestMobileCacheKey to Info.plist / AndroidManifest).
const BUILD_FORMAT_VERSION = 2;

// ── Public API ─────────────────────────────────────────────────────

/**
 * Ensure a harness binary exists for the given configuration.
 * Returns the path to the .app/.apk, building if necessary.
 * Uses a file-based lock to prevent parallel builds from concurrent pool workers.
 */
export async function ensureHarnessBinary(options: HarnessBuildOptions): Promise<HarnessBuildResult> {
  _buildTimeout = options.buildTimeout ?? DEFAULT_BUILD_TIMEOUT;
  const cacheDir = options.cacheDir ?? getCacheDir();
  const cacheKey = computeCacheKey(options);
  const buildDir = resolve(cacheDir, 'builds', cacheKey);
  mkdirSync(buildDir, { recursive: true });

  // Check cache — validate the binary is complete, not just the directory
  const binaryPath = getBinaryPath(buildDir, options.platform);
  if (existsSync(binaryPath) && isBinaryValid(binaryPath, options.platform)) {
    log.info(`Using cached harness binary: ${cacheKey.slice(0, 12)}...`);
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: true, cacheKey };
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
        return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: true, cacheKey };
      }
      if (!existsSync(lockPath)) break; // lock removed = build failed
    }
    throw new Error('Timed out waiting for harness binary build');
  }

  try {
    const buildStart = Date.now();
    log.info('');
    log.info('Building the test harness app for the first time.');
    log.info('This compiles a native iOS/Android binary and will be cached for future runs.');
    log.info(`  React Native ${options.reactNativeVersion} · ${options.platform}`);
    if (options.nativeModules.length > 0) {
      log.info(`  Native modules: ${options.nativeModules.join(', ')}`);
    }
    log.info('');

    const projectDir = await scaffoldProject(buildDir, options);
    customizeProject(projectDir, options, cacheKey);
    await buildProject(projectDir, options.platform);

    if (!existsSync(binaryPath)) {
      throw new Error(`Build completed but binary not found at: ${binaryPath}`);
    }

    const totalElapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
    log.info(`Harness binary built and cached successfully (${totalElapsed}s total).`);
    return { binaryPath, bundleId: HARNESS_BUNDLE_ID, cached: false, cacheKey };
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
 */
export function detectReactNativeVersion(projectRoot: string): string {
  const pkgPath = resolveNodeModule(projectRoot, 'react-native/package.json');
  if (!pkgPath) {
    throw new Error('react-native not found in node_modules. Install it first:\n  npm install react-native');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

/**
 * Remove intermediate build artifacts from the cache, keeping only the final
 * binary (.app or .apk). This drastically reduces the cache size
 * (from ~1.2 GB to ~100 MB for iOS) so CI cache save/restore is fast.
 */
export function trimBuildCache(options: { platform: Platform; cacheDir?: string }): {
  before: number;
  after: number;
  trimmed: boolean;
} {
  const cacheDir = options.cacheDir ?? getCacheDir();
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

    if (options.platform === 'ios') {
      // Keep only: project/ios/DerivedData/Build/Products/Debug-iphonesimulator/*.app
      // Remove: node_modules, Pods, DerivedData/Build/Intermediates.noindex, etc.
      const dirsToRemove = [
        resolve(projectDir, 'node_modules'),
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
      // Android: keep only the .apk
      const dirsToRemove = [
        resolve(projectDir, 'node_modules'),
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

/** @deprecated Use `getCacheDir` from `./paths` directly. */
export const getDefaultCacheDir = getCacheDir;

// ── Internals ──────────────────────────────────────────────────────

const BUILTIN_NATIVE_DEPS = ['react-native-safe-area-context'];

/**
 * Compute the deterministic cache key for a harness build configuration.
 * Used to key both the build cache and the device snapshot cache.
 */
export function computeCacheKey(
  options: Pick<HarnessBuildOptions, 'platform' | 'reactNativeVersion' | 'nativeModules' | 'packageRoot'>,
): string {
  const parts = [
    `fmt${BUILD_FORMAT_VERSION}`,
    options.platform,
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

let _buildTimeout = DEFAULT_BUILD_TIMEOUT;

function run(cmd: string, opts: ExecSyncOptions = {}): string {
  log.verbose(`$ ${cmd}`);
  const start = Date.now();
  const result = (
    execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: _buildTimeout,
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
    timeout: _buildTimeout,
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

  const iconsDir = resolve(options.packageRoot, 'assets', 'icons');

  if (options.platform === 'ios') {
    customizeIOS(projectDir, iconsDir, cacheKey);
  } else {
    customizeAndroid(projectDir, iconsDir, cacheKey);
  }

  // 2. Write a minimal package.json (for npm install)
  // Include vitest-mobile as a file: dep so autolinking
  // picks up the VitestMobileHarness TurboModule via react-native.config.cjs.
  const deps: Record<string, string> = {
    react: readPeerVersion(options.projectRoot, 'react') ?? '19.1.0',
    'react-native': options.reactNativeVersion,
    'react-native-safe-area-context':
      readInstalledVersion(options.projectRoot, 'react-native-safe-area-context') ?? '^5.0.0',
    'vitest-mobile': `file:${options.packageRoot}`,
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
  log.info('Installing dependencies... (this may take a minute)');
  const depsStart = Date.now();
  runLive('npm install', { cwd: projectDir });
  log.info(`  Dependencies installed (${((Date.now() - depsStart) / 1000).toFixed(1)}s)`);
}

function customizeIOS(projectDir: string, iconsDir: string, cacheKey: string): void {
  const iosDir = resolve(projectDir, 'ios');

  const podfilePath = resolve(iosDir, 'Podfile');
  if (existsSync(podfilePath)) {
    let podfile = readFileSync(podfilePath, 'utf8');
    podfile = podfile.replace(/platform\s+:ios,\s*.+/, "platform :ios, '16.0'");
    writeFileSync(podfilePath, podfile);
  }

  updateIOSBundleId(projectDir);

  const infoPlistPath = resolve(iosDir, HARNESS_APP_NAME, 'Info.plist');
  if (existsSync(infoPlistPath)) {
    let plist = readFileSync(infoPlistPath, 'utf8');
    plist = plist.replace(
      /<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
      '<key>CFBundleDisplayName</key>\n\t<string>Vitest</string>',
    );
    plist = plist.replace(
      /<\/dict>\s*<\/plist>/,
      `\t<key>VitestMobileCacheKey</key>\n\t<string>${cacheKey}</string>\n</dict>\n</plist>`,
    );
    writeFileSync(infoPlistPath, plist);
  }

  installIOSIcons(iosDir, iconsDir);
  installIOSSplash(iosDir, iconsDir);
}

function customizeAndroid(projectDir: string, iconsDir: string, cacheKey: string): void {
  const androidDir = resolve(projectDir, 'android');

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

  const stringsPath = resolve(androidDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  if (existsSync(stringsPath)) {
    let strings = readFileSync(stringsPath, 'utf8');
    strings = strings.replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">Vitest</string>');
    writeFileSync(stringsPath, strings);
  }

  const manifestPath = resolve(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (existsSync(manifestPath)) {
    let manifest = readFileSync(manifestPath, 'utf8');
    manifest = manifest.replace(
      /<\/application>/,
      `    <meta-data android:name="vitest-mobile-cache-key" android:value="${cacheKey}" />\n    </application>`,
    );
    writeFileSync(manifestPath, manifest);
  }

  installAndroidIcons(androidDir, iconsDir);
  installAndroidSplash(androidDir, iconsDir);
}

function installIOSIcons(iosDir: string, iconsDir: string): void {
  const srcIconsDir = resolve(iconsDir, 'ios');
  if (!existsSync(srcIconsDir)) {
    log.verbose('No iOS icons found in assets, skipping icon installation');
    return;
  }

  const appIconSetDir = resolve(iosDir, HARNESS_APP_NAME, 'Images.xcassets', 'AppIcon.appiconset');
  if (!existsSync(appIconSetDir)) {
    mkdirSync(appIconSetDir, { recursive: true });
  }

  cpSync(srcIconsDir, appIconSetDir, { recursive: true });
  log.verbose('Installed iOS app icons');
}

function installIOSSplash(iosDir: string, iconsDir: string): void {
  // Use app-icon.png (1024x1024 square icon) rather than the full-screen
  // splash-portrait.png. The storyboard provides the dark background and
  // centers the icon via constraints — using the full splash image causes
  // scaling artifacts when squeezed into the imageView.
  const iconSrc = resolve(iconsDir, 'app-icon.png');
  if (!existsSync(iconSrc)) {
    log.verbose('No app icon found in assets, skipping splash installation');
    return;
  }

  const splashImageSetDir = resolve(iosDir, HARNESS_APP_NAME, 'Images.xcassets', 'SplashImage.imageset');
  mkdirSync(splashImageSetDir, { recursive: true });

  cpSync(iconSrc, resolve(splashImageSetDir, 'splash.png'));
  writeFileSync(
    resolve(splashImageSetDir, 'Contents.json'),
    JSON.stringify(
      {
        images: [{ filename: 'splash.png', idiom: 'universal' }],
        info: { version: 1, author: 'vitest-mobile' },
      },
      null,
      2,
    ),
  );

  // Modify the template LaunchScreen.storyboard rather than replacing it
  // wholesale. This preserves the toolsVersion / systemVersion attributes
  // that match the user's Xcode, avoiding "Unknown target runtime" or
  // version-mismatch failures across different Xcode installs.
  const storyboardPath = resolve(iosDir, HARNESS_APP_NAME, 'LaunchScreen.storyboard');
  if (!existsSync(storyboardPath)) {
    log.verbose('LaunchScreen.storyboard not found, skipping splash modification');
    return;
  }

  let storyboard = readFileSync(storyboardPath, 'utf8');

  // Extract the <document ...> opening tag so we keep its attributes intact
  const docMatch = storyboard.match(/<document[^>]+>/);
  if (!docMatch) {
    log.verbose('Could not parse LaunchScreen.storyboard, skipping splash modification');
    return;
  }
  const docTag = docMatch[0];

  // Find the view controller ID used in the template (initialViewController attr)
  const vcIdMatch = docTag.match(/initialViewController="([^"]+)"/);
  const vcId = vcIdMatch?.[1] ?? '01J-lp-oVM';

  // Build a new storyboard body that uses the template's document header.
  // We generate the scene contents ourselves to get the splash image + dark bg,
  // but the <document> attributes come from whatever Xcode version scaffolded it.
  storyboard = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    docTag,
    `    <scenes>`,
    `        <scene sceneID="EHf-IW-A2E">`,
    `            <objects>`,
    `                <viewController id="${vcId}" sceneMemberID="viewController">`,
    `                    <view key="view" contentMode="scaleToFill" id="Ze5-6b-2t3">`,
    `                        <rect key="frame" x="0.0" y="0.0" width="393" height="852"/>`,
    `                        <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>`,
    `                        <subviews>`,
    `                            <imageView clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleAspectFit" image="SplashImage" translatesAutoresizingMaskIntoConstraints="NO" id="Kdr-Md-lw4">`,
    `                                <rect key="frame" x="56.5" y="286" width="280" height="280"/>`,
    `                                <constraints>`,
    `                                    <constraint firstAttribute="width" constant="280" id="Wid-th-c01"/>`,
    `                                    <constraint firstAttribute="height" constant="280" id="Hei-gh-c01"/>`,
    `                                </constraints>`,
    `                            </imageView>`,
    `                        </subviews>`,
    `                        <viewLayoutGuide key="safeArea" id="Bcu-se-gPh"/>`,
    `                        <color key="backgroundColor" red="0.11764705882352941" green="0.11764705882352941" blue="0.11764705882352941" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>`,
    `                        <constraints>`,
    `                            <constraint firstItem="Kdr-Md-lw4" firstAttribute="centerX" secondItem="Ze5-6b-2t3" secondAttribute="centerX" id="CnX-vm-c01"/>`,
    `                            <constraint firstItem="Kdr-Md-lw4" firstAttribute="centerY" secondItem="Ze5-6b-2t3" secondAttribute="centerY" id="CnY-vm-c01"/>`,
    `                        </constraints>`,
    `                    </view>`,
    `                </viewController>`,
    `                <placeholder placeholderIdentifier="IBFirstResponder" id="iYj-Kq-Ea1" userLabel="First Responder" sceneMemberID="firstResponder"/>`,
    `            </objects>`,
    `            <point key="canvasLocation" x="0" y="0"/>`,
    `        </scene>`,
    `    </scenes>`,
    `    <resources>`,
    `        <image name="SplashImage" width="280" height="280"/>`,
    `    </resources>`,
    `</document>`,
  ].join('\n');

  writeFileSync(storyboardPath, storyboard);
  log.verbose('Installed iOS splash screen');
}

function installAndroidIcons(androidDir: string, iconsDir: string): void {
  const srcAndroidDir = resolve(iconsDir, 'android');
  if (!existsSync(srcAndroidDir)) {
    log.verbose('No Android icons found in assets, skipping icon installation');
    return;
  }

  const resDir = resolve(androidDir, 'app', 'src', 'main', 'res');
  const densities = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];

  for (const density of densities) {
    const srcIcon = resolve(srcAndroidDir, density, 'ic_launcher.png');
    if (!existsSync(srcIcon)) continue;

    const targetDir = resolve(resDir, density);
    mkdirSync(targetDir, { recursive: true });

    cpSync(srcIcon, resolve(targetDir, 'ic_launcher.png'));
    cpSync(srcIcon, resolve(targetDir, 'ic_launcher_round.png'));
  }

  // Set up adaptive icon (API 26+) using the foreground image + solid background.
  // This makes the icon fill the launcher shape (circle, squircle, etc.) properly.
  const adaptiveSrc = resolve(iconsDir, 'adaptive-icon.png');
  if (existsSync(adaptiveSrc)) {
    for (const density of densities) {
      const targetDir = resolve(resDir, density);
      mkdirSync(targetDir, { recursive: true });
      cpSync(adaptiveSrc, resolve(targetDir, 'ic_launcher_foreground.png'));
    }

    const adaptiveDir = resolve(resDir, 'mipmap-anydpi-v26');
    mkdirSync(adaptiveDir, { recursive: true });

    const adaptiveXml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <background android:drawable="@color/ic_launcher_background"/>',
      '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>',
      '</adaptive-icon>',
    ].join('\n');

    writeFileSync(resolve(adaptiveDir, 'ic_launcher.xml'), adaptiveXml);
    writeFileSync(resolve(adaptiveDir, 'ic_launcher_round.xml'), adaptiveXml);

    // Add the launcher background color
    const colorsPath = resolve(resDir, 'values', 'colors.xml');
    if (existsSync(colorsPath)) {
      let colors = readFileSync(colorsPath, 'utf8');
      if (!colors.includes('ic_launcher_background')) {
        colors = colors.replace(
          '</resources>',
          '    <color name="ic_launcher_background">#1E1E1E</color>\n</resources>',
        );
        writeFileSync(colorsPath, colors);
      }
    } else {
      mkdirSync(resolve(resDir, 'values'), { recursive: true });
      writeFileSync(
        colorsPath,
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<resources>',
          '    <color name="ic_launcher_background">#1E1E1E</color>',
          '</resources>',
        ].join('\n'),
      );
    }
  }

  log.verbose('Installed Android app icons');
}

function installAndroidSplash(androidDir: string, iconsDir: string): void {
  // Use app-icon.png (1024x1024 square icon) rather than the full-screen
  // splash-android.png. The layer-list drawable provides the dark background
  // and centers the icon — using the full splash image causes scaling artifacts.
  const iconSrc = resolve(iconsDir, 'app-icon.png');
  if (!existsSync(iconSrc)) {
    log.verbose('No app icon found in assets, skipping splash installation');
    return;
  }

  const resDir = resolve(androidDir, 'app', 'src', 'main', 'res');

  const drawableDir = resolve(resDir, 'drawable');
  mkdirSync(drawableDir, { recursive: true });
  cpSync(iconSrc, resolve(drawableDir, 'splash_image.png'));

  writeFileSync(
    resolve(drawableDir, 'splash_background.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">',
      '  <item android:drawable="@color/splash_background_color"/>',
      '  <item>',
      '    <bitmap android:gravity="center" android:src="@drawable/splash_image"/>',
      '  </item>',
      '</layer-list>',
    ].join('\n'),
  );

  // Add the splash background color to colors.xml.
  // RN templates vary — some have colors.xml, some don't — so we handle both.
  const colorsPath = resolve(resDir, 'values', 'colors.xml');
  if (existsSync(colorsPath)) {
    let colors = readFileSync(colorsPath, 'utf8');
    if (!colors.includes('splash_background_color')) {
      colors = colors.replace(
        '</resources>',
        '    <color name="splash_background_color">#1E1E1E</color>\n</resources>',
      );
      writeFileSync(colorsPath, colors);
    }
  } else {
    mkdirSync(resolve(resDir, 'values'), { recursive: true });
    writeFileSync(
      colorsPath,
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<resources>',
        '    <color name="splash_background_color">#1E1E1E</color>',
        '</resources>',
      ].join('\n'),
    );
  }

  // Read the manifest to discover what theme the MainActivity currently uses,
  // then create a BootTheme that extends it with our splash background.
  // This handles any RN template version (AppTheme, Theme.App.SplashScreen, etc.)
  const manifestPath = resolve(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!existsSync(manifestPath)) {
    log.verbose('AndroidManifest.xml not found, skipping splash theme');
    return;
  }

  let manifest = readFileSync(manifestPath, 'utf8');

  // Discover what theme to extend. Check the activity first, then fall back to
  // the application-level theme (the common case in RN templates).
  const activityBlock = manifest.match(/<activity[^>]*android:name="\.MainActivity"[^>]*>/s)?.[0];
  const activityTheme = activityBlock?.match(/android:theme="@style\/([^"]+)"/)?.[1];
  const appTheme = manifest.match(/<application[^>]*android:theme="@style\/([^"]+)"/s)?.[1];
  const parentTheme = activityTheme ?? appTheme ?? 'AppTheme';

  const splashStylesPath = resolve(resDir, 'values', 'splash_styles.xml');
  writeFileSync(
    splashStylesPath,
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<resources>',
      `    <style name="BootTheme" parent="${parentTheme}">`,
      '        <item name="android:windowBackground">@drawable/splash_background</item>',
      '    </style>',
      '</resources>',
    ].join('\n'),
  );

  if (activityTheme) {
    // Activity already has a theme — replace it
    manifest = manifest.replace(
      new RegExp(`(<activity[^>]*android:name="\\.MainActivity"[^>]*?)android:theme="@style/${activityTheme}"`, 's'),
      '$1android:theme="@style/BootTheme"',
    );
    manifest = manifest.replace(
      new RegExp(`android:theme="@style/${activityTheme}"([^>]*?android:name="\\.MainActivity")`, 's'),
      'android:theme="@style/BootTheme"$1',
    );
  } else {
    // No theme on activity (inherits from <application>) — add one
    manifest = manifest.replace(
      /(<activity\s+android:name="\.MainActivity")/s,
      '$1\n            android:theme="@style/BootTheme"',
    );
  }
  writeFileSync(manifestPath, manifest);
  log.verbose('Installed Android splash screen');
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
