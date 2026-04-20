/**
 * Interactive "which device should vitest-mobile use for this project?"
 * picker, used by `bootstrap` and `boot-device`. Lists the host's existing
 * simulators (iOS) / AVDs (Android) plus a "Create new" option that names
 * the device deterministically from the project path (matches the previous
 * `VitestMobile-<hash>` / `vitest-mobile-<hash>` pattern).
 *
 * The result feeds into the device-mapping store; subsequent test runs
 * read that mapping and don't re-prompt.
 *
 * On Android, "Create new" requires cmdline-tools (sdkmanager + avdmanager)
 * under ANDROID_HOME. When those aren't installed we still show the option
 * but annotate it as unavailable and refuse the selection — rather than
 * hiding it — so the user learns what's needed.
 */

import { isCancel, select } from '@clack/prompts';
import { listAllIOSSimulators, primarySimulatorName } from '../node/device/ios';
import { listAllAvds, avdNameForProject, hasAvdProvisioningTools } from '../node/device/android';
import { getDeviceMapping, setDeviceMapping, type DeviceMapping } from '../node/device/mapping';
import type { Platform } from '../node/types';

export interface PickedDevice {
  /** Simulator name (iOS) / AVD name (Android). */
  name: string;
  /** True if the user chose "Create new" — the device doesn't exist yet. */
  createdByUs: boolean;
}

const CREATE_NEW = '__create__';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export async function pickDevice(opts: {
  platform: Platform;
  appDir: string;
  /** Preselect this device in the list — used when a mapping already exists. */
  currentChoice?: string;
}): Promise<PickedDevice> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    fail(
      `Cannot prompt for a device in non-TTY context. Pass --device <name> or run 'vitest-mobile bootstrap' interactively first.`,
    );
  }

  return opts.platform === 'ios'
    ? pickIOS(opts.appDir, opts.currentChoice)
    : pickAndroid(opts.appDir, opts.currentChoice);
}

async function pickIOS(appDir: string, currentChoice?: string): Promise<PickedDevice> {
  const sims = listAllIOSSimulators();
  const projectSim = primarySimulatorName(appDir);

  const options = [
    {
      value: CREATE_NEW,
      label: `Create new dedicated simulator (${projectSim})`,
      hint: 'recommended',
    },
    ...sims
      // Hide auto-created simulators for *other* projects — they'd be
      // confusing to pick.
      .filter(s => !s.name.startsWith('VitestMobile-') || s.name === projectSim)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => ({ value: s.name, label: s.name, hint: s.runtime })),
  ];

  // Preference for the pre-selected option:
  //   1. The currently-mapped device (user's "keep the same" default).
  //   2. The existing project simulator (for pre-mapping migrations).
  //   3. Otherwise prompt to create a new one.
  const projectExists = sims.some(s => s.name === projectSim);
  const initialValue =
    currentChoice && options.some(o => o.value === currentChoice)
      ? currentChoice
      : projectExists
        ? projectSim
        : CREATE_NEW;

  const choice = await select({
    message: 'Which simulator should vitest-mobile use for this project?',
    initialValue,
    options,
  });
  if (isCancel(choice)) fail('Cancelled.');

  if (choice === CREATE_NEW) return { name: projectSim, createdByUs: true };
  // If the user picked the existing per-project sim, treat as createdByUs=true
  // so `reset-device` still cleans it up.
  return { name: choice as string, createdByUs: choice === projectSim };
}

