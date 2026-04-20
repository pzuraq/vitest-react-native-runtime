import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevice, saveDeviceSnapshot, restoreDeviceSnapshot, getInstalledCacheKey } from '../node/device';
import { getAdbPath } from '../node/exec-utils';
import { ensureHarnessBinary, detectReactNativeVersion, trimBuildCache } from '../node/harness-builder';
import { getLogSink } from '../node/logger';
import type { Platform } from '../node/types';
import { updateStatus } from './ui';
import { teeExec } from './exec-tee';

const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export interface BootstrapOptions {
  appDir: string;
  force: boolean;
  headless: boolean;
  apiLevel?: number;
  /** Additional react-native native modules to link into the harness binary. */
  nativeModules?: string[];
}

/**
 * Unified build + boot + install command.
 *
 * In headless (CI) mode the flow is snapshot-aware: if a device snapshot
 * exists for the current build cache key the device is restored from it
 * (app pre-installed, ~2 min saved). Otherwise it boots fresh, installs,
 * and saves a snapshot for the next run. Build intermediates are also
 * trimmed so the CI cache stays small.
 *
 * In interactive (local) mode this is simply build + boot + install with
 * no snapshot or trimming — identical to the previous behaviour.
 */
export async function bootstrap(platform: string, options: BootstrapOptions): Promise<void> {
  const p = platform as Platform;
  const appDir = resolve(process.cwd(), options.appDir);

  // ── 1. Build (or cache hit) ────────────────────────────────────
  const rnVersion = detectReactNativeVersion(appDir);
  if (!rnVersion) {
    throw new Error(
      'Could not auto-detect React Native version (react-native not found in node_modules).\n' +
        'Install react-native first:\n  npm install react-native\n\n' +
        'Or set reactNativeVersion explicitly in your Vitest config:\n' +
        "  nativePlugin({ reactNativeVersion: '0.81.5' })",
    );
  }

  const spinnerActive = !!getLogSink();
  if (!spinnerActive) {
    console.log(`\nBuilding ${platform} harness binary...`);
    console.log(`  React Native: ${rnVersion}`);
    console.log(`  App dir: ${appDir}\n`);
  }

  if (options.force) {
    const { rmSync } = await import('node:fs');
    const { getCacheDir } = await import('../node/paths');
    try {
      rmSync(resolve(getCacheDir(), 'builds'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  updateStatus(`Building ${platform} harness binary (RN ${rnVersion})…`);
  const result = await ensureHarnessBinary({
    platform: p,
    reactNativeVersion: rnVersion,
    nativeModules: options.nativeModules ?? [],
    packageRoot,
    projectRoot: appDir,
  });

  if (!spinnerActive) {
    if (result.cached) {
      console.log(`Using cached binary (${result.binaryPath})`);
    } else {
      console.log(`Binary built: ${result.binaryPath}`);
    }
    console.log(`\n${platform} build complete.\n`);
  }

  // ── 2. Device: snapshot restore or fresh boot + install ────────
  const bundleId = result.bundleId;

  if (options.headless) {
    // Try snapshot restore first (keyed to the build hash)
    updateStatus(`Restoring ${platform} device snapshot…`);
    const restored = await restoreDeviceSnapshot(p, result.cacheKey, {
      headless: true,
      appDir,
    });

    if (!restored) updateStatus(`Booting ${platform} device…`);
    const deviceId =
      restored ??
      (await ensureDevice(p, {
        headless: true,
        apiLevel: options.apiLevel,
        appDir,
      }));

    const didInstall = installIfNeeded(p, bundleId, result.binaryPath, result.cacheKey, deviceId);

    if (!restored || didInstall) {
      updateStatus(`Saving ${platform} device snapshot…`);
      await saveDeviceSnapshot(p, result.cacheKey, deviceId);
    }

    // Trim intermediate build artifacts so the CI cache stays small
    updateStatus(`Trimming build cache…`);
    trimBuildCache({ platform: p });
  } else {
    // Local / interactive: plain boot + install, no snapshots
    updateStatus(`Booting ${platform} device…`);
    const deviceId = await ensureDevice(p, {
      headless: false,
      apiLevel: options.apiLevel,
      appDir,
    });

    installIfNeeded(p, bundleId, result.binaryPath, result.cacheKey, deviceId);
  }

  if (!spinnerActive) {
    console.log(`\n${platform} device ready with app installed.\n`);
  }
}

/** @returns true if the binary was actually installed, false if skipped. */
function installIfNeeded(
  platform: Platform,
  bundleId: string,
  binaryPath: string,
  cacheKey: string,
  deviceId?: string,
): boolean {
  const installedKey = getInstalledCacheKey(platform, bundleId, deviceId);
  if (installedKey === cacheKey) {
    updateStatus(`Harness binary already installed — skipping`);
    return false;
  }

  updateStatus(`Installing ${platform} harness binary…`);

  if (platform === 'ios') {
    const target = deviceId ?? 'booted';
    teeExec(`xcrun simctl install ${target} "${binaryPath}"`);
  } else {
    const target = deviceId ? `-s ${deviceId} ` : '';
    teeExec(`${getAdbPath()} ${target}install -r "${binaryPath}"`);
  }
  return true;
}
