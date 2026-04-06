/**
 * vitest-react-native-runtime logs — read Metro and device logs.
 *
 * Usage:
 *   npx vitest-react-native-runtime logs [--lines N] [--app-dir <path>]
 *   npx vitest-react-native-runtime logs --device
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv;

let lines = 50;
const linesIdx = args.indexOf('--lines');
if (linesIdx >= 0 && args[linesIdx + 1]) {
  lines = parseInt(args[linesIdx + 1], 10) || 50;
}

let appDir = process.cwd();
const appDirIdx = args.indexOf('--app-dir');
if (appDirIdx >= 0 && args[appDirIdx + 1]) {
  appDir = resolve(args[appDirIdx + 1]);
}

const deviceMode = args.includes('--device');

if (deviceMode) {
  // Stream iOS simulator logs
  console.log('Streaming device logs (Ctrl+C to stop)...\n');
  try {
    execSync(
      'xcrun simctl spawn booted log stream --predicate \'processImagePath CONTAINS "nativetest"\' --style compact',
      { stdio: 'inherit', timeout: 0 },
    );
  } catch {
    // User interrupted with Ctrl+C
  }
} else {
  const metroLogPath = resolve(appDir, '.vitest-native', 'metro.log');

  if (!existsSync(metroLogPath)) {
    console.error(`No metro log found at ${metroLogPath}`);
    console.error('Metro logs are created when tests run. Try running tests first:');
    console.error('  npx vitest run');
    process.exit(1);
  }

  const content = readFileSync(metroLogPath, 'utf8');
  const allLines = content.split('\n');
  const lastN = allLines.slice(-lines).join('\n');

  // Highlight errors
  const highlighted = lastN.replace(
    /^(.*(?:ERROR|error|Error).*)$/gm,
    (match) => `\x1b[31m${match}\x1b[0m`,
  );

  console.log(highlighted);
}
