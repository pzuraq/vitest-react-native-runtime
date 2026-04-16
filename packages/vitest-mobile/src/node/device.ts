/**
 * Device lifecycle — boot emulators/simulators, wait for ready, setup ports.
 *
 * Device selection uses port-based liveness checks: for each candidate device,
 * we read the Metro port from its stored RCT_jsLocation (iOS) or check the
 * running process list (Android) to determine if another vitest-mobile instance
 * is actively using it. A global file lock (~/.cache/vitest-mobile/device.lock)
 * serializes the selection so two concurrent startups can't claim the same device.
 */

import { execSync, spawn, type ExecSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger';
import { run, getAndroidHome, getAdbPath } from './exec-utils';
import { getCacheDir } from './paths';
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

interface SimctlDeviceTypeEntry {
  name?: string;
  identifier?: string;
}

interface SimctlRuntimeEntry {
  identifier?: string;
  isAvailable?: boolean;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function promptConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${message} [y/N] `);
  return new Promise(resolvePrompt => {
    process.stdin.resume();
    process.stdin.once('data', data => {
      const answer = String(data).trim().toLowerCase();
      resolvePrompt(answer === 'y' || answer === 'yes');
    });
  });
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

let poolBootedEmulator = false;
let _poolBootedAndroidSerial: string | null = null;

// Resolve adb once and reuse — bare 'adb' isn't on PATH on all CI runners.
let _adb: string | undefined;
function adb(): string {
  if (!_adb) _adb = getAdbPath();
  return _adb;
}

// ── Liveness detection ──────────────────────────────────────────

const DEFAULT_BUNDLE_ID = 'com.vitest.mobile.harness';

/** Check if something is listening on a TCP port (connect-based, not bind-based). */
export function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = netConnect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Read the Metro port that was last written to a simulator's NSUserDefaults
 * via `defaults write <bundleId> RCT_jsLocation "host:port"`.
 */
function getSimulatorMetroPort(udid: string, bundleId: string): number | null {
  try {
    const loc = run(`xcrun simctl spawn ${udid} defaults read ${bundleId} RCT_jsLocation`);
    if (!loc) return null;
    const match = loc.match(/:(\d+)$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * A simulator is "actively in use" if it has an RCT_jsLocation pointing to a
 * Metro port that is currently listening. This self-heals: if the Metro server
 * died (crash, Ctrl-C), the port goes free and the sim becomes available again.
 */
async function isSimulatorActivelyInUse(udid: string, bundleId: string): Promise<boolean> {
  const port = getSimulatorMetroPort(udid, bundleId);
  if (!port) return false;
  return isPortListening(port);
}

/**
 * Read the Metro port from an Android device's SharedPreferences
 * (debug_http_host in <bundleId>_preferences.xml) — the Android equivalent
 * of reading RCT_jsLocation on iOS.
 */
function getAndroidMetroPort(serial: string, bundleId: string): number | null {
  try {
    const xml = run(`${adb()} -s ${serial} shell "run-as ${bundleId} cat shared_prefs/${bundleId}_preferences.xml"`);
    if (!xml) return null;
    const match = xml.match(/debug_http_host[^>]*>([^<]+)/);
    if (!match) return null;
    const portMatch = match[1].match(/:(\d+)$/);
    return portMatch ? Number(portMatch[1]) : null;
  } catch {
    return null;
  }
}

// ── Android device claims ──────────────────────────────────────
//
// File-based claims written inside the device lock so the next instance
// can see which devices are taken.  Each claim stores the Metro port so
// liveness can be verified the same way iOS does — if Metro dies (crash,
// Ctrl-C), the port goes free and the device becomes available again.

function androidClaimPath(serial: string): string {
  return resolve(getCacheDir(), `android-device-${serial}.json`);
}

function claimAndroidDevice(serial: string, instanceId: string, metroPort: number): void {
  mkdirSync(getCacheDir(), { recursive: true });
  writeFileSync(androidClaimPath(serial), JSON.stringify({ pid: process.pid, instanceId, metroPort, ts: Date.now() }));
}

/**
 * An Android device is "actively in use" if another worker has claimed it
 * AND that claim's Metro port is still listening.  Self-heals: if Metro
 * died (crash, Ctrl-C, test run finished), the port goes free and the
 * device becomes available — same pattern as iOS's RCT_jsLocation check.
 */
async function isAndroidDeviceActivelyInUse(
  serial: string,
  bundleId: string,
  currentInstanceId?: string,
): Promise<boolean> {
  // 1. Check file-based claim (written inside the device lock)
  let claimData: { instanceId?: string; metroPort?: number; pid?: number } | null = null;
  try {
    claimData = JSON.parse(readFileSync(androidClaimPath(serial), 'utf8'));
    if (currentInstanceId && claimData!.instanceId === currentInstanceId) {
      return false;
    }

    const claimPidAlive = claimData!.pid ? isPidAlive(claimData!.pid) : false;
    const metroListening = claimData!.metroPort ? await isPortListening(claimData!.metroPort) : false;

    if (metroListening) return true;
    if (claimPidAlive) return true;

    // Claim owner is dead and Metro is gone — device is free.
    // The app may still be running on-device but no vitest-mobile controls it.
    return false;
  } catch {
    /* no claim file or unreadable — not claimed */
  }

  // 2. Check SharedPreferences for a live Metro port (survives across runs)
  const port = getAndroidMetroPort(serial, bundleId);
  if (port && (await isPortListening(port))) return true;

  // 3. Fallback: app process still running (only when no claim file exists)
  try {
    const pid = run(`${adb()} -s ${serial} shell pidof ${bundleId}`);
    return !!pid && pid.trim() !== '';
  } catch {
    return false;
  }
}

// ── Global device lock ──────────────────────────────────────────
//
// Serializes device selection across all vitest-mobile instances on
// this machine so two concurrent startups can't claim the same device.

const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 300;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withDeviceLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = getCacheDir();
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'device.lock');
  const lockContent = `${process.pid}:${Date.now()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      writeFileSync(lockPath, lockContent, { flag: 'wx' });
      break;
    } catch {
      // Check if the holder is still alive
      try {
        const held = readFileSync(lockPath, 'utf8').trim();
        const pid = Number(held.split(':')[0]);
        const ts = Number(held.split(':')[1]);
        if (!isPidAlive(pid) || Date.now() - ts > LOCK_TIMEOUT_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* ignore */
          }
          continue;
        }
      } catch {
        /* ignore */
      }
      await new Promise<void>(r => setTimeout(r, LOCK_POLL_MS));
    }
  }

  if (!existsSync(lockPath) || readFileSync(lockPath, 'utf8').trim() !== lockContent) {
    log.warn('Could not acquire device lock within timeout; proceeding anyway');
    try {
      writeFileSync(lockPath, lockContent);
    } catch {
      /* ignore */
    }
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

// ── Android ──────────────────────────────────────────────────────

export function isAndroidDeviceOnline(): boolean {
  return getAndroidOnlineSerials().length > 0;
}

function getAndroidOnlineSerials(): string[] {
  const output = run(`${adb()} devices`);
  if (!output) return [];
  const lines = output.split('\n').slice(1);
  return lines
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => l.endsWith('\tdevice'))
    .map(l => l.split('\t')[0] ?? '')
    .filter(Boolean);
}

