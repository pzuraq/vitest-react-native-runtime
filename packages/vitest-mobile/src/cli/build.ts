import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureHarnessBinary, detectReactNativeVersion } from '../node/harness-builder';
import { getLogSink } from '../node/logger';
import { getCacheDir } from '../node/paths';
import type { HarnessBuildResult } from '../node/harness-builder';
import { updateStatus } from './ui';

const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export async function build(
  platform: string,
  options: { appDir: string; force: boolean; nativeModules?: string[] },
): Promise<HarnessBuildResult> {
  const appDir = resolve(process.cwd(), options.appDir);

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
    const cacheDir = getCacheDir();
    updateStatus('--force: clearing build cache…');
    try {
      rmSync(resolve(cacheDir, 'builds'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  updateStatus(`Building ${platform} harness binary (RN ${rnVersion})…`);
  const result = await ensureHarnessBinary({
    platform: platform as 'ios' | 'android',
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
  return result;
}
