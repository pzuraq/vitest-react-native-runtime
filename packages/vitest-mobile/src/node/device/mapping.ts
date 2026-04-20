/**
 * Persistent mapping of `appDir → chosen device` for each platform.
 *
 * On first `vitest-mobile bootstrap` the user picks (or auto-accepts) a
 * device, and that choice is stored here so subsequent runs — including
 * non-interactive `vitest run` invocations — know which device to target
 * without re-prompting.
 *
 * `createdByUs` tracks whether we created the device ourselves (via
 * `xcrun simctl create` / `avdmanager create avd`) so `reset-device` knows
 * whether it's safe to delete on cleanup. If the user picked an existing
 * simulator/AVD (their own, from Xcode/Android Studio), we leave it alone
 * on reset — just clear the mapping.
 *
 * Storage: ~/.cache/vitest-mobile/devices.json. Structure:
 *   { "<appDir>": { ios: {...}, android: {...} } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCacheDir } from '../paths';
import type { Platform } from '../types';

export interface DeviceMapping {
  /** Simulator name (iOS) or AVD name (Android). Stable across reboots. */
  deviceName: string;
  /** Did vitest-mobile create this device? Controls whether reset-device deletes it. */
  createdByUs: boolean;
  /** ISO timestamp of when the mapping was created. Informational. */
  ts: string;
}

type AllMappings = Record<string, Partial<Record<Platform, DeviceMapping>>>;

function mappingFile(): string {
  return resolve(getCacheDir(), 'devices.json');
}

function load(): AllMappings {
  const path = mappingFile();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AllMappings;
  } catch {
    return {};
  }
}

function save(m: AllMappings): void {
  const path = mappingFile();
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2));
}

export function getDeviceMapping(appDir: string, platform: Platform): DeviceMapping | null {
  const all = load();
  return all[resolve(appDir)]?.[platform] ?? null;
}

export function setDeviceMapping(appDir: string, platform: Platform, mapping: Omit<DeviceMapping, 'ts'>): void {
  const all = load();
  const key = resolve(appDir);
  all[key] ??= {};
  all[key]![platform] = { ...mapping, ts: new Date().toISOString() };
  save(all);
}

export function clearDeviceMapping(appDir: string, platform: Platform): void {
  const all = load();
  const key = resolve(appDir);
  if (all[key]?.[platform]) {
    delete all[key]![platform];
    if (Object.keys(all[key]!).length === 0) delete all[key];
    save(all);
  }
}
