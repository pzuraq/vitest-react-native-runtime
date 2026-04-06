/**
 * vitest-react-native-runtime tap — simulate a touch event.
 *
 * Usage: npx vitest-react-native-runtime tap <x> <y> [--platform android|ios]
 */

import { execSync } from 'node:child_process';
import { detectPlatform } from '../node/screenshot';
import type { Platform } from '../node/types';

const args = process.argv;

let platform: Platform | undefined;
const platformIdx = args.indexOf('--platform');
if (platformIdx >= 0 && args[platformIdx + 1]) {
  const val = args[platformIdx + 1];
  if (val === 'android' || val === 'ios') platform = val;
}

// Find x and y — first two numeric args
const nums = args.filter(a => /^\d+$/.test(a));
if (nums.length < 2) {
  console.error('Usage: npx vitest-react-native-runtime tap <x> <y> [--platform android|ios]');
  process.exit(1);
}

const x = parseInt(nums[0], 10);
const y = parseInt(nums[1], 10);
const plat = platform ?? detectPlatform();

try {
  if (plat === 'ios') {
    execSync(`xcrun simctl io booted tap ${x} ${y}`, { stdio: 'inherit', timeout: 5000 });
  } else {
    execSync(`adb shell input tap ${x} ${y}`, { stdio: 'inherit', timeout: 5000 });
  }
  console.log(`Tapped at (${x}, ${y}) on ${plat}`);
} catch (e) {
  console.error(`Failed to tap: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
