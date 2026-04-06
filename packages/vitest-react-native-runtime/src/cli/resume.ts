/**
 * CLI: npx vitest-react-native-runtime resume [--app-dir <path>]
 *
 * Sends a resume signal to the running pool by writing a signal file.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv;
const appDirIdx = args.indexOf('--app-dir');
const appDir = appDirIdx >= 0 && args[appDirIdx + 1] ? args[appDirIdx + 1] : '.';

const signalDir = resolve(process.cwd(), appDir, '.vitest-native');
mkdirSync(signalDir, { recursive: true });
writeFileSync(resolve(signalDir, 'resume-signal'), String(Date.now()));
console.log('Resume signal sent.');
