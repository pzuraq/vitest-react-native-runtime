/**
 * Shared path helpers — cache directory resolution used by both
 * harness-builder.ts (APK builds) and device.ts (AVDs, locks, claims).
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Root cache directory for all vitest-mobile artifacts:
 *   builds/<hash>/   — harness APK/app binaries
 *   avd/             — Android AVD data
 *   device.lock      — device selection lock
 *
 * Override with VITEST_MOBILE_CACHE_DIR (preferred) or
 * VITEST_NATIVE_CACHE_DIR (deprecated, kept for backwards compat).
 *
 * Defaults to XDG_CACHE_HOME/vitest-mobile on Linux/macOS,
 * LOCALAPPDATA/vitest-mobile on Windows.
 */
export function getCacheDir(): string {
  const envOverride = process.env.VITEST_MOBILE_CACHE_DIR || process.env.VITEST_NATIVE_CACHE_DIR;
  if (envOverride) return envOverride;

  if (process.platform === 'win32') {
    return resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'vitest-mobile');
  }
  return resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), '.cache'), 'vitest-mobile');
}
