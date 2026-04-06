/**
 * vitest-react-native-runtime install — boot a device and install the test harness app.
 *
 * Usage:
 *   npx vitest-react-native-runtime install android [--app-dir .]
 *   npx vitest-react-native-runtime install ios     [--app-dir .]
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ensureDevice } from '../node/device';
import type { Platform } from '../node/types';

const args = process.argv.slice(2);
const platform = args[0] as Platform | undefined;

if (platform !== 'android' && platform !== 'ios') {
  console.error('Usage: npx vitest-react-native-runtime install <android|ios> [--app-dir <path>]');
  process.exit(1);
}

const appDirFlagIdx = args.indexOf('--app-dir');
const appDir = resolve(
  process.cwd(),
  appDirFlagIdx !== -1 ? (args[appDirFlagIdx + 1] ?? '.') : '.',
);

function run(cmd: string): string {
  return execSync(cmd, { cwd: appDir, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// Ensure device/emulator is running
await ensureDevice(platform, { headless: false });

if (platform === 'android') {
  const apk = run("find android -name 'app-debug.apk' | head -1");
  if (!apk) {
    console.error('No APK found. Run `npx vitest-react-native-runtime build android` first.');
    process.exit(1);
  }
  console.log(`\nInstalling ${apk}...\n`);
  execSync(`adb install "${apk}"`, { cwd: appDir, stdio: 'inherit' });
} else {
  const app = run("find build -name '*.app' -type d | head -1");
  if (!app) {
    console.error('No .app bundle found. Run `npx vitest-react-native-runtime build ios` first.');
    process.exit(1);
  }
  console.log(`\nInstalling ${app}...\n`);
  execSync(`xcrun simctl install booted "${app}"`, { cwd: appDir, stdio: 'inherit' });
}

console.log(`\n${platform} app installed.\n`);
