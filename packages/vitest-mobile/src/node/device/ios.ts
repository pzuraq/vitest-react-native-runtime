/**
 * iOS device driver — simulator lifecycle, app management, snapshots.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../logger';
import { run } from '../exec-utils';
import { getCacheDir } from '../paths';
import type { DeviceOptions } from '../types';
import type { DeviceDriver } from './index';
import { DEFAULT_BUNDLE_ID, isPortListening, errorMessage } from './shared';
import { getDeviceMapping, setDeviceMapping } from './mapping';

// ── Project-scoped naming ────────────────────────────────────────

const SIM_NAME_PREFIX = 'VitestMobile-';

/**
 * Derive a stable short hash from the project directory. Used as the
 * simulator name suffix so each project owns its own dedicated simulator,
 * reusable across runs but isolated from other projects and from the user's
 * own simulators.
 */
function projectHash(appDir: string): string {
  return createHash('sha256').update(resolve(appDir)).digest('hex').slice(0, 8);
}

export function primarySimulatorName(appDir: string): string {
  return `${SIM_NAME_PREFIX}${projectHash(appDir)}`;
}

/**
 * Every non-retired simulator on the host, for the device picker. Filters
 * out devices whose runtime isn't available (older iOS versions that got
 * uninstalled) — a simulator pointing at a missing runtime can't be booted.
 */
export function listAllIOSSimulators(): SimulatorInfo[] {
  const json = run('xcrun simctl list devices -j');
  if (!json) return [];
  const devices = parseSimctlDevicesJson(json);
  if (!devices) return [];
  const sims: SimulatorInfo[] = [];
  for (const [runtime, deviceList] of Object.entries(devices.devices)) {
    const runtimeLabel = runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, '.');
    for (const device of deviceList) {
      if (!device.udid || !device.name) continue;
      if (device.isAvailable === false) continue;
      sims.push({ udid: device.udid, name: device.name, runtime: runtimeLabel });
    }
  }
  return sims;
}

function secondarySimulatorName(baseName: string, instanceId: string): string {
  const suffix = instanceId.slice(-6);
  return `${baseName}-${suffix}`;
}

// ── Types ────────────────────────────────────────────────────────

interface SimctlDeviceEntry {
  state?: string;
  isAvailable?: boolean;
  udid?: string;
  name?: string;
}

export interface SimulatorInfo {
  udid: string;
  name: string;
  runtime: string;
}

interface SimctlDevicesJson {
  devices: Record<string, SimctlDeviceEntry[]>;
}

interface SimctlDeviceTypeEntry {
  name?: string;
  identifier?: string;
  /**
   * Packed as `(major << 16) | (minor << 8) | patch`. Verified against
   * modern Xcode — iPhone 16 Pro = 1179648 = (18 << 16) = iOS 18.0.
   */
  minRuntimeVersion?: number;
  maxRuntimeVersion?: number;
}

interface SimctlRuntimeEntry {
  identifier?: string;
  isAvailable?: boolean;
  version?: string;
}

// ── Simctl helpers ───────────────────────────────────────────────

function parseSimctlDevicesJson(json: string): SimctlDevicesJson | null {
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data !== 'object' || data === null || !('devices' in data)) return null;
    const { devices } = data as { devices: unknown };
    if (typeof devices !== 'object' || devices === null) return null;
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

// ── Liveness detection ───────────────────────────────────────────

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

async function isSimulatorActivelyInUse(udid: string, bundleId: string): Promise<boolean> {
  const port = getSimulatorMetroPort(udid, bundleId);
  if (!port) return false;
  return isPortListening(port);
}

// ── Simulator listing / selection ────────────────────────────────

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

