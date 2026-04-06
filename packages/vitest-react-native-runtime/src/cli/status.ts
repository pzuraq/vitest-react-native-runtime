/**
 * vitest-react-native-runtime status — single-pane-of-glass health check.
 *
 * Usage: npx vitest-react-native-runtime status [--platform android|ios]
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { getBootedSimulator, getBootedSimulatorInfo, isAndroidDeviceOnline } from '../node/device';
import { detectPlatform } from '../node/screenshot';
import type { Platform } from '../node/types';

const args = process.argv;
let platform: Platform | undefined;
const platformIdx = args.indexOf('--platform');
if (platformIdx >= 0 && args[platformIdx + 1]) {
  const val = args[platformIdx + 1];
  if (val === 'android' || val === 'ios') platform = val;
}

interface Check {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function checkSimulator(): Check {
  const sim = getBootedSimulatorInfo();
  if (sim) {
    return { name: 'iOS Simulator', passed: true, detail: `Booted: ${sim.name} (${sim.runtime})` };
  }
  return {
    name: 'iOS Simulator',
    passed: false,
    detail: 'No booted simulator found',
    fix: 'npx vitest-react-native-runtime boot-device ios',
  };
}

function checkAndroid(): Check {
  const online = isAndroidDeviceOnline();
  if (online) {
    return { name: 'Android Emulator', passed: true, detail: 'Device online' };
  }
  return {
    name: 'Android Emulator',
    passed: false,
    detail: 'No online device found',
    fix: 'npx vitest-react-native-runtime boot-device android',
  };
}

function checkAppInstalled(plat: Platform): Check {
  try {
    if (plat === 'ios') {
      const sim = getBootedSimulator();
      if (!sim) return { name: 'App installed', passed: false, detail: 'No simulator booted' };
      try {
        const container = execSync(
          `xcrun simctl get_app_container ${sim} com.vitest.nativetest 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 },
        ).trim();
        return {
          name: 'App installed',
          passed: true,
          detail: `com.vitest.nativetest at ${container.split('/').pop()}`,
        };
      } catch {
        return {
          name: 'App installed',
          passed: false,
          detail: 'App not installed',
          fix: 'npx vitest-react-native-runtime bootstrap ios',
        };
      }
    } else {
      const output = execSync('adb shell pm list packages 2>/dev/null | grep com.vitest.nativetest || true', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      const installed = output.length > 0;
      return {
        name: 'App installed',
        passed: installed,
        detail: installed ? 'com.vitest.nativetest found' : 'App not installed',
        fix: installed ? undefined : 'npx vitest-react-native-runtime bootstrap android',
      };
    }
  } catch {
    return { name: 'App installed', passed: false, detail: 'Could not check' };
  }
}

function checkAppRunning(plat: Platform): Check {
  try {
    if (plat === 'ios') {
      const sim = getBootedSimulator();
      if (!sim) return { name: 'App running', passed: false, detail: 'No simulator booted' };
      const output = execSync(
        `xcrun simctl spawn ${sim.udid} launchctl list 2>/dev/null | grep -c nativetest || true`,
        { encoding: 'utf8', timeout: 5000 },
      ).trim();
      return {
        name: 'App running',
        passed: parseInt(output, 10) > 0,
        detail: parseInt(output, 10) > 0 ? 'App process found' : 'App not running',
      };
    } else {
      const output = execSync('adb shell pidof com.vitest.nativetest 2>/dev/null || true', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      return {
        name: 'App running',
        passed: output.length > 0,
        detail: output.length > 0 ? `PID: ${output}` : 'App not running',
      };
    }
  } catch {
    return { name: 'App running', passed: false, detail: 'Could not check' };
  }
}

async function checkMetro(): Promise<Check> {
  const running = await checkPort(8081);
  return {
    name: 'Metro (port 8081)',
    passed: running,
    detail: running ? 'Responding' : 'Not reachable',
    fix: running ? undefined : 'Metro starts automatically when running tests',
  };
}

async function checkWS(): Promise<Check> {
  const running = await checkPort(7878);
  return {
    name: 'Vitest WS (port 7878)',
    passed: running,
    detail: running ? 'Responding' : 'Not reachable',
    fix: running ? undefined : 'WS server starts automatically when running tests',
  };
}

async function checkCDPTargets(): Promise<Check> {
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const req = http.get('http://localhost:8081/json/list', (res) => {
        let d = '';
        res.on('data', (chunk: Buffer) => (d += chunk));
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    const targets = JSON.parse(data);
    return {
      name: 'CDP targets',
      passed: targets.length > 0,
      detail: `${targets.length} target(s) connected`,
    };
  } catch {
    return { name: 'CDP targets', passed: false, detail: 'Metro not reachable or no targets' };
  }
}

async function main() {
  const plat = platform ?? (function () {
    try { return detectPlatform(); } catch { return 'ios' as Platform; }
  })();

  console.log(`\n  vitest-react-native-runtime status (${plat})\n`);

  const checks: Check[] = [];

  // Device check
  if (plat === 'ios') {
    checks.push(checkSimulator());
  } else {
    checks.push(checkAndroid());
  }

  // App checks
  checks.push(checkAppInstalled(plat));
  checks.push(checkAppRunning(plat));

  // Network checks
  checks.push(await checkMetro());
  checks.push(await checkWS());
  checks.push(await checkCDPTargets());

  // Print results
  let failures = 0;
  for (const c of checks) {
    const icon = c.passed ? '✓' : '✗';
    console.log(`  ${icon} ${c.name}: ${c.detail}`);
    if (!c.passed) {
      failures++;
      if (c.fix) console.log(`    → ${c.fix}`);
    }
  }

  console.log(`\n  ${checks.length - failures}/${checks.length} checks passed\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
