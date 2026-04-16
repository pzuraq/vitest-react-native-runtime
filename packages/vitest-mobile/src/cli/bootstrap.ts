import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevice, saveDeviceSnapshot, restoreDeviceSnapshot, getInstalledCacheKey } from '../node/device';
import { getAdbPath } from '../node/exec-utils';
import { ensureHarnessBinary, detectReactNativeVersion, trimBuildCache } from '../node/harness-builder';
import type { Platform } from '../node/types';

const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export interface BootstrapOptions {
  appDir: string;
  force: boolean;
  headless: boolean;
  apiLevel?: number;
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

  console.log(`\nBuilding ${platform} harness binary...`);
  console.log(`  React Native: ${rnVersion}`);
  console.log(`  App dir: ${appDir}\n`);

  if (options.force) {
    const { rmSync } = await import('node:fs');
    const { getCacheDir } = await import('../node/paths');
    try {
      rmSync(resolve(getCacheDir(), 'builds'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const result = await ensureHarnessBinary({
    platform: p,
    reactNativeVersion: rnVersion,
    nativeModules: [],
    packageRoot,
    projectRoot: appDir,
  });

  if (result.cached) {
    console.log(`Using cached binary (${result.binaryPath})`);
  } else {
    console.log(`Binary built: ${result.binaryPath}`);
  }
  console.log(`\n${platform} build complete.\n`);

  // ── 2. Device: snapshot restore or fresh boot + install ────────
  const bundleId = result.bundleId;

  if (options.headless) {
    // Try snapshot restore first (keyed to the build hash)
    const restored = await restoreDeviceSnapshot(p, result.cacheKey, {
      headless: true,
    });

    if (!restored) {
      await ensureDevice(p, {
        headless: true,
        apiLevel: options.apiLevel,
      });
    }

    const didInstall = installIfNeeded(p, bundleId, result.binaryPath, result.cacheKey);

    if (!restored || didInstall) {
      await saveDeviceSnapshot(p, result.cacheKey);
    }

    // Trim intermediate build artifacts so the CI cache stays small
    trimBuildCache({ platform: p });
  } else {
    // Local / interactive: plain boot + install, no snapshots
    await ensureDevice(p, {
      headless: false,
      apiLevel: options.apiLevel,
    });

    installIfNeeded(p, bundleId, result.binaryPath, result.cacheKey);
  }

  console.log(`\n${platform} device ready with app installed.\n`);
}

/** @returns true if the binary was actually installed, false if skipped. */
function installIfNeeded(platform: Platform, bundleId: string, binaryPath: string, cacheKey: string): boolean {
  const installedKey = getInstalledCacheKey(platform, bundleId);
  if (installedKey === cacheKey) {
    console.log('\nHarness binary already installed — skipping install\n');
    return false;
  }

  console.log(`\nInstalling ${binaryPath}...\n`);

  if (platform === 'ios') {
    execSync(`xcrun simctl install booted "${binaryPath}"`, { stdio: 'inherit' });
  } else {
    execSync(`${getAdbPath()} install -r "${binaryPath}"`, { stdio: 'inherit' });
  }
  return true;
}
