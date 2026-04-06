/**
 * vitest-react-native-runtime kill — clean up stuck processes.
 *
 * Kills Metro (port 8081) and Vitest WS server (port 7878).
 *
 * Usage: npx vitest-react-native-runtime kill [--port <port>]
 */

import { execSync } from 'node:child_process';

const args = process.argv;
const portIdx = args.indexOf('--port');

const ports = portIdx >= 0 && args[portIdx + 1]
  ? [parseInt(args[portIdx + 1], 10)]
  : [8081, 7878];

let killed = 0;

for (const port of ports) {
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (pids) {
      const pidList = pids.split('\n').map(p => p.trim()).filter(Boolean);
      for (const pid of pidList) {
        try {
          execSync(`kill -9 ${pid}`, { timeout: 5000 });
          console.log(`  Killed PID ${pid} on port ${port}`);
          killed++;
        } catch {
          console.log(`  Could not kill PID ${pid} on port ${port}`);
        }
      }
    }
  } catch {
    // No process on this port — that's fine
  }
}

if (killed === 0) {
  console.log('  No processes found on ports ' + ports.join(', '));
} else {
  console.log(`\n  Killed ${killed} process(es)`);
}
