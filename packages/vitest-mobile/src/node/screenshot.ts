/**
 * Screenshot capture — takes screenshots of the running emulator/simulator.
 *
 * Uses host-side platform tools (adb for Android, xcrun simctl for iOS).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { log } from './logger';
import { getAdbPath } from './exec-utils';
import { isAndroidDeviceOnline, getBootedSimulator } from './device';
import type { Platform } from './types';

export interface ScreenshotOptions {
  platform: Platform;
  output?: string;
  name?: string;
  outputDir?: string;
  /** Target a specific device (UDID or serial). Falls back to "booted" / default. */
  deviceId?: string;
}

export interface ScreenshotResult {
  filePath: string;
  platform: Platform;
  timestamp: number;
}

/**
 * Auto-detect which platform has a running device/emulator.
 * Throws if none or both are running (in the latter case, require explicit --platform).
 */
export function detectPlatform(): Platform {
  const android = isAndroidDeviceOnline();
  const ios = getBootedSimulator() !== null;

  if (android && ios) {
    throw new Error('Both Android and iOS devices are running. Specify --platform android or --platform ios.');
  }
  if (!android && !ios) {
    throw new Error(
      'No running device found. Start one with:\n' +
        '  npx vitest-mobile boot-device android\n' +
        '  npx vitest-mobile boot-device ios',
    );
  }
  return android ? 'android' : 'ios';
}

function ensureScreenshotDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const gitignorePath = resolve(dir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n');
  }
}

/**
 * Capture a screenshot of the running emulator/simulator.
 */
export function captureScreenshot(options: ScreenshotOptions): ScreenshotResult {
  const { platform, name = 'screenshot' } = options;
  const timestamp = Date.now();

  let filePath: string;
  if (options.output) {
    filePath = resolve(options.output);
    mkdirSync(dirname(filePath), { recursive: true });
  } else {
    const dir = options.outputDir ?? resolve(process.cwd(), '.vitest-mobile', 'screenshots');
    ensureScreenshotDir(dir);
    filePath = resolve(dir, `${name}-${timestamp}.png`);
  }

  if (platform === 'android') {
    captureAndroid(filePath, options.deviceId);
  } else {
    captureIOS(filePath, options.deviceId);
  }

  return { filePath, platform, timestamp };
}

function captureAndroid(filePath: string, deviceId?: string): void {
  try {
    const target = deviceId ? `-s ${deviceId} ` : '';
    const buffer = execSync(`${getAdbPath()} ${target}exec-out screencap -p`, {
      encoding: 'buffer',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    writeFileSync(filePath, buffer);
  } catch (e) {
    throw new Error(`Failed to capture Android screenshot: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function captureIOS(filePath: string, deviceId?: string): void {
  try {
    const target = deviceId ?? 'booted';
    execSync(`xcrun simctl io ${target} screenshot "${filePath}"`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (e) {
    throw new Error(`Failed to capture iOS screenshot: ${e instanceof Error ? e.message : String(e)}`);
  }
}
