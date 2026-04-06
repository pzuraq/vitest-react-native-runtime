/**
 * vitest-react-native-runtime type-text — input text on the device.
 *
 * Usage: npx vitest-react-native-runtime type-text "hello world" [--platform android|ios]
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

// Text is everything after the command name that isn't a flag
const textParts: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform') { i++; continue; }
  textParts.push(args[i]);
}
const text = textParts.join(' ');

if (!text) {
  console.error('Usage: npx vitest-react-native-runtime type-text "hello world" [--platform android|ios]');
  process.exit(1);
}

const plat = platform ?? detectPlatform();

try {
  if (plat === 'ios') {
    // xcrun simctl io booted sendkeys works character by character
    execSync(`xcrun simctl io booted sendkeys "${text.replace(/"/g, '\\"')}"`, {
      stdio: 'inherit',
      timeout: 10000,
    });
  } else {
    // adb shell input text replaces spaces with %s
    const escaped = text.replace(/ /g, '%s').replace(/"/g, '\\"');
    execSync(`adb shell input text "${escaped}"`, { stdio: 'inherit', timeout: 10000 });
  }
  console.log(`Typed: "${text}" on ${plat}`);
} catch (e) {
  console.error(`Failed to type text: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
