/**
 * Environment checker — detects missing tools and returns structured diagnostics.
 *
 * Each check returns { ok, message, fix?, detail? }.
 * checkEnvironment() aggregates all checks for a given platform.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EnvironmentCheck, EnvironmentResult, NamedCheck, Platform } from './types';
import { run, getAndroidHome, getAdbPath } from './exec-utils';
import { getCacheDir } from './paths';

interface SimctlListDevice {
  state?: string;
}

interface SimctlListJson {
  devices: Record<string, SimctlListDevice[]>;
}

// ── Android checks ───────────────────────────────────────────────

export function checkAndroidSDK(): EnvironmentCheck {
  const home = getAndroidHome();
  const adb =
    run('which adb') || (existsSync(resolve(home, 'platform-tools/adb')) ? resolve(home, 'platform-tools/adb') : null);

  if (!adb && !existsSync(home)) {
    return {
      ok: false,
      message: 'Android SDK not found',
      fix:
        'Install Android command-line tools:\n' +
        '      curl -L https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip -o cmdline-tools.zip\n' +
        '      mkdir -p ~/Library/Android/sdk/cmdline-tools && unzip cmdline-tools.zip -d ~/Library/Android/sdk/cmdline-tools\n' +
        '      mv ~/Library/Android/sdk/cmdline-tools/cmdline-tools ~/Library/Android/sdk/cmdline-tools/latest\n' +
        '      export ANDROID_HOME=~/Library/Android/sdk\n' +
        '      export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH\n' +
        '      sdkmanager "platform-tools" "emulator" "platforms;android-35" "system-images;android-35;google_apis;x86_64"',
    };
  }

  if (!adb) {
    return {
      ok: false,
      message: 'ADB not found',
      fix: `Install platform-tools: ${home}/cmdline-tools/latest/bin/sdkmanager "platform-tools"`,
    };
  }

  const version = run(`${adb} version`);
  return { ok: true, message: 'Android SDK found', detail: version?.split('\n')[0] };
}

export function checkAndroidEmulator(): EnvironmentCheck {
  const home = getAndroidHome();
  const emulatorBin = run('which emulator') || resolve(home, 'emulator/emulator');

  if (!existsSync(emulatorBin) && !run('which emulator')) {
    return {
      ok: false,
      message: 'Android emulator not found',
      fix: 'Install emulator: sdkmanager "emulator" "system-images;android-35;google_apis;x86_64"',
    };
  }

  return { ok: true, message: 'Emulator available' };
}

export function checkAndroidAVD(): EnvironmentCheck {
  const home = getAndroidHome();
  const emulatorBin = run('which emulator') || resolve(home, 'emulator/emulator');
  const avdHome = process.env.ANDROID_AVD_HOME || resolve(getCacheDir(), 'avd');
  let avds: string | null = null;
  try {
    avds = (
      execSync(`"${emulatorBin}" -list-avds`, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
        env: { ...process.env, ANDROID_AVD_HOME: avdHome },
      }) as string
    ).trim();
  } catch {
    avds = null;
  }

  if (!avds || avds.length === 0) {
    return {
      ok: false,
      message: 'No Android Virtual Devices (AVDs) found',
      fix: 'Create one: avdmanager create avd -n "TestDevice" -k "system-images;android-35;google_apis;x86_64" --device "pixel_6"',
    };
  }

  const avdList = avds.split('\n').filter(Boolean);
  return { ok: true, message: `AVD${avdList.length > 1 ? 's' : ''} found: ${avdList.join(', ')}` };
}

export function checkAndroidDevice(): EnvironmentCheck {
  const output = run(`${getAdbPath()} devices`);
  if (!output) return { ok: false, message: 'ADB not available' };

  const lines = output.split('\n').slice(1);
  const online = lines.some(l => l.includes('device') && !l.includes('offline'));

  if (!online) {
    return {
      ok: false,
      message: 'No Android device/emulator running',
      fix:
        'The pool will auto-boot an emulator when tests run, or start one manually:\n' +
        '      $ANDROID_HOME/emulator/emulator -avd <name>',
      autoFixable: true,
    };
  }

  return { ok: true, message: 'Android device connected' };
}

// ── iOS checks ───────────────────────────────────────────────────

export function checkXcode(): EnvironmentCheck {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'iOS requires macOS', fix: 'iOS testing is only available on macOS machines' };
  }

  const xcodePath = run('xcode-select -p');
  if (!xcodePath) {
    return {
      ok: false,
      message: 'Xcode not installed',
      fix: 'Install Xcode from the App Store, then run: sudo xcode-select --switch /Applications/Xcode.app',
    };
  }

  const version = run('xcodebuild -version');
  return { ok: true, message: 'Xcode installed', detail: version?.split('\n')[0] };
}

export function checkSimulator(): EnvironmentCheck {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'iOS simulators require macOS' };
  }

  const booted = run('xcrun simctl list devices booted -j');
  if (!booted) {
    return { ok: false, message: 'Could not query simulators', fix: 'Ensure Xcode command-line tools are installed' };
  }

  try {
    const parsed = JSON.parse(booted) as SimctlListJson;
    let hasBooted = false;
    for (const runtime of Object.values(parsed.devices)) {
      for (const device of runtime) {
        if (device.state === 'Booted') {
          hasBooted = true;
          break;
        }
      }
      if (hasBooted) break;
    }

    if (!hasBooted) {
      return {
        ok: false,
        message: 'No iOS simulator running',
        fix:
          'The pool will auto-boot a simulator when tests run, or start one manually:\n' +
          '      xcrun simctl boot <device-id>',
        autoFixable: true,
      };
    }

    return { ok: true, message: 'iOS simulator running' };
  } catch {
    return { ok: false, message: 'Failed to parse simulator list' };
  }
}

// ── Shared checks ────────────────────────────────────────────────

export function checkJava(): EnvironmentCheck {
  const version = run('java -version 2>&1');
  if (!version) {
    return {
      ok: false,
      message: 'Java not found (required for Android builds)',
      fix: 'Install JDK 17+: https://adoptium.net/ or brew install openjdk@17',
    };
  }

  const match = version.match(/version "(\d+)/);
  const major = match && match[1] !== undefined ? parseInt(match[1], 10) : 0;

  if (major < 17) {
    return {
      ok: false,
      message: `Java ${major} found, but 17+ is required`,
      fix: 'Install JDK 17+: https://adoptium.net/ or brew install openjdk@17',
    };
  }

  return { ok: true, message: `Java ${major}` };
}

export function checkNode(): EnvironmentCheck {
  const major = parseInt(process.version.slice(1), 10);
  if (major < 18) {
    return {
      ok: false,
      message: `Node ${process.version} found, but 18+ is required`,
      fix: 'Install Node 18+: https://nodejs.org/',
    };
  }
  return { ok: true, message: `Node ${process.version}` };
}

// ── Aggregated check ─────────────────────────────────────────────

/**
 * Run all environment checks for the given platform.
 * Returns { ok, checks } where checks is an array of individual results.
 *
 * Only checks that are blocking (ok: false and not autoFixable) cause ok to be false.
 */
export function checkEnvironment(platform: Platform): EnvironmentResult {
  const checks: NamedCheck[] = [];

  checks.push({ name: 'Node.js', ...checkNode() });

  if (platform === 'android') {
    checks.push({ name: 'Android SDK', ...checkAndroidSDK() });
    checks.push({ name: 'Java', ...checkJava() });
    const sdkOk = checks.find(c => c.name === 'Android SDK')?.ok;
    if (sdkOk) {
      checks.push({ name: 'Emulator', ...checkAndroidEmulator() });
      checks.push({ name: 'AVD', ...checkAndroidAVD() });
      checks.push({ name: 'Device', ...checkAndroidDevice() });
    }
  }

  if (platform === 'ios') {
    checks.push({ name: 'Xcode', ...checkXcode() });
    const xcodeOk = checks.find(c => c.name === 'Xcode')?.ok;
    if (xcodeOk) {
      checks.push({ name: 'Simulator', ...checkSimulator() });
    }
  }

  const blocking = checks.filter(c => !c.ok && !c.autoFixable);
  return {
    ok: blocking.length === 0,
    checks,
    issues: blocking,
  };
}