function getBootedSimulatorInfo(): SimulatorInfo | null {
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

/**
 * Parse an iOS runtime's `version` string into simctl's internal version int,
 * which packs it as `(major << 16) | (minor << 8) | patch`. e.g. "18.5" →
 * 1180928. The device type entries' `minRuntimeVersion` / `maxRuntimeVersion`
 * use the same encoding (iPhone 16 Pro = 1179648 = iOS 18.0), so we can
 * compare directly to decide compatibility.
 */
function parseRuntimeVersion(version: string): number {
  const [major = '0', minor = '0', patch = '0'] = version.split('.');
  return ((Number(major) & 0xff) << 16) | ((Number(minor) & 0xff) << 8) | (Number(patch) & 0xff);
}

/**
 * Newest available iOS runtime identifier, or null. Used by
 * `diagnoseSimulatorCreationFailure` and the snapshot metadata check.
 * (Creation itself uses `chooseIOSDevicePair` which matches a compatible
 * device/runtime pair.)
 */
function chooseIOSRuntimeIdentifier(): string | null {
  const json = run('xcrun simctl list runtimes -j');
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { runtimes?: SimctlRuntimeEntry[] };
    const list = (parsed.runtimes ?? [])
      .filter(r => r.isAvailable && r.identifier?.includes('iOS') && r.version)
      .map(r => ({ identifier: r.identifier!, versionInt: parseRuntimeVersion(r.version!) }))
      .sort((a, b) => b.versionInt - a.versionInt);
    return list[0]?.identifier ?? null;
  } catch {
    return null;
  }
}

/**
 * Pick a compatible iPhone + iOS runtime pair from what simctl reports.
 *
 * Just picking "first iPhone" + "first iOS runtime" breaks in CI: Xcode's
 * devicetype list includes future models (e.g. iPhone 17 Pro) whose
 * required runtime (iOS 19+) isn't installed on the runner, and simctl
 * create rejects the pair with SimError 403 "Incompatible device".
 *
 * Each device entry exposes `minRuntimeVersion` / `maxRuntimeVersion`
 * (encoded as `major * 1000 + minor`), and each runtime exposes `version`.
 * We match them so the chosen pair actually works.
 */
function chooseIOSDevicePair(): { deviceType: string; runtime: string } | null {
  const dtJson = run('xcrun simctl list devicetypes -j');
  const rtJson = run('xcrun simctl list runtimes -j');
  if (!dtJson || !rtJson) return null;

  let devicetypes: SimctlDeviceTypeEntry[];
  let runtimes: SimctlRuntimeEntry[];
  try {
    devicetypes = (JSON.parse(dtJson) as { devicetypes?: SimctlDeviceTypeEntry[] }).devicetypes ?? [];
    runtimes = (JSON.parse(rtJson) as { runtimes?: SimctlRuntimeEntry[] }).runtimes ?? [];
  } catch {
    return null;
  }

  // Newest available iOS runtime first.
  const availableRuntimes = runtimes
    .filter(r => r.isAvailable && r.identifier?.includes('iOS') && r.version)
    .map(r => ({ identifier: r.identifier!, versionInt: parseRuntimeVersion(r.version!) }))
    .sort((a, b) => b.versionInt - a.versionInt);
  if (availableRuntimes.length === 0) return null;

  const iphones = devicetypes.filter(d => d.identifier?.includes('iPhone'));
  if (iphones.length === 0) return null;

  // For each runtime (newest first), pick the newest compatible iPhone.
  // "Newest" = highest minRuntimeVersion that still fits under the runtime.
  for (const rt of availableRuntimes) {
    const compatible = iphones.filter(d => {
      const min = d.minRuntimeVersion ?? 0;
      const max = d.maxRuntimeVersion ?? Number.MAX_SAFE_INTEGER;
      return min <= rt.versionInt && rt.versionInt <= max;
    });
    if (compatible.length === 0) continue;
    compatible.sort((a, b) => (b.minRuntimeVersion ?? 0) - (a.minRuntimeVersion ?? 0));
    return { deviceType: compatible[0]!.identifier!, runtime: rt.identifier };
  }
  return null;
}

