/**
 * Shared shell execution helpers used by device.ts and environment.ts.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function run(cmd: string, opts: ExecSyncOptions = {}): string | null {
  try {
    return (
      execSync(cmd, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 60000,
        ...opts,
      }) as string
    ).trim();
  } catch {
    return null;
  }
}

export function getAndroidHome(): string {
  return (
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(process.env.HOME || '', 'Library/Android/sdk')
  );
}

/** Resolve the full path to the adb binary. Falls back to bare 'adb' if not found in the SDK. */
export function getAdbPath(): string {
  const candidate = resolve(getAndroidHome(), 'platform-tools', 'adb');
  if (existsSync(candidate)) return candidate;
  return 'adb';
}