/** Env with ANDROID_AVD_HOME set so all Android tools find our AVDs. */
function androidEnv(): Record<string, string | undefined> {
  return { ...process.env, ANDROID_AVD_HOME: avdHome() };
}

function getAllAVDs(): string[] {
  const home = getAndroidHome();
  const emulatorBin = run('which emulator') || resolve(home, 'emulator/emulator');
  try {
    const avds = (
      execSync(`"${emulatorBin}" -list-avds`, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
        env: androidEnv(),
      }) as string
    ).trim();
    if (avds) return avds.split('\n').filter(Boolean);
  } catch {
    // emulator binary may not exist or may timeout
  }

  // Fallback: read the AVD directory directly
  const avdDir = avdHome();
  if (!existsSync(avdDir)) return [];
  try {
    const entries = execSync(`ls "${avdDir}"`, { encoding: 'utf8', stdio: 'pipe' }).trim();
    return entries
      .split('\n')
      .filter(e => e.endsWith('.ini') && !e.includes('.avd'))
      .map(e => e.replace(/\.ini$/, ''));
  } catch {
    return [];
  }
}

function getFirstAVD(): string | null {
  return getAllAVDs()[0] || null;
}

/**
 * Detect which AVD name a running emulator is using by reading its
 * `avd.ini.path` property or the `hw.avd.name` kernel parameter.
 */