function diagnoseSimulatorCreationFailure(): string {
  try {
    execSync('xcrun simctl help', { stdio: 'pipe', encoding: 'utf8', timeout: 10_000 });
  } catch (e: unknown) {
    const stderr = (e as { stderr?: Buffer | string }).stderr?.toString() ?? '';
    if (/license/i.test(stderr)) {
      return 'Xcode license has not been accepted. Run: sudo xcodebuild -license accept';
    }
    if (/xcrun: error/i.test(stderr)) {
      return `xcrun is not functional. Check your Xcode installation.\n  stderr: ${stderr.trim()}`;
    }
  }

  try {
    const selected = execSync('xcode-select -p', { stdio: 'pipe', encoding: 'utf8', timeout: 5_000 }).trim();
    if (selected.includes('CommandLineTools')) {
      return `xcode-select is pointing at Command Line Tools (${selected}), which does not include simulator runtimes.\n  Run: sudo xcode-select --switch /Applications/Xcode.app`;
    }
  } catch {
    /* ignore */
  }

  if (!chooseIOSRuntimeIdentifier()) {
    return 'No iOS simulator runtimes are installed or available.\n  Open Xcode → Settings → Platforms and install an iOS runtime.';
  }

  return 'Unable to find a compatible iOS device type/runtime for simulator creation.';
}

// ── Simulator creation ───────────────────────────────────────────

function createIOSSimulatorWithName(name: string): string {
  const pair = chooseIOSDevicePair();
  if (!pair) {
    throw new Error(diagnoseSimulatorCreationFailure());
  }

  log.info(`Creating iOS simulator: ${name} (${pair.deviceType}, ${pair.runtime})`);
  // If simctl create fails, `run()` swallows the exit code and returns null.
  // The full stderr still lands in the log sink (see exec-utils) so the log
  // file points to the real cause; this throw echoes the device/runtime pair
  // so users see it in the spinner too.
  const created = run(`xcrun simctl create "${name}" "${pair.deviceType}" "${pair.runtime}"`);
  if (!created) {
    throw new Error(
      `Failed to create iOS simulator '${name}' (${pair.deviceType}, ${pair.runtime}). See the log file for simctl's stderr.`,
    );
  }
  return created.trim();
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

function findSimulatorByName(name: string): SimulatorInfo | null {
  const json = run('xcrun simctl list devices -j');
  if (!json) return null;
  const devices = parseSimctlDevicesJson(json);
  if (!devices) return null;
  for (const [runtime, deviceList] of Object.entries(devices.devices)) {
    for (const device of deviceList) {
      if (device.name === name && device.udid) {
        return {
          udid: device.udid,
          name: device.name,
          runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, '.'),
        };
      }
    }
  }
  return null;
}

function isSimulatorBooted(udid: string): boolean {
  return getBootedSimulators().some(s => s.udid === udid);
}

async function waitForBoot(udid: string, timeoutIterations = 30): Promise<boolean> {
  for (let i = 0; i < timeoutIterations; i++) {
    if (isSimulatorBooted(udid)) return true;
    await new Promise<void>(r => setTimeout(r, 2000));
  }
  return false;
}

// ── Boot ─────────────────────────────────────────────────────────

async function bootIOSSimulator(opts: {
  deviceId?: string;
  bundleId?: string;
  headless?: boolean;
  instanceId?: string;
  /** The mapped simulator name — authoritative, from the device-mapping file. */
  targetName: string;
  /** If the target sim doesn't exist, create it (only set for createdByUs mappings). */
  createIfMissing: boolean;
}): Promise<string> {
  if (opts.deviceId) return opts.deviceId;
  const bid = opts.bundleId ?? DEFAULT_BUNDLE_ID;

  const primaryName = opts.targetName;
  const primary = findSimulatorByName(primaryName);

  let targetUdid: string | undefined;
  let targetLabel = primaryName;

  if (primary) {
    const booted = isSimulatorBooted(primary.udid);
    const inUse = booted && (await isSimulatorActivelyInUse(primary.udid, bid));

    if (inUse) {
      // Another vitest process on this project already owns the primary;
      // spin up an ephemeral per-instance secondary so we don't collide.
      // Secondaries always count as ours (we named + created them) — they
      // get cleaned up by clean-devices alongside the primary.
      const instanceId = opts.instanceId ?? Date.now().toString(36);
      const secondaryName = secondarySimulatorName(primaryName, instanceId);
      log.verbose(`Primary simulator ${primaryName} is in use — creating secondary ${secondaryName}`);
      const existingSecondary = findSimulatorByName(secondaryName);
      targetUdid = existingSecondary?.udid ?? createIOSSimulatorWithName(secondaryName);
      targetLabel = secondaryName;
    } else {
      targetUdid = primary.udid;
      if (booted) {
        log.verbose(`Reusing project simulator ${primaryName} (${primary.udid})`);
        if (!opts.headless) openSimulatorApp();
        return primary.udid;
      }
    }
  } else {
    if (!opts.createIfMissing) {
      throw new Error(
        `Simulator '${primaryName}' was selected for this project but no longer exists.\n` +
          `Re-run 'vitest-mobile bootstrap' to pick a different one.`,
      );
    }
    log.info(`Provisioning dedicated vitest-mobile simulator for this project: ${primaryName}`);
    targetUdid = createIOSSimulatorWithName(primaryName);
  }

  log.info(`Booting iOS simulator ${targetLabel} (${targetUdid})...`);
  run(`xcrun simctl boot ${targetUdid}`);

  if (await waitForBoot(targetUdid)) {
    log.info('Simulator is ready');
    if (!opts.headless) openSimulatorApp();
    return targetUdid;
  }
  throw new Error('iOS simulator did not boot in time');
}