async function pickAndroid(appDir: string, currentChoice?: string): Promise<PickedDevice> {
  const avds = listAllAvds();
  const projectAvd = avdNameForProject(appDir);
  const canCreate = hasAvdProvisioningTools();
  const existing = avds.includes(projectAvd);

  const createHint = canCreate ? 'recommended' : 'requires Android cmdline-tools (sdkmanager + avdmanager)';

  const options = [
    {
      value: CREATE_NEW,
      label: `Create new dedicated AVD (${projectAvd})`,
      hint: createHint,
    },
    ...avds
      .filter(a => (!a.startsWith('vitest-mobile-') && a !== 'vitest-mobile') || a === projectAvd)
      .sort()
      .map(a => ({ value: a, label: a })),
  ];

  // Preference for the pre-selected option:
  //   1. Currently-mapped device (user's "keep the same" default).
  //   2. Existing project AVD.
  //   3. "Create new" when we can actually create one.
  //   4. First existing AVD otherwise.
  const initialValue =
    currentChoice && options.some(o => o.value === currentChoice)
      ? currentChoice
      : existing
        ? projectAvd
        : canCreate
          ? CREATE_NEW
          : (avds[0] ?? CREATE_NEW);

  const choice = await select({
    message: 'Which AVD should vitest-mobile use for this project?',
    initialValue,
    options,
  });
  if (isCancel(choice)) fail('Cancelled.');

  if (choice === CREATE_NEW) {
    if (!canCreate) {
      fail(
        `Creating a new AVD needs the Android cmdline-tools (sdkmanager + avdmanager), which aren't installed under ANDROID_HOME.\n\n` +
          `Install via Android Studio → SDK Manager → SDK Tools → "Android SDK Command-line Tools (latest)",\n` +
          `or 'brew install --cask android-commandlinetools'. Then re-run bootstrap.\n\n` +
          `Alternatively, pick an existing AVD from the list.`,
      );
    }
    return { name: projectAvd, createdByUs: true };
  }
  return { name: choice as string, createdByUs: choice === projectAvd };
}

/** Verify a --device name exists (for non-interactive runs). */
export function validateDeviceChoice(platform: Platform, name: string): void {
  if (platform === 'ios') {
    const sims = listAllIOSSimulators();
    if (!sims.some(s => s.name === name)) {
      fail(`Simulator '${name}' not found. Run 'xcrun simctl list devices' to see available simulators.`);
    }
  } else {
    const avds = listAllAvds();
    if (!avds.includes(name)) {
      fail(`AVD '${name}' not found. Run 'emulator -list-avds' to see available AVDs.`);
    }
  }
}

/**
 * Resolve (and persist) the device mapping for a project.
 *
 * Precedence:
 *   1. `--device <name>` flag → validate, record, return.
 *   2. TTY + `alwaysPrompt` → pick (defaults to the current mapping). Used
 *      by `bootstrap` so the user can always reselect without having to
 *      reset-device first.
 *   3. Existing mapping (no alwaysPrompt) → reuse silently. Used by
 *      `boot-device` and test runs.
 *   4. TTY (no mapping) → pick.
 *   5. Non-TTY (CI, no mapping) → default to the project-scoped name with
 *      createdByUs = true. On Android we also require cmdline-tools or
 *      error with a pointer to either install them or pass `--device`.
 */
export async function ensureDeviceMapping(opts: {
  platform: Platform;
  appDir: string;
  deviceFlag?: string;
  alwaysPrompt?: boolean;
}): Promise<DeviceMapping> {
  const existing = getDeviceMapping(opts.appDir, opts.platform);

  if (opts.deviceFlag) {
    validateDeviceChoice(opts.platform, opts.deviceFlag);
    const projectName = opts.platform === 'ios' ? primarySimulatorName(opts.appDir) : avdNameForProject(opts.appDir);
    setDeviceMapping(opts.appDir, opts.platform, {
      deviceName: opts.deviceFlag,
      createdByUs: opts.deviceFlag === projectName,
    });
    return getDeviceMapping(opts.appDir, opts.platform)!;
  }

  const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);

  if (existing && !opts.alwaysPrompt) return existing;

  if (isInteractive) {
    const picked = await pickDevice({
      platform: opts.platform,
      appDir: opts.appDir,
      currentChoice: existing?.deviceName,
    });
    setDeviceMapping(opts.appDir, opts.platform, {
      deviceName: picked.name,
      createdByUs: picked.createdByUs,
    });
    return getDeviceMapping(opts.appDir, opts.platform)!;
  }

  // Non-TTY fallback: auto-pick the project-scoped device.
  const projectName = opts.platform === 'ios' ? primarySimulatorName(opts.appDir) : avdNameForProject(opts.appDir);
  if (opts.platform === 'android' && !hasAvdProvisioningTools()) {
    fail(
      `Non-interactive bootstrap on Android needs cmdline-tools to provision an AVD.\n` +
        `Either install them (Android Studio → SDK Manager → "Android SDK Command-line Tools (latest)",\n` +
        `or 'brew install --cask android-commandlinetools'), or pass --device <existing-avd-name>.`,
    );
  }
  setDeviceMapping(opts.appDir, opts.platform, { deviceName: projectName, createdByUs: true });
  return getDeviceMapping(opts.appDir, opts.platform)!;
}
