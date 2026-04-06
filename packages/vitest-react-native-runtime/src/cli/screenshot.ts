/**
 * CLI: npx vitest-react-native-runtime screenshot [--platform android|ios] [--output path.png]
 */

import { captureScreenshot, detectPlatform } from '../node/screenshot';
import type { Platform } from '../node/types';

const args = process.argv;

let platform: Platform | undefined;
const platformIdx = args.indexOf('--platform');
if (platformIdx >= 0 && args[platformIdx + 1]) {
  const val = args[platformIdx + 1];
  if (val !== 'android' && val !== 'ios') {
    console.error(`Invalid platform: ${val}. Must be "android" or "ios".`);
    process.exit(1);
  }
  platform = val;
}

let output: string | undefined;
const outputIdx = args.indexOf('--output');
if (outputIdx >= 0 && args[outputIdx + 1]) {
  output = args[outputIdx + 1];
}

try {
  const resolvedPlatform = platform ?? detectPlatform();
  const result = captureScreenshot({ platform: resolvedPlatform, output });
  console.log(result.filePath);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