function openSimulatorApp(): void {
  try {
    execSync('open -a Simulator', { stdio: 'pipe' });
  } catch {
    /* non-fatal */
  }
}

// ── App lifecycle ────────────────────────────────────────────────

function launchIOSApp(bundleId: string, metroPort: number, deviceId?: string): void {
  const simId = deviceId || getBootedSimulator();
  if (!simId) {
    throw new Error('No booted iOS simulator — cannot launch app');
  }
  log.verbose(`Launching ${bundleId} on ${simId}...`);
  run(`xcrun simctl terminate ${simId} ${bundleId}`);
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

function getIOSInstalledCacheKey(bundleId: string, deviceId?: string): string | null {
  try {
    const target = deviceId ?? 'booted';
    const containerPath = run(`xcrun simctl get_app_container ${target} ${bundleId}`);
    if (!containerPath) return null;
    const value = run(`plutil -extract VitestMobileCacheKey raw "${resolve(containerPath, 'Info.plist')}"`);
    return value || null;
  } catch {
    return null;
  }
}

// ── Device Snapshots ─────────────────────────────────────────────

function simulatorDeviceDir(udid: string): string {
  return join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid);
}

function deviceSnapshotDir(cacheKey: string): string {
  return resolve(getCacheDir(), 'device-snapshots', cacheKey);
}

export async function saveDeviceSnapshot(cacheKey: string, deviceId?: string): Promise<string | null> {
  const udid = deviceId ?? getBootedSimulator();
  if (!udid) {
    log.warn('No booted iOS simulator — skipping snapshot save');
    return null;
  }

  const snapDir = deviceSnapshotDir(cacheKey);
  mkdirSync(snapDir, { recursive: true });

  log.info(`Saving device snapshot (${cacheKey.slice(0, 12)}...)...`);

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

  execSync(`tar cf "${snapshotFile}" -C "${dataDir}" .`, { stdio: 'pipe', timeout: 120_000 });

  const runtimeInfo = chooseIOSRuntimeIdentifier();
  writeFileSync(
    join(snapDir, 'metadata.json'),
    JSON.stringify({ udid, runtime: runtimeInfo, savedAt: new Date().toISOString() }),
  );

  if (wasBooted) {
    run(`xcrun simctl boot ${udid}`);
    for (let i = 0; i < 30; i++) {
      if (getBootedSimulators().some(s => s.udid === udid)) break;
      await new Promise<void>(r => setTimeout(r, 2000));
    }
  }

  cleanStaleSnapshots(cacheKey);
  log.info('Device snapshot saved');
  return snapshotFile;
}