function getRunningEmulatorAVD(serial: string): string | null {
  try {
    const name = run(`${adb()} -s ${serial} emu avd name 2>/dev/null`);
    if (name) {
      const first = name.split('\n')[0]?.trim();
      if (first && first !== 'KO:') return first;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Pick an even console port (5554, 5556, …) that isn't already taken by
 * a running emulator.  The serial will be `emulator-<port>`.
 */
function pickEmulatorConsolePort(excludeSerials: string[]): number {
  const takenPorts = new Set(
    excludeSerials
      .map(s => s.match(/^emulator-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  for (let port = 5554; port <= 5680; port += 2) {
    if (!takenPorts.has(port)) return port;
  }
  return 5554;
}

// ── Android auto-provisioning ────────────────────────────────────
//
// When --api-level is specified (or we're running headless with no AVDs),
// automatically install the system image and create an AVD — the same
// things ReactiveCircus/android-emulator-runner does.

const DEFAULT_API_LEVEL = 35;
const DEFAULT_ARCH = 'x86_64';
const DEFAULT_TARGET = 'default';
const AUTO_AVD_NAME = 'vitest-mobile';

function findBin(name: string, subdirs: string[]): string {
  const home = getAndroidHome();
  for (const sub of subdirs) {
    const candidate = resolve(home, sub, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function sdkManagerBin(): string {
  return findBin('sdkmanager', ['cmdline-tools/latest/bin', 'tools/bin']);
}

function avdManagerBin(): string {
  return findBin('avdmanager', ['cmdline-tools/latest/bin', 'tools/bin']);
}

function runLong(cmd: string, opts: ExecSyncOptions = {}): string {
  log.verbose(`$ ${cmd}`);
  const result = (
    execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
      ...opts,
    }) as string
  ).trim();
  return result;
}

function systemImagePackage(apiLevel: number, target = DEFAULT_TARGET, arch = DEFAULT_ARCH): string {
  return `system-images;android-${apiLevel};${target};${arch}`;
}

function isSystemImageInstalled(apiLevel: number, target = DEFAULT_TARGET, arch = DEFAULT_ARCH): boolean {
  const home = getAndroidHome();
  const imagePath = resolve(home, 'system-images', `android-${apiLevel}`, target, arch);
  return existsSync(imagePath);
}

function installSystemImage(apiLevel: number, target = DEFAULT_TARGET, arch = DEFAULT_ARCH): void {
  const pkg = systemImagePackage(apiLevel, target, arch);
  log.info(`Installing Android system image: ${pkg}`);
  const start = Date.now();

  try {
    runLong(`yes | ${sdkManagerBin()} --licenses`, { timeout: 60_000 });
  } catch {
    // Non-fatal — licenses may already be accepted
  }

  runLong(`${sdkManagerBin()} --install '${pkg}'`);
  log.info(`  System image installed (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

/**
 * Resolve the directory where AVDs are stored. Defaults to our own
 * cache dir so everything vitest-mobile manages lives under one root
 * (~/.cache/vitest-mobile/avd on Linux/macOS). Respects ANDROID_AVD_HOME
 * if explicitly set by the user.
 */
function avdHome(): string {
  if (process.env.ANDROID_AVD_HOME) return process.env.ANDROID_AVD_HOME;
  return resolve(getCacheDir(), 'avd');
}

function ensureAvd(apiLevel: number, target = DEFAULT_TARGET, arch = DEFAULT_ARCH): string {
  const existing = getAllAVDs();
  if (existing.includes(AUTO_AVD_NAME)) return AUTO_AVD_NAME;

  const pkg = systemImagePackage(apiLevel, target, arch);
  const avdBin = avdManagerBin();
  const avdDir = avdHome();

  log.info(`Creating AVD: ${AUTO_AVD_NAME} (API ${apiLevel}, ${arch})`);
  log.info(`  avdmanager: ${avdBin}`);
  log.info(`  AVD home: ${avdDir}`);

  // Ensure the AVD directory exists — avdmanager can silently fail
  // if ~/.android/avd doesn't exist on a fresh CI runner.
  mkdirSync(avdDir, { recursive: true });

  try {
    const output = runLong(`echo no | ${avdBin} create avd --force -n ${AUTO_AVD_NAME} --package '${pkg}'`, {
      env: androidEnv(),
    });
    if (output) log.verbose(`avdmanager: ${output}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to create AVD:\n${msg}`);
  }

  const avdIni = resolve(avdDir, `${AUTO_AVD_NAME}.ini`);
  if (!existsSync(avdIni)) {
    let contents = '(directory does not exist)';
    if (existsSync(avdDir)) {
      try {
        contents = execSync(`ls -la "${avdDir}"`, { encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch {
        contents = '(could not list)';
      }
    }
    throw new Error(
      `avdmanager reported success but AVD was not created.\n` +
        `  Expected: ${avdIni}\n` +
        `  AVD home (${avdDir}) contents:\n${contents}`,
    );
  }

  log.info(`  AVD created at ${avdDir}`);
  return AUTO_AVD_NAME;
}

function disableAndroidAnimations(serial: string): void {
  const target = `-s ${serial}`;
  try {
    run(`${adb()} ${target} shell settings put global window_animation_scale 0.0`);
    run(`${adb()} ${target} shell settings put global transition_animation_scale 0.0`);
    run(`${adb()} ${target} shell settings put global animator_duration_scale 0.0`);
    log.verbose('Disabled animations');
  } catch {
    log.verbose('Could not disable animations (non-fatal)');
  }
}

/**
 * Ensure an Android system image + AVD exist, installing if needed.
 * Called before bootAndroidEmulator when apiLevel is specified or
 * no AVDs exist on a headless (CI) runner.
 */
function ensureAndroidEmulatorReady(apiLevel: number): string {
  if (!isSystemImageInstalled(apiLevel)) {
    installSystemImage(apiLevel);
  } else {
    log.verbose(`System image already installed for API ${apiLevel}`);
  }
  return ensureAvd(apiLevel);
}

function snapshotMarkerPath(avdName: string): string {
  return resolve(avdHome(), `${avdName}.avd`, '.vitest-snapshot-ready');
}

/**
 * Check if the AVD has a warm-up snapshot we created. Uses a marker file
 * rather than `emulator -snapshot-list` which can leave orphan QEMU processes.
 */
function hasAvdSnapshot(avdName: string): boolean {
  return existsSync(snapshotMarkerPath(avdName));
}

/**
 * Spawn the emulator and wait for it to finish booting.
 * Returns the ChildProcess and the serial. Throws on timeout or crash.
 */
async function spawnAndWaitForBoot(
  emulatorBin: string,
  args: string[],
  expectedSerial: string,
  timeoutIterations = 90,
): Promise<import('node:child_process').ChildProcess> {
  if (!existsSync(emulatorBin)) {
    throw new Error(`Emulator binary not found: ${emulatorBin}`);
  }

  // Ensure adb server is running before launching the emulator so it
  // can detect the emulator's console port as soon as it's up.
  run(`${adb()} start-server`);

  let emulatorOutput = '';
  let spawnError: Error | null = null;
  const emuProc = spawn(emulatorBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: androidEnv(),
  });
  emuProc.on('error', (err: Error) => {
    spawnError = err;
  });
  emuProc.stdout?.on('data', (chunk: Buffer) => {
    emulatorOutput += chunk.toString();
  });
  emuProc.stderr?.on('data', (chunk: Buffer) => {
    emulatorOutput += chunk.toString();
  });
  emuProc.unref();
  (emuProc.stdout as NodeJS.ReadableStream & { unref?: () => void })?.unref?.();
  (emuProc.stderr as NodeJS.ReadableStream & { unref?: () => void })?.unref?.();

  log.verbose(`Waiting for ${expectedSerial} to boot (timeout: ${timeoutIterations * 2}s)...`);

  for (let i = 0; i < timeoutIterations; i++) {
    const online = getAndroidOnlineSerials();

    if (online.includes(expectedSerial)) {
      try {
        const prop = run(`${adb()} -s ${expectedSerial} shell getprop sys.boot_completed`);
        if (prop === '1') return emuProc;
      } catch {
        /* device not ready yet */
      }
    }

    if (spawnError) {
      throw new Error(`Failed to spawn emulator: ${(spawnError as Error).message}`);
    }
    if (emuProc.exitCode !== null) {
      throw new Error(
        `Emulator process exited with code ${emuProc.exitCode} before ${expectedSerial} came online.\n${emulatorOutput.slice(-500)}`,
      );
    }

    await new Promise<void>(r => setTimeout(r, 2000));
  }
  try {
    emuProc.kill();
  } catch {
    /* ignore */
  }
  throw new Error(`Emulator ${expectedSerial} did not finish booting in time.\n${emulatorOutput.slice(-1000)}`);
}

/** Cleanly shut down an emulator via adb so it saves its snapshot. */
async function killEmulatorCleanly(serial: string): Promise<void> {
  run(`${adb()} -s ${serial} emu kill`);
  // Wait for the process to exit and snapshot to flush
  for (let i = 0; i < 15; i++) {
    const online = getAndroidOnlineSerials();
    if (!online.includes(serial)) return;
    await new Promise<void>(r => setTimeout(r, 1000));
  }
}

async function bootAndroidEmulator({
  headless = true,
  bundleId = DEFAULT_BUNDLE_ID,
  promptForNewDevice = true,
  excludeSerials = [],
  apiLevel,
}: {
  headless?: boolean;
  bundleId?: string;
  promptForNewDevice?: boolean;
  excludeSerials?: string[];
  apiLevel?: number;
} = {}): Promise<string> {
  let allAvds = getAllAVDs();

  // Auto-provision if an API level was explicitly requested, or if we're
  // headless (CI) and have no AVDs at all.
  if (apiLevel || (headless && allAvds.length === 0)) {
    ensureAndroidEmulatorReady(apiLevel ?? DEFAULT_API_LEVEL);
    allAvds = getAllAVDs();
  }

  if (allAvds.length === 0) {
    if (promptForNewDevice) {
      await promptConfirm(
        'No Android AVDs are available. Create an AVD in Android Studio, then rerun. Continue without creating now?',
      );
    }
    throw new Error('No Android AVDs available. Create one first.');
  }

  // Determine which AVDs are already running so we prefer a different one.
  const runningAvdNames = new Set<string>();
  for (const serial of excludeSerials) {
    const name = getRunningEmulatorAVD(serial);
    if (name) runningAvdNames.add(name);
  }

  // Pick an AVD that isn't currently running; fall back to the first if all are taken.
  const preferredAvd = allAvds.find(a => !runningAvdNames.has(a)) ?? allAvds[0]!;

  const home = getAndroidHome();
  let emulatorBin = run('which emulator') || resolve(home, 'emulator/emulator');

  if (!existsSync(emulatorBin)) {
    log.info('Emulator binary not found, installing via sdkmanager...');
    runLong(`${sdkManagerBin()} --install emulator`);
    emulatorBin = resolve(home, 'emulator/emulator');
  }

  const consolePort = pickEmulatorConsolePort(excludeSerials);
  const expectedSerial = `emulator-${consolePort}`;

  const needsReadOnly = runningAvdNames.has(preferredAvd);
  const baseArgs = ['-avd', preferredAvd, '-no-audio', '-port', String(consolePort)];
  if (needsReadOnly) baseArgs.push('-read-only');

  if (headless) {
    baseArgs.push('-no-window', '-gpu', 'swiftshader_indirect', '-no-boot-anim');

    const snapshot = hasAvdSnapshot(preferredAvd);

    if (!snapshot) {
      // ── First boot: cold boot → save snapshot → reboot read-only ──
      log.info(`No snapshot found for ${preferredAvd} — performing warm-up boot...`);
      const warmupArgs = [...baseArgs, '-no-snapshot-load'];
      await spawnAndWaitForBoot(emulatorBin, warmupArgs, expectedSerial, 150); // 5 min timeout for cold boot
      log.info('Warm-up boot complete, saving snapshot...');
      await killEmulatorCleanly(expectedSerial);
      writeFileSync(snapshotMarkerPath(preferredAvd), new Date().toISOString());
      log.info('Snapshot saved. Rebooting from snapshot...');
    } else {
      log.info(`Snapshot found for ${preferredAvd} — fast boot.`);
    }

    // ── Production boot: load snapshot, never save back (read-only) ──
    const prodArgs = [...baseArgs, '-no-snapshot-save'];
    log.info(`Booting emulator (headless): ${preferredAvd} on port ${consolePort}...`);
    await spawnAndWaitForBoot(emulatorBin, prodArgs, expectedSerial, 150);
  } else {
    log.info(`Booting emulator: ${preferredAvd} on port ${consolePort}...`);
    await spawnAndWaitForBoot(emulatorBin, baseArgs, expectedSerial);
  }

  log.info(`Emulator is ready (${expectedSerial})`);
  if (headless) disableAndroidAnimations(expectedSerial);
  poolBootedEmulator = true;
  _poolBootedAndroidSerial = expectedSerial;
  return expectedSerial;
}

function setupAndroidPorts(wsPort: number, metroPort: number, deviceSerial?: string): void {
  const target = deviceSerial ? `-s ${deviceSerial} ` : '';
  try {
    run(`${adb()} ${target}reverse tcp:${wsPort} tcp:${wsPort}`);
    run(`${adb()} ${target}reverse tcp:${metroPort} tcp:${metroPort}`);
    log.verbose('ADB port reverse set up');
  } catch (e: unknown) {
    log.error('ADB reverse failed:', errorMessage(e));
  }
}

/**
 * Write debug_http_host to SharedPreferences so React Native connects to the
 * correct Metro instance — the Android equivalent of setting RCT_jsLocation
 * via NSUserDefaults on iOS.  Called from ensureDevice (inside the device lock)
 * to mark the device as claimed, and again from launchAndroidApp to ensure the
 * value is current before each launch.
 */
function writeAndroidDebugHost(bundleId: string, metroPort: number, deviceSerial?: string): void {
  const target = deviceSerial ? `-s ${deviceSerial} ` : '';
  try {
    const prefsXml = [
      '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
      '<map>',
      `    <string name="debug_http_host">localhost:${metroPort}</string>`,
      '</map>',
    ].join('\n');
    execSync(
      `${adb()} ${target}shell "run-as ${bundleId} sh -c 'mkdir -p shared_prefs && cat > shared_prefs/${bundleId}_preferences.xml'"`,
      { input: prefsXml, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    log.verbose(`Set debug_http_host to localhost:${metroPort}`);
  } catch (e: unknown) {
    log.verbose(`Could not write debug_http_host (non-fatal): ${errorMessage(e)}`);
  }
}

function launchAndroidApp(bundleId: string, metroPort: number, deviceSerial?: string): void {
  const target = deviceSerial ? `-s ${deviceSerial} ` : '';
  log.verbose(`Launching ${bundleId}...`);
  run(`${adb()} ${target}shell am force-stop ${bundleId}`);
  run('sleep 1');

  writeAndroidDebugHost(bundleId, metroPort, deviceSerial);

  execSync(`${adb()} ${target}shell monkey -p ${bundleId} -c android.intent.category.LAUNCHER 1`, {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  log.verbose('App launched');
}

function stopAndroidApp(bundleId: string, deviceSerial?: string): void {
  const target = deviceSerial ? `-s ${deviceSerial} ` : '';
  try {
    run(`${adb()} ${target}shell am force-stop ${bundleId}`);
  } catch {
    /* ignore */
  }
}

function shutdownAndroidEmulator(): void {
  if (!poolBootedEmulator) return;
  log.verbose('Shutting down emulator...');
  try {
    if (_poolBootedAndroidSerial) {
      run(`${adb()} -s ${_poolBootedAndroidSerial} emu kill`);
    } else {
      run(`${adb()} emu kill`);
    }
  } catch {
    /* ignore */
  }
  poolBootedEmulator = false;
  _poolBootedAndroidSerial = null;
}

// ── iOS ──────────────────────────────────────────────────────────

export function getBootedSimulator(): string | null {
  const info = getBootedSimulatorInfo();
  return info?.udid ?? null;
}

function getBootedSimulators(excludeIds: string[] = []): SimulatorInfo[] {
  const json = run('xcrun simctl list devices booted -j');
  if (!json) return [];
  const devices = parseSimctlDevicesJson(json);
  if (!devices) return [];
  const sims: SimulatorInfo[] = [];
  for (const [runtime, deviceList] of Object.entries(devices.devices)) {
    for (const device of deviceList) {
      if (device.state !== 'Booted' || !device.udid) continue;
      if (excludeIds.includes(device.udid)) continue;
      sims.push({
        udid: device.udid,
        name: device.name ?? 'Unknown',
        runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, '.'),
      });
    }
  }
  return sims;
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

function getFirstAvailableSimulator(excludeIds: string[] = []): string | null {
  const json = run('xcrun simctl list devices available -j');
  if (!json) return null;
  const devices = parseSimctlDevicesJson(json);
  if (!devices) return null;
  for (const runtime of Object.values(devices.devices)) {
    for (const device of runtime) {
      if (device.isAvailable && device.udid && !excludeIds.includes(device.udid)) return device.udid;
    }
  }
  return null;
}

function chooseIOSDeviceTypeIdentifier(): string | null {
  const json = run('xcrun simctl list devicetypes -j');
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { devicetypes?: SimctlDeviceTypeEntry[] };
    const list = parsed.devicetypes ?? [];
    const iphone = list.find(d => d.identifier?.includes('iPhone'));
    return iphone?.identifier ?? null;
  } catch {
    return null;
  }
}

function chooseIOSRuntimeIdentifier(): string | null {
  const json = run('xcrun simctl list runtimes -j');
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { runtimes?: SimctlRuntimeEntry[] };
    const list = (parsed.runtimes ?? []).filter(r => r.isAvailable && r.identifier?.includes('iOS'));
    return list[0]?.identifier ?? null;
  } catch {
    return null;
  }
}

function listIOSSimulatorsByPrefix(prefix: string): string[] {
  const json = run('xcrun simctl list devices -j');
  if (!json) return [];
  const devices = parseSimctlDevicesJson(json);
  if (!devices) return [];
  const ids: string[] = [];
  for (const runtime of Object.values(devices.devices)) {
    for (const device of runtime) {
      if (!device.udid || !device.name) continue;
      if (device.name.startsWith(prefix)) ids.push(device.udid);
    }
  }
  return ids;
}

function createIOSSimulator(instanceId?: string): string {
  const deviceType = chooseIOSDeviceTypeIdentifier();
  const runtime = chooseIOSRuntimeIdentifier();
  if (!deviceType || !runtime) {
    throw new Error('Unable to find a compatible iOS device type/runtime for simulator creation.');
  }

  const nameSuffix = (instanceId ?? Date.now().toString(36)).slice(-6);
  const name = `VitestMobile-${nameSuffix}`;
  log.info(`Creating iOS simulator: ${name} (${deviceType}, ${runtime})`);
  const created = run(`xcrun simctl create "${name}" "${deviceType}" "${runtime}"`);
  if (!created) {
    throw new Error('Failed to create a new iOS simulator definition.');
  }
  return created.trim();
}

async function maybeCreatePersistentIOSSimulator(instanceId?: string): Promise<string | null> {
  const confirmed = await promptConfirm(
    'No reusable iOS simulator is available. Create a new persistent simulator definition?',
  );
  if (!confirmed) return null;
  return createIOSSimulator(instanceId);
}

async function bootIOSSimulator(opts: {
  deviceId?: string;
  bundleId?: string;
  headless?: boolean;
  promptForNewDevice?: boolean;
  instanceId?: string;
}): Promise<string> {
  if (opts.deviceId) return opts.deviceId;
  const bid = opts.bundleId ?? DEFAULT_BUNDLE_ID;

  // Prefer a booted simulator that isn't actively serving another instance
  const booted = getBootedSimulators();
  for (const sim of booted) {
    if (!(await isSimulatorActivelyInUse(sim.udid, bid))) {
      log.verbose(`Reusing free simulator: ${sim.name} (${sim.udid})`);
      if (!opts.headless) openSimulatorApp();
      return sim.udid;
    }
  }

  // All booted sims are in use — find an unbooted available one
  const bootedUdids = booted.map(s => s.udid);
  let simId = getFirstAvailableSimulator(bootedUdids) ?? undefined;
  if (!simId) {
    if (opts.promptForNewDevice === false) {
      throw new Error('No available iOS simulators found and creating a new one is disabled.');
    }
    if (opts.headless) {
      simId = createIOSSimulator(opts.instanceId);
    } else {
      simId = (await maybeCreatePersistentIOSSimulator(opts.instanceId)) ?? undefined;
    }
  }
  if (!simId) {
    throw new Error('No available iOS simulators found and simulator creation was declined.');
  }

  log.info(`Booting iOS simulator ${simId}...`);
  run(`xcrun simctl boot ${simId}`);
  poolBootedEmulator = true;
  _poolBootedSimUdid = simId;

  for (let i = 0; i < 30; i++) {
    const bootedNow = getBootedSimulators();
    if (bootedNow.some(s => s.udid === simId)) {
      log.info('Simulator is ready');
      if (!opts.headless) {
        openSimulatorApp();
      }
      return simId;
    }
    await new Promise<void>(r => setTimeout(r, 2000));
  }
  throw new Error('iOS simulator did not boot in time');
}

/** Open and focus Simulator.app so the device window is visible. */
function openSimulatorApp(): void {
  try {
    execSync('open -a Simulator', { stdio: 'pipe' });
  } catch {
    /* non-fatal — the app may already be open */
  }
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

  // RCTBundleURLProvider reads RCT_jsLocation from NSUserDefaults and uses it
  // as the host:port for the bundle URL. If the value doesn't contain a colon,
  // RN appends the default port 8081. We always include the port so non-default
  // Metro ports work correctly.
  run(`xcrun simctl spawn ${simId} defaults write ${bundleId} RCT_jsLocation "127.0.0.1:${metroPort}"`);

  try {
    execSync(`xcrun simctl launch ${simId} ${bundleId}`, { encoding: 'utf8', stdio: 'pipe' });
    log.verbose('App launched');
  } catch (e: unknown) {
    log.error('Failed to launch iOS app:', errorMessage(e));
  }
}

function stopIOSApp(bundleId: string, deviceId?: string): void {
  const simId = deviceId || getBootedSimulator();
  if (simId) {
    try {
      run(`xcrun simctl terminate ${simId} ${bundleId}`);
    } catch {
      /* ignore */
    }
  }
}

/** UDID of the simulator this pool instance booted (if any). */
let _poolBootedSimUdid: string | null = null;

function shutdownIOSSimulator(): void {
  if (!poolBootedEmulator) return;
  log.verbose('Shutting down simulator...');
  try {
    if (_poolBootedSimUdid) {
      run(`xcrun simctl shutdown ${_poolBootedSimUdid}`);
    }
  } catch {
    /* ignore */
  }
  poolBootedEmulator = false;
  _poolBootedSimUdid = null;
}

// ── Device Snapshots (iOS) ───────────────────────────────────────
//
// Save and restore the simulator's data directory so the app is
// pre-installed on cache hit, eliminating the `simctl install` step.
// Snapshots are keyed to the harness build cache key — when the
// binary changes the snapshot is automatically stale.

function simulatorDeviceDir(udid: string): string {
  return join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid);
}

function deviceSnapshotDir(cacheKey: string): string {
  return resolve(getCacheDir(), 'device-snapshots', cacheKey);
}

/**
 * Save the device's data directory after a successful install.
 * The snapshot is keyed to `cacheKey` so it auto-invalidates when the
 * harness binary changes. Only meaningful on iOS for now.
 */
export async function saveDeviceSnapshot(
  platform: Platform,
  cacheKey: string,
  deviceId?: string,
): Promise<string | null> {
  if (platform !== 'ios') return null;

  const udid = deviceId ?? getBootedSimulator();
  if (!udid) {
    log.warn('No booted iOS simulator — skipping snapshot save');
    return null;
  }

  const snapDir = deviceSnapshotDir(cacheKey);
  mkdirSync(snapDir, { recursive: true });

  log.info(`Saving device snapshot (${cacheKey.slice(0, 12)}...)...`);

  // Shut down so the data directory is consistent
  const wasBooted = getBootedSimulators().some(s => s.udid === udid);
  if (wasBooted) {
    run(`xcrun simctl shutdown ${udid}`);
    for (let i = 0; i < 15; i++) {
      if (!getBootedSimulators().some(s => s.udid === udid)) break;
      await new Promise<void>(r => setTimeout(r, 1000));
    }
  }

  const dataDir = join(simulatorDeviceDir(udid), 'data');
  const snapshotFile = join(snapDir, 'snapshot.tar');

  if (!existsSync(dataDir)) {
    log.warn(`Simulator data directory not found: ${dataDir}`);
    return null;
  }

  execSync(`tar cf "${snapshotFile}" -C "${dataDir}" .`, {
    stdio: 'pipe',
    timeout: 120_000,
  });

  const runtimeInfo = chooseIOSRuntimeIdentifier();
  writeFileSync(
    join(snapDir, 'metadata.json'),
    JSON.stringify({ udid, runtime: runtimeInfo, savedAt: new Date().toISOString() }),
  );

  // Reboot so the caller has a running device
  if (wasBooted) {
    run(`xcrun simctl boot ${udid}`);
    for (let i = 0; i < 30; i++) {
      if (getBootedSimulators().some(s => s.udid === udid)) break;
      await new Promise<void>(r => setTimeout(r, 2000));
    }
  }

  // Clean up snapshots for any *other* cache keys (stale builds)
  cleanStaleSnapshots(cacheKey);

  log.info('Device snapshot saved');
  return snapshotFile;
}

/**
 * Restore a device from a cached snapshot keyed to `cacheKey`.
 * Creates a new simulator, injects the cached data, and boots it.
 * Returns the device UDID or null if no matching snapshot exists.
 */
export async function restoreDeviceSnapshot(
  platform: Platform,
  cacheKey: string,
  opts: { headless?: boolean } = {},
): Promise<string | null> {
  if (platform !== 'ios') return null;

  const snapDir = deviceSnapshotDir(cacheKey);
  const snapshotFile = join(snapDir, 'snapshot.tar');
  const metadataFile = join(snapDir, 'metadata.json');

  if (!existsSync(snapshotFile) || !existsSync(metadataFile)) {
    log.verbose('No device snapshot for this cache key');
    return null;
  }

  log.info(`Restoring device from snapshot (${cacheKey.slice(0, 12)}...)...`);

  // Validate runtime hasn't changed since the snapshot was saved
  const runtime = chooseIOSRuntimeIdentifier();
  let metadata: { runtime?: string };
  try {
    metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
  } catch {
    log.warn('Corrupt snapshot metadata — discarding');
    rmSync(snapDir, { recursive: true, force: true });
    return null;
  }

  if (runtime && metadata.runtime && metadata.runtime !== runtime) {
    log.warn(`Runtime changed (${metadata.runtime} → ${runtime}) — discarding snapshot`);
    rmSync(snapDir, { recursive: true, force: true });
    return null;
  }

  // Prefer an existing available (unbooted) simulator to avoid slow `simctl create`
  // on CI runners where creating new devices can time out.
  let udid = getFirstAvailableSimulator(getBootedSimulators().map(s => s.udid));
  let createdNewSim = false;

  if (udid) {
    log.verbose(`Reusing existing simulator ${udid} for snapshot restore`);
    run(`xcrun simctl shutdown ${udid}`);
  } else {
    const deviceType = chooseIOSDeviceTypeIdentifier();
    if (!deviceType || !runtime) {
      log.warn('Could not find compatible device type/runtime for snapshot restore');
      return null;
    }
    log.verbose(`Creating snapshot simulator: deviceType=${deviceType} runtime=${runtime}`);
    try {
      udid =
        execSync(`xcrun simctl create "VitestMobile-snapshot" "${deviceType}" "${runtime}"`, {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 60_000,
        })?.trim() ?? null;
    } catch (e: unknown) {
      log.warn(`Failed to create simulator for snapshot restore: ${errorMessage(e)}`);
      return null;
    }
    if (!udid) {
      log.warn('simctl create returned empty UDID');
      return null;
    }
    createdNewSim = true;
  }

  const dataDir = join(simulatorDeviceDir(udid), 'data');
  try {
    execSync(`tar xf "${snapshotFile}" -C "${dataDir}"`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (e: unknown) {
    log.warn(`Failed to restore snapshot data: ${errorMessage(e)}`);
    if (createdNewSim) {
      try {
        run(`xcrun simctl delete ${udid}`);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  log.info(`Booting simulator from snapshot (${udid})...`);
  run(`xcrun simctl boot ${udid}`);
  poolBootedEmulator = true;
  _poolBootedSimUdid = udid;

  for (let i = 0; i < 30; i++) {
    if (getBootedSimulators().some(s => s.udid === udid)) {
      if (!opts.headless) openSimulatorApp();
      log.info('Simulator restored from snapshot (app pre-installed)');
      return udid;
    }
    await new Promise<void>(r => setTimeout(r, 2000));
  }

  log.warn('Snapshot-restored simulator did not boot in time');
  if (createdNewSim) {
    try {
      run(`xcrun simctl delete ${udid}`);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Check if a device snapshot exists for a given cache key.
 */
export function hasDeviceSnapshot(platform: Platform, cacheKey: string): boolean {
  if (platform !== 'ios') return false;
  const snapDir = deviceSnapshotDir(cacheKey);
  return existsSync(join(snapDir, 'snapshot.tar')) && existsSync(join(snapDir, 'metadata.json'));
}

function cleanStaleSnapshots(currentKey: string): void {
  const parentDir = resolve(getCacheDir(), 'device-snapshots');
  if (!existsSync(parentDir)) return;
  try {
    const entries = execSync(`ls "${parentDir}"`, { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
    for (const entry of entries) {
      if (entry && entry !== currentKey) {
        rmSync(resolve(parentDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    /* best-effort cleanup */
  }
}

// ── Public API ───────────────────────────────────────────────────

export async function ensureDevice(
  platform: Platform,
  {
    wsPort = 7878,
    metroPort = 18081,
    deviceId,
    bundleId = DEFAULT_BUNDLE_ID,
    headless = true,
    instanceId,
    promptForNewDevice = true,
    apiLevel,
  }: DeviceOptions = {},
): Promise<string | undefined> {
  return withDeviceLock(async () => {
    if (platform === 'android') {
      const online = getAndroidOnlineSerials();
      let selected = deviceId ? online.find(s => s === deviceId) : undefined;
      if (!selected) {
        for (const s of online) {
          if (!(await isAndroidDeviceActivelyInUse(s, bundleId, instanceId))) {
            selected = s;
            break;
          }
        }
      }

      if (!selected) {
        selected = await bootAndroidEmulator({
          headless,
          bundleId,
          promptForNewDevice,
          excludeSerials: online,
          apiLevel,
        });
      } else {
        log.verbose(`Android device already running (${selected})`);
      }
      // Claim the device + set up ADB reverse while still holding the lock
      // so the next instance's liveness check sees this device as taken.
      claimAndroidDevice(selected!, instanceId ?? 'unknown', metroPort);
      setupAndroidPorts(wsPort, metroPort, selected);
      writeAndroidDebugHost(bundleId, metroPort, selected);
      return selected;
    }
    if (platform === 'ios') {
      return bootIOSSimulator({ deviceId, bundleId, headless, promptForNewDevice, instanceId });
    }
    return undefined;
  });
}

/**
 * Read the VitestMobileCacheKey embedded in the installed app's metadata.
 * Returns null if the app is not installed or the key is absent (e.g. older build).
 */
export function getInstalledCacheKey(platform: Platform, bundleId: string, deviceId?: string): string | null {
  try {
    if (platform === 'ios') {
      const target = deviceId ?? 'booted';
      const containerPath = run(`xcrun simctl get_app_container ${target} ${bundleId}`);
      if (!containerPath) return null;
      const value = run(`plutil -extract VitestMobileCacheKey raw "${resolve(containerPath, 'Info.plist')}"`);
      return value || null;
    }
    if (platform === 'android') {
      const adb = getAdbPath();
      const target = deviceId ? `-s ${deviceId} ` : '';
      const dump = run(`${adb} ${target}shell dumpsys package ${bundleId}`);
      if (!dump) return null;
      const match = dump.match(/vitest-mobile-cache-key.*?value=([^\s]+)/);
      return match?.[1] ?? null;
    }
  } catch {
    // Any failure means we can't confirm the installed version — caller should install.
  }
  return null;
}

export function launchApp(
  platform: Platform,
  bundleId: string,
  { metroPort = 18081, deviceId }: { metroPort?: number; deviceId?: string } = {},
): void {
  if (platform === 'android') launchAndroidApp(bundleId, metroPort, deviceId);
  else if (platform === 'ios') launchIOSApp(bundleId, metroPort, deviceId);
}

export function stopApp(platform: Platform, bundleId: string, deviceId?: string): void {
  if (platform === 'android') stopAndroidApp(bundleId, deviceId);
  else if (platform === 'ios') stopIOSApp(bundleId, deviceId);
}

export function listAutoCreatedDeviceIds(platform: Platform): string[] {
  if (platform === 'ios') {
    return listIOSSimulatorsByPrefix('VitestMobile-');
  }
  return [];
}

export function cleanupAutoCreatedDevices(platform: Platform): string[] {
  if (platform !== 'ios') return [];
  const ids = listAutoCreatedDeviceIds(platform);
  const removed: string[] = [];
  for (const id of ids) {
    const deleted = run(`xcrun simctl delete ${id}`);
    if (deleted !== null) removed.push(id);
  }
  return removed;
}
