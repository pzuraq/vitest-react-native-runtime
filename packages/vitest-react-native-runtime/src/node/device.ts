/**
 * Device lifecycle — boot emulators/simulators, wait for ready, setup ports.
 */

import { execSync, spawn, type ExecSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger';
import type { DeviceOptions, Platform } from './types';

/** One simulator row from `xcrun simctl list devices -j`. */
interface SimctlDeviceEntry {
  state?: string;
  isAvailable?: boolean;
  udid?: string;
  name?: string;
}

/** Info about a booted simulator. */
export interface SimulatorInfo {
  udid: string;
  name: string;
  runtime: string;
}

/** Root of simctl `list devices` JSON. */
interface SimctlDevicesJson {
  devices: Record<string, SimctlDeviceEntry[]>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseSimctlDevicesJson(json: string): SimctlDevicesJson | null {
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data !== 'object' || data === null || !('devices' in data)) {
      return null;
    }
    const { devices } = data as { devices: unknown };
    if (typeof devices !== 'object' || devices === null) {
      return null;
    }
    const map = devices as Record<string, unknown>;
    const normalized: Record<string, SimctlDeviceEntry[]> = {};
    for (const [key, value] of Object.entries(map)) {
      if (!Array.isArray(value)) continue;
      normalized[key] = value as SimctlDeviceEntry[];
    }
    return { devices: normalized };
  } catch {
    return null;
  }
}

function run(cmd: string, opts: ExecSyncOptions = {}): string | null {
  try {
    return (
      execSync(cmd, {
        encoding: 'utf8' as const,
        stdio: 'pipe',
        timeout: 10000,
        ...opts,
      }) as string
    ).trim();
  } catch {
    return null;
  }
}

function getAndroidHome(): string {
  return (
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(process.env.HOME || '', 'Library/Android/sdk')
  );
}

let poolBootedEmulator = false;

// ── Android ──────────────────────────────────────────────────────

export function isAndroidDeviceOnline(): boolean {
  const output = run('adb devices');
  if (!output) return false;
  const lines = output.split('\n').slice(1);
  return lines.some(l => l.includes('device') && !l.includes('offline'));
}

function getFirstAVD(): string | null {
  const home = getAndroidHome();
  const emulatorBin = run('which emulator') || resolve(home, 'emulator/emulator');
  const avds = run(`"${emulatorBin}" -list-avds`);
  if (!avds) return null;
  return avds.split('\n').filter(Boolean)[0] || null;
}