export async function restoreDeviceSnapshot(
  cacheKey: string,
  opts: { headless?: boolean; appDir?: string } = {},
): Promise<string | null> {
  const snapDir = deviceSnapshotDir(cacheKey);
  const snapshotFile = join(snapDir, 'snapshot.tar');
  const metadataFile = join(snapDir, 'metadata.json');

  if (!existsSync(snapshotFile) || !existsSync(metadataFile)) {
    log.verbose('No device snapshot for this cache key');
    return null;
  }

  log.info(`Restoring device from snapshot (${cacheKey.slice(0, 12)}...)...`);

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

  const appDir = opts.appDir ?? process.cwd();
  const primaryName = primarySimulatorName(appDir);
  const existing = findSimulatorByName(primaryName);

  let udid: string;
  let createdNewSim = false;

  if (existing) {
    udid = existing.udid;
    log.verbose(`Reusing project simulator ${primaryName} (${udid}) for snapshot restore`);
    if (isSimulatorBooted(udid)) {
      run(`xcrun simctl shutdown ${udid}`);
      for (let i = 0; i < 15; i++) {
        if (!isSimulatorBooted(udid)) break;
        await new Promise<void>(r => setTimeout(r, 1000));
      }
    }
  } else {
    try {
      udid = createIOSSimulatorWithName(primaryName);
    } catch (e: unknown) {
      log.warn(`Failed to create simulator for snapshot restore: ${errorMessage(e)}`);
      return null;
    }
    createdNewSim = true;
  }

  const dataDir = join(simulatorDeviceDir(udid), 'data');
  try {
    execSync(`tar xf "${snapshotFile}" -C "${dataDir}"`, { stdio: 'pipe', timeout: 120_000 });
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

// ── Auto-created device management ───────────────────────────────

export function listAutoCreatedDeviceIds(): string[] {
  return listIOSSimulatorsByPrefix('VitestMobile-');
}

export function cleanupAutoCreatedDevices(): string[] {
  return deleteSimulatorsByIds(listAutoCreatedDeviceIds());
}

/**
 * List simulators belonging to a specific project — the primary
 * (VitestMobile-{hash}) plus any secondaries (VitestMobile-{hash}-{suffix}).
 */
export function listProjectDeviceIds(appDir: string): string[] {
  return listIOSSimulatorsByPrefix(`${primarySimulatorName(appDir)}`);
}

/** Shutdown (if booted) and delete the project's simulator(s). */
export function cleanupProjectDevices(appDir: string): string[] {
  return deleteSimulatorsByIds(listProjectDeviceIds(appDir));
}

function deleteSimulatorsByIds(ids: string[]): string[] {
  const removed: string[] = [];
  for (const id of ids) {
    if (isSimulatorBooted(id)) {
      run(`xcrun simctl shutdown ${id}`);
    }
    const deleted = run(`xcrun simctl delete ${id}`);
    if (deleted !== null) removed.push(id);
  }
  return removed;
}

// ── DeviceDriver implementation ──────────────────────────────────

export const iosDriver: DeviceDriver = {
  async ensureDevice(opts: DeviceOptions): Promise<string | undefined> {
    const appDir = opts.appDir ?? process.cwd();
    let mapping = getDeviceMapping(appDir, 'ios');
    if (!mapping) {
      // Migration: if a pre-mapping VitestMobile-<hash> sim already exists for
      // this project, adopt it silently so existing users don't see a sudden
      // "run bootstrap first" error after upgrade.
      const projectName = primarySimulatorName(appDir);
      if (findSimulatorByName(projectName)) {
        setDeviceMapping(appDir, 'ios', { deviceName: projectName, createdByUs: true });
        mapping = getDeviceMapping(appDir, 'ios');
        log.verbose(`Auto-registered existing project simulator '${projectName}'`);
      }
    }
    if (!mapping) {
      throw new Error(`No iOS device configured for this project. Run 'vitest-mobile bootstrap --platform ios' first.`);
    }
    return bootIOSSimulator({
      deviceId: opts.deviceId,
      bundleId: opts.bundleId,
      headless: opts.headless,
      instanceId: opts.instanceId,
      targetName: mapping.deviceName,
      createIfMissing: mapping.createdByUs,
    });
  },

  launchApp(bundleId: string, opts: { metroPort?: number; deviceId?: string } = {}): void {
    launchIOSApp(bundleId, opts.metroPort ?? 18081, opts.deviceId);
  },

  stopApp(bundleId: string, deviceId?: string): void {
    stopIOSApp(bundleId, deviceId);
  },

  getInstalledCacheKey(bundleId: string, deviceId?: string): string | null {
    return getIOSInstalledCacheKey(bundleId, deviceId);
  },

  isDeviceOnline(): boolean {
    return getBootedSimulator() !== null;
  },

  getBootedDeviceId(): string | null {
    return getBootedSimulator();
  },
};