async function bootAndroidEmulator({ headless = true }: { headless?: boolean } = {}): Promise<void> {
  const avd = getFirstAVD();
  if (!avd) throw new Error('No Android AVDs available. Create one first.');

  const home = getAndroidHome();
  const emulatorBin = run('which emulator') || resolve(home, 'emulator/emulator');

  const args = ['-avd', avd, '-no-audio'];
  if (headless) {
    args.push('-no-window', '-gpu', 'swiftshader_indirect');
    log.info(`Booting emulator (headless): ${avd}...`);
  } else {
    log.info(`Booting emulator: ${avd}...`);
  }

  spawn(emulatorBin, args, { stdio: 'ignore', detached: true }).unref();
  poolBootedEmulator = true;

  log.verbose('Waiting for emulator to boot...');
  try {
    execSync('adb wait-for-device', {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch {
    throw new Error('Timed out waiting for Android emulator to appear (60s)');
  }

  for (let i = 0; i < 60; i++) {
    const prop = run('adb shell getprop sys.boot_completed');
    if (prop === '1') {
      log.info('Emulator is ready');
      return;
    }
    await new Promise<void>(r => setTimeout(r, 2000));
  }
  throw new Error('Emulator did not finish booting in time');
}

function setupAndroidPorts(wsPort: number, metroPort: number): void {
  try {
    run(`adb reverse tcp:${wsPort} tcp:${wsPort}`);
    run(`adb reverse tcp:${metroPort} tcp:${metroPort}`);
    log.verbose('ADB port reverse set up');
  } catch (e: unknown) {
    log.error('ADB reverse failed:', errorMessage(e));
  }
}

function launchAndroidApp(bundleId: string, _metroPort: number): void {
  log.verbose(`Launching ${bundleId}...`);
  run(`adb shell am force-stop ${bundleId}`);
  run('sleep 1');
  // Use LAUNCHER category to let Android resolve the main activity —
  // the activity class name may differ from the applicationId.
  execSync(
    `adb shell monkey -p ${bundleId} -c android.intent.category.LAUNCHER 1`,
    { encoding: 'utf8', stdio: 'pipe' },
  );
  log.verbose('App launched');
}

function stopAndroidApp(bundleId: string): void {
  try {
    run(`adb shell am force-stop ${bundleId}`);
  } catch {
    /* ignore */
  }
}

function shutdownAndroidEmulator(): void {
  if (!poolBootedEmulator) return;
  log.verbose('Shutting down emulator...');
  try {
    run('adb emu kill');
  } catch {
    /* ignore */
  }
  poolBootedEmulator = false;
}

// ── iOS ──────────────────────────────────────────────────────────

export function getBootedSimulator(): string | null {
  const info = getBootedSimulatorInfo();
  return info?.udid ?? null;
}

export function getBootedSimulatorInfo(): SimulatorInfo | null {
  const json = run('xcrun simctl list devices booted -j');
  if (!json) return null;
  const devices = parseSimctlDevicesJson(json);
  if (!devices) return null;
  for (const [runtime, deviceList] of Object.entries(devices.devices)) {
    for (const device of deviceList) {
      if (device.state === 'Booted' && device.udid) {
        return {
          udid: device.udid,
          name: device.name ?? 'Unknown',
          runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, '.'),
        };
      }
    }
  }
  return null;
}

function getFirstAvailableSimulator(): string | null {
  const json = run('xcrun simctl list devices available -j');
  if (!json) return null;
  const devices = parseSimctlDevicesJson(json);
  if (!devices) return null;
  for (const runtime of Object.values(devices.devices)) {
    for (const device of runtime) {
      if (device.isAvailable && device.udid) return device.udid;
    }
  }
  return null;
}

async function bootIOSSimulator(deviceId?: string): Promise<string> {
  let simId = deviceId || getBootedSimulator();
  if (simId) return simId;

  simId = getFirstAvailableSimulator();
  if (!simId) throw new Error('No available iOS simulators found');

  log.info(`Booting iOS simulator ${simId}...`);
  run(`xcrun simctl boot ${simId}`);
  poolBootedEmulator = true;

  for (let i = 0; i < 30; i++) {
    if (getBootedSimulator()) {
      log.info('Simulator is ready');
      return simId;
    }
    await new Promise<void>(r => setTimeout(r, 2000));
  }
  throw new Error('iOS simulator did not boot in time');
}

/**
 * Pre-approve a URI scheme for the simulator so `simctl openurl` doesn't show
 * the "Open in <app>?" confirmation dialog.
 *
 * This is the same mechanism Expo CLI uses when pressing `i` in `expo start`.
 * It writes to the simulator's scheme approval plist directly.
 */
function approveSimulatorScheme(simId: string, scheme: string, bundleId: string): void {
  const plistPath = join(
    homedir(),
    'Library/Developer/CoreSimulator/Devices',
    simId,
    'data/Library/Preferences/com.apple.launchservices.schemeapproval.plist',
  );

  // The plist maps "CoreSimulatorBridge--><scheme>" -> "<bundleId>"
  // We write a minimal binary plist. For simplicity, use plutil to convert.
  const key = `com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`;
  try {
    // Read existing plist (if any) as JSON, add our entry, write back
    let plistData: Record<string, string> = {};
    if (existsSync(plistPath)) {
      const json = execSync(`plutil -convert json -o - "${plistPath}"`, { encoding: 'utf8', stdio: 'pipe' });
      plistData = JSON.parse(json);
    }
    plistData[key] = bundleId;

    // Write as XML plist then convert to binary
    const tmpPath = plistPath + '.tmp.json';
    writeFileSync(tmpPath, JSON.stringify(plistData));
    execSync(`plutil -convert binary1 "${tmpPath}" -o "${plistPath}"`, { stdio: 'pipe' });
    execSync(`rm -f "${tmpPath}"`, { stdio: 'pipe' });
    log.verbose(`Approved scheme "${scheme}" for ${bundleId} on simulator`);
  } catch (e: unknown) {
    log.verbose(`Could not update scheme approval (non-fatal): ${errorMessage(e)}`);
  }
}

function launchIOSApp(bundleId: string, metroPort: number, deviceId?: string): void {
  const simId = deviceId || getBootedSimulator();
  if (!simId) {
    log.error('No booted iOS simulator');
    return;
  }
  log.verbose(`Launching ${bundleId} on ${simId}...`);
  run(`xcrun simctl terminate ${simId} ${bundleId}`);

  // Set RCTBundleURLProvider defaults so the app finds Metro.
  // jsLocation is just the host — RCTBundleURLProvider adds the port separately.
  run(`xcrun simctl spawn ${simId} defaults write ${bundleId} RCT_jsLocation "127.0.0.1"`);
  if (metroPort !== 8081) {
    run(`xcrun simctl spawn ${simId} defaults write ${bundleId} RCT_packagerPort -string "${metroPort}"`);
  }

  try {
    execSync(
      `xcrun simctl launch ${simId} ${bundleId}`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    log.verbose('App launched');
  } catch (e: unknown) {
    log.error('Failed to launch iOS app:', errorMessage(e));
  }
}

function stopIOSApp(bundleId: string): void {
  const simId = getBootedSimulator();
  if (simId) {
    try {
      run(`xcrun simctl terminate ${simId} ${bundleId}`);
    } catch {
      /* ignore */
    }
  }
}

function shutdownIOSSimulator(): void {
  if (!poolBootedEmulator) return;
  log.verbose('Shutting down simulator...');
  try {
    run('xcrun simctl shutdown booted');
  } catch {
    /* ignore */
  }
  poolBootedEmulator = false;
}

// ── Public API ───────────────────────────────────────────────────

export async function ensureDevice(
  platform: Platform,
  { wsPort = 7878, metroPort = 8081, deviceId, headless = true }: DeviceOptions = {},
): Promise<void> {
  if (platform === 'android') {
    if (!isAndroidDeviceOnline()) {
      await bootAndroidEmulator({ headless });
    } else {
      log.verbose('Android device already running');
    }
    setupAndroidPorts(wsPort, metroPort);
  }
  if (platform === 'ios') {
    await bootIOSSimulator(deviceId);
  }
}

export function launchApp(
  platform: Platform,
  bundleId: string,
  { metroPort = 8081, deviceId }: { metroPort?: number; deviceId?: string } = {},
): void {
  if (platform === 'android') launchAndroidApp(bundleId, metroPort);
  else if (platform === 'ios') launchIOSApp(bundleId, metroPort, deviceId);
}

export function stopApp(platform: Platform, bundleId: string): void {
  if (platform === 'android') stopAndroidApp(bundleId);
  else if (platform === 'ios') stopIOSApp(bundleId);
}

export function shutdownDevice(platform: Platform): void {
  if (platform === 'android') shutdownAndroidEmulator();
  else if (platform === 'ios') shutdownIOSSimulator();
}

export function didPoolBootDevice(): boolean {
  return poolBootedEmulator;
}
